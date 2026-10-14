// Konami Time Pilot '84 (1984): two 6809s at 1.5 MHz sharing 2K of RAM. The
// main one runs the game and draws two 32x32 maps of 8x8 two-bit tiles (a
// scrolling background, and a fixed layer whose outer two columns hold the
// score panels); the second one multiplexes the sprites, rewriting a small
// sprite list as the beam moves down the screen, so the list is caught line
// by line. A Z80 plays the music on three SN76489s.
//
// Colors: 256 from three resistor PROMs; tiles use the top 128 through a
// lookup PROM, sprites the bottom 128 through another, both banked by COL0.
// 256x224 on a vertical monitor at 60 Hz.

import { M6809 } from './m6809.js';
import { Z80 } from './z80.js';
import { SN76489 } from './sn76489.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16, LINES = 256, REFRESH = 60;
const CPU_CLOCK = 1500000, SOUND_CLOCK = 14318180 / 4;
const SPRITES = 0x7A0, SPRITE_BYTES = 0x60;   // the second CPU's live sprite list, 6000-67FF RAM
const STATE = ['vram', 'shared', 'subRam', 'soundRam', 'mux', 'col0', 'scrollX', 'scrollY', 'subIrqOn', 'line', 'latch',
  'in0', 'in1', 'cycleCarry', 'subCarry', 'soundCarry', 'sampleCarry', 'cpu', 'sub', 'snd', 'sn'];

export class TimePilot84 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (8000-FFFF), sub (E000-FFFF), sound (0000-1FFF), chars, sprites, red/green/blue, charLut, spriteLut }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Missile';
    this.roms = roms;
    this.vram = new Uint8Array(0x1000);        // 4000-4FFF: background codes, fixed-layer codes, then their colors
    this.shared = new Uint8Array(0x800);       // 5000-57FF on the main CPU, 8000-87FF on the second
    this.subRam = new Uint8Array(0x800);       // 6000-67FF on the second CPU
    this.soundRam = new Uint8Array(0x400);
    this.mux = new Uint8Array(LINES * SPRITE_BYTES);   // the sprite list as each line began

    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onTaken = (kind) => { if (kind === 'irq') this.cpu.irq = false; };
    this.sub = new M6809({ read: (a) => this.subRead(a), write: (a, v) => this.subWrite(a, v) });
    this.sub.onTaken = (kind) => { if (kind === 'irq') this.sub.irq = false; };
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.sn = [0, 1, 2].map(() => new SN76489(14318180 / 8));
    this.sound = new SoundMix(this.sn, 0.75);

    this.charPix = decodeTiles(roms.chars, {
      count: roms.chars.length / 16, width: 8, height: 8, planes: [4, 0],
      xs: [...run(0, 4), ...run(64, 4)], ys: run(0, 8, 8), size: 128,
    });
    const half = roms.sprites.length / 2 * 8;
    this.spritePix = decodeTiles(roms.sprites, {
      count: roms.sprites.length / 128, width: 16, height: 16, planes: [half + 4, half, 4, 0],
      xs: [...run(0, 4), ...run(64, 4), ...run(128, 4), ...run(192, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    const lvl = (v) => 0x0E * (v & 1) + 0x1F * ((v >> 1) & 1) + 0x42 * ((v >> 2) & 1) + 0x90 * ((v >> 3) & 1);
    this.palette = Uint32Array.from({ length: 256 }, (_, i) => rgba(lvl(roms.red[i]), lvl(roms.green[i]), lvl(roms.blue[i])));
    this.frame = new Uint32Array(W * H);
    this.native = new Uint32Array(W * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.vram, this.shared, this.subRam, this.soundRam, this.mux]) a.fill(0);
    this.col0 = 0; this.scrollX = 0; this.scrollY = 0; this.subIrqOn = 0; this.line = 0; this.latch = 0;
    this.cycleCarry = this.subCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sub.reset(); this.snd.reset(); this.sound.reset();
  }

  read(a) {
    if (a >= 0x8000) return this.roms.main[a - 0x8000];
    if (a >= 0x5000 && a < 0x5800) return this.shared[a - 0x5000];
    if (a >= 0x4000 && a < 0x5000) return this.vram[a - 0x4000];
    switch (a) {
      case 0x2800: return this.in0;
      case 0x2820: return this.in1;
      case 0x2840: return 0xFF;
      case 0x2860: return 0xFF;                   // DSW0: 1 coin 1 credit on both slots
      case 0x3000: return this.dsw1;
    }
    return 0xFF;
  }
  write(a, v) {
    if (a >= 0x5000 && a < 0x5800) { this.shared[a - 0x5000] = v; return; }
    if (a >= 0x4000 && a < 0x5000) { this.vram[a - 0x4000] = v; return; }
    switch (a) {
      case 0x2800: this.col0 = v; return;
      case 0x3800: this.snd.irqVector = 0xFF; this.snd.irq = true; return;
      case 0x3A00: this.latch = v; return;
      case 0x3C00: this.scrollX = v; return;
      case 0x3E00: this.scrollY = v; return;
    }
  }

  subRead(a) {
    if (a >= 0xE000) return this.roms.sub[a - 0xE000];
    if (a >= 0x8000 && a < 0x8800) return this.shared[a - 0x8000];
    if (a >= 0x6000 && a < 0x6800) return this.subRam[a - 0x6000];
    if (a === 0x2000) return this.line;          // the beam's line
    return 0xFF;
  }
  subWrite(a, v) {
    if (a >= 0x8000 && a < 0x8800) this.shared[a - 0x8000] = v;
    else if (a >= 0x6000 && a < 0x6800) this.subRam[a - 0x6000] = v;
    else if (a === 0x4000) this.subIrqOn = v & 1;
  }

  soundRead(a) {
    if (a < 0x4000) return this.roms.sound[a] ?? 0xFF;
    if (a < 0x4400) return this.soundRam[a - 0x4000];
    if (a === 0x6000) return this.latch;
    if (a === 0x8000) return Math.floor(this.snd.cycles / 1024) & 0x0F;   // a timer: the CPU clock / 2048
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0x4000 && a < 0x4400) this.soundRam[a - 0x4000] = v;
    else if (a === 0xC001) this.sn[0].write(v);
    else if (a === 0xC003) this.sn[1].write(v);
    else if (a === 0xC004) this.sn[2].write(v);
  }

  // IN0: coin, starts. IN1: left, right, up, down, fire, missile.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0) | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0));
  }
  // DSW1: lives, upright, bonus, difficulty, demo sounds on.
  applySwitches(v) { this.dsw1 = v.lives | v.bonus | v.difficulty; }

  runFrame() {
    const main = CPU_CLOCK / REFRESH / LINES, snd = SOUND_CLOCK / REFRESH / LINES, samples = RATE / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      // The second CPU sees the beam's line, and its sprite list is caught as each line starts.
      this.line = line;
      this.mux.set(this.subRam.subarray(SPRITES, SPRITES + SPRITE_BYTES), line * SPRITE_BYTES);
      if (line === LINES - 1) { this.cpu.irq = true; if (this.subIrqOn) this.sub.irq = true; }
      this.cycleCarry += main;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.subCarry += main;
      this.subCarry -= this.sub.run(Math.floor(this.subCarry));
      this.soundCarry += snd;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    this.render();
  }

  render() {
    const out = this.native, v = this.vram, pal = this.palette, clut = this.roms.charLut, slut = this.roms.spriteLut;
    const bank = this.col0 & 7, cbase = (this.col0 & 0x18) << 3;
    const tile = (codes, colors, tx, ty) => {
      const i = (ty >> 3) * 32 + (tx >> 3), attr = v[colors + i];
      const code = v[codes + i] + ((attr & 0x30) << 4);
      const px = attr & 0x40 ? 7 - (tx & 7) : tx & 7, py = attr & 0x80 ? 7 - (ty & 7) : ty & 7;
      const pen = this.charPix[code * 64 + py * 8 + px];
      return pal[clut[(attr & 0x0F) * 4 + cbase + pen] + 128 + 16 * bank];
    };
    for (let y = 0; y < H; y++) {
      const sy = y + TOP;
      for (let x = 0; x < W; x++) {
        // The fixed layer shows only in the two outer columns at each side (the score panels).
        out[y * W + x] = x < 16 || x >= W - 16 ? tile(0x400, 0xC00, x, sy)
          : tile(0x000, 0x800, (x + this.scrollX) & 0xFF, (sy + this.scrollY) & 0xFF);
      }
    }
    // Sprites, per line from the list caught then; earlier entries on top.
    const sp = this.spritePix, cb = 16 * bank;
    for (let y = 0; y < H; y++) {
      const line = y + TOP, list = line * SPRITE_BYTES, row = y * W;
      for (let offs = SPRITE_BYTES - 4; offs >= 0; offs -= 4) {
        const m = this.mux, sy = 240 - m[list + offs + 3];
        if (!(sy > line - 16 && sy <= line)) continue;
        const sx = m[list + offs], code = m[list + offs + 1], attr = m[list + offs + 2];
        const fx = !(attr & 0x40), fy = attr & 0x80, ry = line - sy;
        const src = code * 256 + (fy ? 15 - ry : ry) * 16, color = (attr & 0x0F) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px >= W) continue;
          const c = slut[color + sp[src + (fx ? 15 - x : x)]];
          if (c) out[row + px] = pal[c + cb];
        }
      }
    }
    rotate90(out, W, H, this.frame);
  }
}
TimePilot84.id = 'tp84';
TimePilot84.title = "Time Pilot '84";
TimePilot84.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x03], ['3', 0x02], ['5', 0x01], ['7', 0x00]], default: 0x02 },
  { id: 'bonus', label: 'Bonus life', options: [['10K, every 50K', 0x18], ['20K, every 60K', 0x10], ['30K, every 70K', 0x08], ['40K, every 80K', 0x00]], default: 0x10 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Hardest', 0x00]], default: 0x40 },
];
