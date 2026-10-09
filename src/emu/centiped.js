// Atari Centipede (1980): a 6502 at 1.512 MHz, a 32x30 grid of 8x8 tiles, 16
// sprites of 8x16, eight colors in palette RAM (four for tiles, four for
// sprites), a POKEY for sound, a trackball, and an EAROM for the high scores.
// The CPU is interrupted four times a frame from the video counter.
//
// 256 lines of about 98 cycles (60 Hz); the picture is 256x240 on a vertical
// monitor mounted counter-clockwise.

import { CPU6502 as M6502 } from './m6502.js';
import { Pokey } from './pokey.js';
import { decodeTiles, rgba, rotate270, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 240;
const LINES = 256, CPU_CLOCK = 12096000 / 8, LINE_CYCLES = CPU_CLOCK / 60 / LINES;
const SAMPLES_PER_LINE = 48000 / 60 / LINES;
const STATE = ['ram', 'earom', 'palRam', 'track', 'oldPos', 'sign', 'cycleCarry', 'sampleCarry', 'line', 'in1', 'cpu', 'sound'];

export class Centipede {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.palRam.forEach((v, i) => this.setColor(i, v)); }

  // roms: { main 8K (2000-3FFF), gfx 4K }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = 60;
    this.controls = 'eight-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x800);           // 0000-03FF work RAM, 0400-07BF tiles, 07C0-07FF sprites
    this.earom = new Uint8Array(0x40);
    this.palRam = new Uint8Array(16);
    this.palette = new Uint32Array(8).fill(0xFF000000);
    this.cpu = new M6502({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sound = new Pokey(CPU_CLOCK, 5);       // the game plays at low POKEY volumes
    // Tiles and sprites share the graphics ROMs: plane 1 in the second half.
    const half = roms.gfx.length * 4;
    this.charPix = decodeTiles(roms.gfx, { count: 256, width: 8, height: 8, planes: [half, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    this.spritePix = decodeTiles(roms.gfx, { count: 128, width: 8, height: 16, planes: [half, 0], xs: run(0, 8), ys: run(0, 16, 8), size: 128 });
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.in1 = 0xFF; this.stick = { x: 0, y: 0 };
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.palRam.fill(0);
    this.track = [0, 0]; this.oldPos = [0, 0]; this.sign = [0, 0];
    this.cycleCarry = this.sampleCarry = 0;
    this.line = 0;
    this.sound.reset();
    this.cpu.reset();
  }

  // ---------------------------------------------------------------- bus (14 address lines)

  read(a) {
    a &= 0x3FFF;
    if (a < 0x800) return this.ram[a];
    if (a >= 0x2000) return this.roms.main[a - 0x2000];
    switch (a) {
      case 0x0800: return this.dsw1;
      case 0x0801: return this.dsw2;
      case 0x0C00: return this.trackball(0, (this.line >= 240 ? 0x40 : 0) | 0x20);   // vblank, service off, upright
      case 0x0C01: return this.in1;
      case 0x0C02: return this.trackball(1, 0);
      case 0x0C03: return 0xFF;                   // joystick port (unused upright)
    }
    if (a >= 0x1000 && a < 0x1010) return this.sound.read(a);
    if (a >= 0x1700 && a < 0x1740) return this.earom[a & 0x3F];
    return 0xFF;
  }

  write(a, v) {
    a &= 0x3FFF;
    if (a < 0x800) { this.ram[a] = v; return; }
    if (a >= 0x1000 && a < 0x1010) { this.sound.write(a, v); return; }
    if (a >= 0x1400 && a < 0x1410) { this.palRam[a & 15] = v; this.setColor(a & 15, v); return; }
    if (a >= 0x1600 && a < 0x1640) { this.earom[a & 0x3F] = v; return; }
    if (a === 0x1800) { this.cpu.irq = false; return; }   // interrupt acknowledge
    // 1680 EAROM control, 1C00-1C07 coin counters, lamps and flip, 2000 watchdog.
  }

  // Palette RAM (bits inverted): red, green, blue, and an "alternate" bit that
  // dims blue (or green, when there's no blue). Locations 4-7 are tiles,
  // C-F sprites; the rest aren't connected.
  setColor(o, v) {
    if (!(o & 4)) return;
    let r = (~v & 1) * 0xFF, g = ((~v >> 1) & 1) * 0xFF, b = ((~v >> 2) & 1) * 0xFF;
    if (~v & 8) { if (b) b = 0xC0; else if (g) g = 0xC0; }
    this.palette[((o >> 1) & 4) | (o & 3)] = rgba(r, g, b);
  }

  // The trackball: a 4-bit counter per axis plus a direction bit that's
  // latched whenever the count moves.
  trackball(axis, switches) {
    const pos = this.track[axis] & 0xFF;
    if (pos !== this.oldPos[axis]) { this.sign[axis] = (pos - this.oldPos[axis]) & 0x80; this.oldPos[axis] = pos; }
    return switches | (this.oldPos[axis] & 0x0F) | this.sign[axis];
  }

  // ---------------------------------------------------------------- inputs

  // The trackball rolls with the stick (or a dial drag); IN1: starts, fire, coin.
  setInputs(s) {
    const speed = 3;
    this.stick.x = (s.right ? speed : 0) - (s.left ? speed : 0) + (s.spin || 0);
    this.stick.y = (s.down ? speed : 0) - (s.up ? speed : 0);
    this.in1 = 0xFF & ~((s.start1 ? 0x01 : 0) | (s.start2 ? 0x02 : 0) | (s.fire ? 0x04 : 0) | (s.coin ? 0x20 : 0));
  }
  // Switches: language, lives, bonus, difficulty, credit minimum; 1 coin 1 credit.
  applySwitches(v) { this.dsw1 = v.lives | v.bonus | v.difficulty; this.dsw2 = 0x02; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    // The trackball moves a little each frame (X reversed, as wired).
    this.track[0] = (this.track[0] - Math.round(this.stick.x)) & 0xFF;
    this.track[1] = (this.track[1] + Math.round(this.stick.y)) & 0xFF;
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      // The interrupt follows video counter bit 5, sampled every 16 lines.
      if ((line & 31) === 16) this.cpu.irq = !!((line - 1) & 32);
      if (line === 240) this.render();
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, ram = this.ram, pal = this.palette;
    for (let row = 0; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const data = ram[0x400 + row * 32 + col], src = ((data & 0x3F) + 0x40) * 64;
        const flipX = data & 0x40, flipY = data & 0x80;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y) * W + col * 8;
          const sy = (flipY ? 7 - y : y) * 8;
          for (let x = 0; x < 8; x++) out[o++] = pal[this.charPix[src + sy + (flipX ? 7 - x : x)]];
        }
      }
    }
    // Sprites: code/flips at 7C0, y at 7D0, x at 7E0, colors at 7F0. Each
    // 2-bit field of the color byte picks the color for one pen; a field of 0
    // makes that pen see-through.
    for (let n = 0; n < 16; n++) {
      const c = ram[0x7C0 + n], color = ram[0x7F0 + n];
      const code = ((c & 0x3E) >> 1) | ((c & 1) << 6), flipX = (c >> 6) & 1, flipY = (c >> 7) & 1;
      const sx = ram[0x7E0 + n], sy = 240 - ram[0x7D0 + n];
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        const src = code * 128 + (flipY ? 15 - y : y) * 8;
        for (let x = 0; x < 8; x++) {
          const px = sx + x;
          if (px >= W - 8) continue;
          const pen = this.spritePix[src + (flipX ? 7 - x : x)];
          if (!pen) continue;
          const field = (color >> ((pen - 1) * 2)) & 3;
          if (field) out[py * W + px] = pal[4 + field];
        }
      }
    }
    rotate270(out, W, H, this.frame);
  }
}

Centipede.id = 'centiped';
Centipede.title = 'Centipede';
Centipede.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x00], ['3', 0x04], ['4', 0x08], ['5', 0x0C]], default: 0x04 },
  { id: 'bonus', label: 'Bonus', options: [['10K', 0x00], ['12K', 0x10], ['15K', 0x20], ['20K', 0x30]], default: 0x10 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x40], ['Hard', 0x00]], default: 0x40 },
];
