// Gottlieb System 80 video board (1982-84): Q*bert. An Intel 8088 at 5 MHz
// (run here on the V30 core, which executes the same instructions), a 32x30
// map of 8x8 tiles at 4 bits per pixel (from ROM or, in later games, RAM),
// 63 sprites of 16x16, and a 16-color palette in RAM (4 bits per gun). An
// NMI every frame.
//
// Sound (revision 1 board): a 6502 with a 6532 RIOT (128 bytes of RAM and the
// command latch), an 8-bit DAC and a Votrax SC-01. The main CPU's sound
// command interrupts the 6502; the Votrax interrupts it (NMI) each time it is
// ready for the next phoneme, which is how Q*bert curses.
//
// The monitor is mounted vertically: 240x256 shown.

import { V30 } from './v30.js';
import { CPU6502 as M6502 } from './m6502.js';
import { Votrax } from './votrax.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, rotate270, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const NW = 256, NH = 240;                         // the unrotated picture
const REFRESH = 61, CPU_CLOCK = 5000000, SOUND_CLOCK = 3579545 / 4, LINES = 256;

class DAC {
  constructor() { this.reset(); }
  reset() { this.out = 0; this.level = 0; }
  sample() { this.out = this.level; }
  saveState() { return { level: this.level }; }
  loadState(s) { this.level = s.level; }
}

const STATE = ['ram', 'spriteRam', 'vram', 'charRam', 'palRam', 'riotRam', 'riotRegs', 'latch', 'videoOut', 'speechReady',
  'cycleCarry', 'zCarry', 'sampleCarry', 'in1', 'joy', 'cpu', 'snd', 'sound'];

export class Gottlieb {
  saveState() { return capture(this, STATE); }
  loadState(s) {
    apply(this, STATE, s);
    for (let i = 0; i < 32; i += 2) this.setColor(i);
    if (this.tilesInRam) this.charRam.forEach((v, o) => { const d = (o >> 5) * 64 + ((o >> 2) & 7) * 8 + (o & 3) * 2; this.tilePix[d] = v >> 4; this.tilePix[d + 1] = v & 15; });
  }

  // roms: { main (64K space), sound (64K space), tiles, sprites }
  constructor(roms) {
    this.width = NH;
    this.height = NW;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 0;
    this.roms = roms;
    this.ram = new Uint8Array(0x3000);          // 0000-2FFF (the first 4K battery-backed)
    this.nvram = this.ram.subarray(0, 0x1000);
    this.spriteRam = new Uint8Array(0x800);
    this.vram = new Uint8Array(0x400);
    this.charRam = new Uint8Array(0x1000);
    this.palRam = new Uint8Array(32);
    this.riotRam = new Uint8Array(0x80);
    this.riotRegs = new Uint8Array(32);
    this.palette = new Uint32Array(16).fill(0xFF000000);
    this.native = new Uint32Array(NW * NH);
    this.frame = new Uint32Array(NW * NH);

    // Tiles from ROM, or (Krull) drawn by the program into the character RAM.
    this.tilesInRam = !roms.tiles;
    this.tilePix = this.tilesInRam ? new Uint8Array(128 * 64)
      : decodeTiles(roms.tiles, { count: roms.tiles.length / 32, width: 8, height: 8, planes: [0, 1, 2, 3], xs: run(0, 8, 4), ys: run(0, 8, 32), size: 256 });
    const q = roms.sprites.length / 4 * 8;
    this.spritePix = decodeTiles(roms.sprites, { count: roms.sprites.length / 128, width: 16, height: 16, planes: [0, q, 2 * q, 3 * q], xs: run(0, 16), ys: run(0, 16, 16), size: 256 });

    this.cpu = new V30({ read8: (a) => this.read(a & 0xFFFF), write8: (a, v) => this.write(a & 0xFFFF, v) });
    this.snd = new M6502({ read: (a) => this.sRead(a), write: (a, v) => this.sWrite(a, v) });
    this.dac = new DAC();
    this.votrax = new Votrax(0.7);
    this.sound = new SoundMix([this.dac, this.votrax], 1);
    this.in1 = 0x40; this.joy = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    // The first 4K is battery-backed (settings and high scores, kept as `nvram`):
    // filled with 1s at first power-on, kept across resets after that.
    this.ram.fill(0, 0x1000);
    if (!this.powered) { this.ram.fill(0xFF, 0, 0x1000); this.powered = true; }
    if (this.roms.ramRom) this.ram.set(this.roms.ramRom, 0x1000);   // (Krull keeps ROMs where others have RAM)
    this.spriteRam.fill(0); this.vram.fill(0); this.charRam.fill(0); this.palRam.fill(0);
    this.riotRam.fill(0); this.riotRegs.fill(0);
    this.latch = 0; this.videoOut = 0; this.speechReady = 1;
    this.cycleCarry = this.zCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x3000) return this.ram[a];
    if (a < 0x3800) return this.spriteRam[a - 0x3000];
    if (a < 0x4000) return this.vram[a & 0x3FF];
    if (a < 0x5000) return this.charRam[a - 0x4000];
    if (a >= 0x6000) return this.roms.main[a];
    switch (a) {
      case 0x5800: return this.dsw;
      case 0x5801: return this.in1;
      case 0x5802: case 0x5803: return 0;        // trackball (unused)
      case 0x5804: return this.joy;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a < 0x3000) { this.ram[a] = v; return; }
    if (a < 0x3800) { this.spriteRam[a - 0x3000] = v; return; }
    if (a < 0x4000) { this.vram[a & 0x3FF] = v; return; }
    if (a < 0x5000) {
      this.charRam[a - 0x4000] = v;
      if (this.tilesInRam) {                       // keep the decoded tile pixels current (two pixels a byte)
        const o = a - 0x4000, t = o >> 5, y = (o >> 2) & 7, x = (o & 3) * 2, d = t * 64 + y * 8 + x;
        this.tilePix[d] = v >> 4; this.tilePix[d + 1] = v & 15;
      }
      return;
    }
    if (a >= 0x5000 && a < 0x5020) { this.palRam[a - 0x5000] = v; this.setColor(a - 0x5000); return; }
    switch (a) {
      case 0x5802: {                               // sound command (the low four bits all 1 means none)
        v &= 0x3F;
        if ((v & 0x0F) !== 0x0F) { this.latch = v; this.snd.irq = true; }
        return;
      }
      case 0x5803: this.videoOut = v; return;      // bit 0: background over the sprites
    }
  }

  // Palette RAM: pairs of bytes, green/blue then red, 4 bits each through a resistor ladder.
  setColor(o) {
    const i = o & ~1, lo = this.palRam[i], hi = this.palRam[i + 1];
    const lvl = (v) => 0x10 * (v & 1) + 0x21 * ((v >> 1) & 1) + 0x46 * ((v >> 2) & 1) + 0x88 * ((v >> 3) & 1);
    this.palette[i >> 1] = rgba(lvl(hi & 15), lvl(lo >> 4), lvl(lo & 15));
  }

  // ---------------------------------------------------------------- sound CPU

  // The RIOT's RAM is only partly decoded: 128 bytes appear in pages 0 and 1 (and again with A15 set).
  sRead(a) {
    a &= 0x7FFF;
    if (a < 0x200) return this.riotRam[a & 0x7F];
    if (a < 0x400) {
      switch (a & 0x1F) {
        case 0: return this.latch ^ 0xFF;          // port A: the command, inverted
        case 2: return 0x40;                       // port B: test switch up
        case 5: return 0x40;                       // interrupt flags: edge seen on PA7
      }
      return this.riotRegs[a & 0x1F];
    }
    if (a >= 0x6000) return this.roms.sound[a | 0x8000];
    return 0xFF;
  }

  sWrite(a, v) {
    a &= 0x7FFF;
    if (a < 0x200) { this.riotRam[a & 0x7F] = v; return; }
    if (a < 0x400) { this.riotRegs[a & 0x1F] = v; return; }
    if (a === 0x1000) { this.dac.level = ((v - 0x80) / 128) * 0.5; return; }
    if (a === 0x2000) {                            // the Votrax: phoneme and inflection, inverted
      this.votrax.write(~v & 0xFF);
      this.speechReady = 0;
    }
  }

  // ---------------------------------------------------------------- inputs

  // Q*bert's stick is mounted diagonally: up moves up-right on the screen,
  // left up-left, down down-left, right down-right. A diagonal push on the
  // touch pad (in screen terms) becomes that one direction.
  setInputs(s) {
    let r = s.right, l = s.left, u = s.up, d = s.down;
    if (this.constructor.diagonal) {
      if (u && r) r = false;
      else if (u && l) u = false;
      else if (d && l) l = false;
      else if (d && r) d = false;
    }
    this.joy = (r ? 1 : 0) | (l ? 2 : 0) | (u ? 4 : 0) | (d ? 8 : 0);
    this.in1 = 0x40 | (s.start1 ? 1 : 0) | (s.start2 ? 2 : 0) | (s.coin ? 4 : 0);
  }
  applySwitches(v) { this.dsw = (v.demo ?? 0) | 0x02; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const cyc = CPU_CLOCK / REFRESH / LINES, sc = SOUND_CLOCK / REFRESH / LINES, samples = 48000 / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === 240) this.cpu.nmi();            // one NMI a frame, at vertical blank
      this.cycleCarry += cyc;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.zCarry += sc;
      this.zCarry -= this.snd.run(Math.floor(this.zCarry));
      this.snd.irq = false;                        // the command interrupt is held until taken
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) {
        this.sampleCarry -= 1;
        this.sound.sample();
        // The Votrax's request line interrupts the sound CPU when a phoneme is done.
        if (!this.speechReady && this.votrax.ready()) { this.speechReady = 1; this.snd.nmi(); }
      }
    }
    this.render();
  }

  render() {
    const out = this.native, pal = this.palette;
    const bgOver = this.videoOut & 1;
    const drawTiles = (transparent) => {
      for (let ty = 0; ty < 30; ty++) {
        for (let tx = 0; tx < 32; tx++) {
          const code = this.vram[ty * 32 + tx], src = (this.tilesInRam ? code & 0x7F : code) * 64;
          for (let y = 0; y < 8; y++) {
            const o = (ty * 8 + y) * NW + tx * 8;
            for (let x = 0; x < 8; x++) {
              const p = this.tilePix[src + y * 8 + x];
              if (transparent && !p) continue;
              out[o + x] = pal[p];
            }
          }
        }
      }
    };
    if (!bgOver) drawTiles(false); else out.fill(pal[0]);
    // Sprites (the last two entries aren't used).
    const sr = this.spriteRam, count = this.spritePix.length / 256;
    for (let offs = 0; offs < 0x100 - 8; offs += 4) {
      if (!sr[offs] && !sr[offs + 1]) continue;
      const sx = sr[offs + 1] - 4, sy = sr[offs] - 13;
      const code = ((255 ^ sr[offs + 2]) + (this.constructor.spriteBank ? ((this.videoOut >> 4) & 1) * 256 : 0)) % count;
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= NH) continue;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= NW) continue;
          const p = this.spritePix[code * 256 + y * 16 + x];
          if (p) out[py * NW + px] = pal[p];
        }
      }
    }
    if (bgOver) drawTiles(true);
    // Video output bits 1 and 2 flip the picture (cocktail tables; some games set them upright too).
    const fx = this.videoOut & 2, fy = this.videoOut & 4;
    if (fx || fy) {
      const t = this.flipBuf || (this.flipBuf = new Uint32Array(NW * NH));
      t.set(out);
      for (let y = 0; y < NH; y++) for (let x = 0; x < NW; x++) out[y * NW + x] = t[(fy ? NH - 1 - y : y) * NW + (fx ? NW - 1 - x : x)];
    }
    rotate270(out, NW, NH, this.frame);
  }
}

export class Qbert extends Gottlieb {}
Qbert.id = 'qbert'; Qbert.title = 'Q*bert';
Qbert.diagonal = true;
Qbert.switches = [{ id: 'demo', label: 'Demo sounds', options: [['On', 0x00], ['Off', 0x01]], default: 0x00 }];

// Mad Planets (1983): an 8-way stick to fly, a dial to turn the gun, fire
// and a second button (the dial is the fire side here: hold and push sideways).
export class MadPlanets extends Gottlieb {
  constructor(roms) { super(roms); this.controls = 'eight-way'; this.buttons = 1; this.dialControl = true; this.dial = 0; }
  saveState() { return { ...super.saveState(), dial: this.dial }; }
  loadState(s) { super.loadState(s); this.dial = s.dial ?? 0; }
  read(a) { return a === 0x5803 ? (this.dial - (this.dialBase || 0)) & 0xFF : super.read(a); }
  write(a, v) { if (a === 0x5801) this.dialBase = this.dial; super.write(a, v); }   // trackball/dial reset
  setInputs(s) {
    this.dial = (this.dial + (s.spin || 0)) & 0xFF;
    this.joy = (s.up ? 1 : 0) | (s.right ? 2 : 0) | (s.down ? 4 : 0) | (s.left ? 8 : 0) | (s.fire ? 0x10 : 0) | (s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0) | (s.fire2 ? 0x80 : 0);
    this.in1 = 0x80 | (s.coin ? 1 : 0);
  }
  applySwitches() { this.dsw = 0x00; }
}
MadPlanets.id = 'mplanets'; MadPlanets.title = 'Mad Planets';
MadPlanets.switches = [];

// Krull (1983): twin sticks, one to move and one to aim; tiles drawn into RAM.
export class Krull extends Gottlieb {
  constructor(roms) { super(roms); this.controls = 'eight-way'; this.buttons = 0; this.twinStick = true; }
  setInputs(s) {
    const a = s.aim || {};
    this.joy = (a.up ? 1 : 0) | (a.right ? 2 : 0) | (a.down ? 4 : 0) | (a.left ? 8 : 0) | (s.up ? 0x10 : 0) | (s.right ? 0x20 : 0) | (s.down ? 0x40 : 0) | (s.left ? 0x80 : 0);
    this.in1 = 0x01 | (s.coin ? 4 : 0) | (s.start1 ? 0x40 : 0) | (s.start2 ? 0x80 : 0);
  }
  applySwitches() { this.dsw = 0x00; }
}
Krull.id = 'krull'; Krull.title = 'Krull';
Krull.switches = [];

// Q*bert's Qubes (1983): Q*bert's diagonal stick and a second sprite bank.
export class QbertsQubes extends Gottlieb {
  setInputs(s) {
    let r = s.right, l = s.left, u = s.up, d = s.down;
    if (u && r) r = false; else if (u && l) u = false; else if (d && l) l = false; else if (d && r) d = false;
    this.joy = (r ? 1 : 0) | (l ? 2 : 0) | (u ? 4 : 0) | (d ? 8 : 0);
    this.in1 = 0x40 | (s.start1 ? 1 : 0) | (s.start2 ? 2 : 0) | (s.coin ? 8 : 0);
  }
  applySwitches() { this.dsw = 0x01; }          // 1 coin 1 credit, demo sounds on
}
QbertsQubes.id = 'qbertqub'; QbertsQubes.title = "Q*bert's Qubes";
QbertsQubes.spriteBank = true;
QbertsQubes.switches = [];
