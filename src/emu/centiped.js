// Atari Centipede (1980): a 6502 at 1.512 MHz, a 32x30 grid of 8x8 tiles, 16
// sprites of 8x16, eight colors in palette RAM (four for tiles, four for
// sprites), a POKEY for sound, a trackball, and an EAROM for the high scores.
// The CPU is interrupted four times a frame from the video counter.
//
// 256 lines of about 98 cycles (60 Hz); the picture is 256x240 on a vertical
// monitor mounted counter-clockwise.

import { CPU6502 as M6502 } from './m6502.js';
import { Pokey, PokeyVoice } from './pokey.js';
import { SoundMix } from './mixer.js';
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

// ---------------------------------------------------------------- Millipede

// Millipede (1982): the same board grown up. 32K of address space, two POKEYs
// (their pot lines read the two DIP banks), 32 colors (four 4-color tile
// palettes, four 4-color sprite banks), tile codes with a bank bit, and an
// EAROM behind a data latch (`nvram`). A write to 2505 swaps the trackball
// counts for more DIP switches.
const MSTATE = [...STATE, 'vram', 'dswSelect', 'earomOffset', 'earomData', 'in2'];

export class Millipede extends Centipede {
  saveState() { return capture(this, MSTATE); }
  loadState(s) { apply(this, MSTATE, s); this.palRam.forEach((v, i) => this.setColor(i, v)); }

  // roms: { main 16K (4000-7FFF), gfx 4K }
  constructor(roms) {
    super(roms);
    this.ram = new Uint8Array(0x400);
    this.vram = new Uint8Array(0x400);          // 1000-13BF tiles, 13C0-13FF sprites
    this.palRam = new Uint8Array(32);
    this.palette = new Uint32Array(32).fill(0xFF000000);
    this.nvram = this.earom;
    this.pokey1 = new Pokey(CPU_CLOCK, 2); this.pokey1.readPots = () => this.dsw1;
    this.pokey2 = new Pokey(CPU_CLOCK, 2); this.pokey2.readPots = () => this.dsw2;
    this.sound = new SoundMix([new PokeyVoice(this.pokey1), new PokeyVoice(this.pokey2)], 1);
    this.in2 = 0xFF;
    this.reset();
  }

  reset() {
    super.reset();
    if (this.vram) this.vram.fill(0);
    this.dswSelect = 0; this.earomOffset = 0; this.earomData = 0;
  }

  // The trackball ports; with the switch select on, the switches show instead.
  track2(axis, sw) {
    if (this.dswSelect) return (sw & 0x7F) | this.sign[axis];
    return this.trackball(axis, sw & 0x70);
  }

  read(a) {
    a &= 0x7FFF;
    if (a < 0x400) return this.ram[a];
    if (a >= 0x4000) return this.roms.main[a - 0x4000];
    if (a >= 0x1000 && a < 0x1400) return this.vram[a - 0x1000];
    if (a >= 0x0400 && a < 0x0410) return this.pokey1.read(a);
    if (a >= 0x0800 && a < 0x0810) return this.pokey2.read(a);
    switch (a) {
      case 0x2000: return this.track2(0, this.sw0 | (this.in1 & 0x30) | (this.line >= 240 ? 0x40 : 0));
      case 0x2001: return this.track2(1, this.in1 >> 4 & 0x20 | 0x10);
      case 0x2010: return this.in2;
      case 0x2011: return 0xFF;                   // P2 stick idle, upright, service off
      case 0x2030: return this.earomData;
    }
    return 0xFF;
  }

  write(a, v) {
    a &= 0x7FFF;
    if (a < 0x400) { this.ram[a] = v; return; }
    if (a >= 0x1000 && a < 0x1400) { this.vram[a - 0x1000] = v; return; }
    if (a >= 0x0400 && a < 0x0410) { this.pokey1.write(a, v); return; }
    if (a >= 0x0800 && a < 0x0810) { this.pokey2.write(a, v); return; }
    if (a >= 0x2480 && a < 0x24A0) { this.palRam[a & 31] = v; this.setColor(a & 31, v); return; }
    if (a >= 0x2780 && a < 0x27C0) { this.earomOffset = a & 0x3F; this.earomData = v; return; }
    switch (a) {
      case 0x2505: this.dswSelect = (~v >> 7) & 1; return;
      case 0x2600: this.cpu.irq = false; return;
      case 0x2700:
        if (v & 1) this.earomData = this.earom[this.earomOffset];
        if ((v & 0x0C) === 0x0C) this.earom[this.earomOffset] = this.earomData;
        return;
    }
    // 2500-2504 coin counters and lamps, 2506 flip, 2507 cocktail select, 2680 watchdog.
  }

  // Palette RAM, bits inverted: blue in 0-2, green in 3-4, red in 5-7.
  setColor(o, v) {
    const lvl = (b0, b1, b2) => 0x21 * b0 + 0x47 * b1 + 0x97 * b2, n = ~v;
    this.palette[o] = rgba(lvl((n >> 5) & 1, (n >> 6) & 1, (n >> 7) & 1), lvl(0, (n >> 3) & 1, (n >> 4) & 1), lvl(n & 1, (n >> 1) & 1, (n >> 2) & 1));
  }

  // Buttons share the trackball ports (IN0 fire/start 1, IN1 start 2); coins in IN2.
  setInputs(s) {
    super.setInputs(s);
    // bits 4-5: fire, start 1; bit 9: start 2 (all active low)
    this.in1 = 0x3FF & ~((s.fire ? 0x10 : 0) | (s.start1 ? 0x20 : 0) | (s.start2 ? 0x200 : 0));
    this.in2 = 0xFF & ~((s.coin ? 0x20 : 0));
  }

  applySwitches(v) { this.dsw1 = v.lives | v.bonus | v.difficulty; this.dsw2 = 0x02; this.sw0 = v.start; }

  render() {
    const out = this.native, vram = this.vram, pal = this.palette;
    for (let row = 0; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const data = vram[row * 32 + col], bank = (data >> 6) & 1, color = ((data >> 6) & 3) * 4;
        const src = ((data & 0x3F) + 0x40 + bank * 0x80) * 64;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y) * W + col * 8;
          for (let x = 0; x < 8; x++) out[o++] = pal[color + this.charPix[src + y * 8 + x]];
        }
      }
    }
    // Sprites: code/flip at 3C0, y at 3D0, x at 3E0, colors at 3F0. The color
    // byte's top two bits pick a bank of four; each 2-bit field below picks the
    // color for one pen, and a field of 0 is see-through.
    for (let n = 0; n < 16; n++) {
      const c = vram[0x3C0 + n], color = vram[0x3F0 + n], base = 16 + 4 * (color >> 6);
      const code = ((c & 0x3E) >> 1) | ((c & 1) << 6), flipY = (c >> 7) & 1;
      const sx = vram[0x3E0 + n], sy = 240 - vram[0x3D0 + n];
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        const src = code * 128 + (flipY ? 15 - y : y) * 8;
        for (let x = 0; x < 8; x++) {
          const px = sx + x;
          if (px >= W - 8) continue;
          const pen = this.spritePix[src + x];
          if (!pen) continue;
          const field = (color >> ((pen - 1) * 2)) & 3;
          if (field) out[py * W + px] = pal[base + field];
        }
      }
    }
    rotate270(out, W, H, this.frame);
  }
}

Millipede.id = 'milliped';
Millipede.title = 'Millipede';
Millipede.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x00], ['3', 0x04], ['4', 0x08], ['5', 0x0C]], default: 0x04 },
  { id: 'bonus', label: 'Bonus', options: [['12K', 0x00], ['15K', 0x10], ['20K', 0x20], ['None', 0x30]], default: 0x10 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x00], ['Hard', 0x43]], default: 0x00 },
  { id: 'start', label: 'Starting score', options: [['0', 0x00], ['0, 1x', 0x04], ['0, 1x, 2x', 0x08], ['0, 1x, 2x, 3x', 0x0C]], default: 0x04 },
];

// ---------------------------------------------------------------- Warlords

// Warlords (1980): Centipede's board with four paddles on the POKEY's pot
// lines and one fire button each. The computer takes any castle no one
// claims; you play the bottom-left one. Colors come from a PROM (cocktail set:
// a color per quadrant, no overlay); 64 tiles and 64 8x8 sprites.
const WSTATE = [...STATE, 'paddle'];

export class Warlords extends Centipede {
  saveState() { return capture(this, WSTATE); }
  loadState(s) { apply(this, WSTATE, s); }

  // roms: { main 12K (5000-7FFF), gfx 2K, prom 256 }
  constructor(roms) {
    super(roms);
    this.width = W; this.height = H;
    this.controls = 'two-way';
    this.spinner = true; this.dialSpeed = 4;
    this.sound.readPot = (n) => (n === 0 ? this.paddle : 0x80);
    const g = { count: 64, width: 8, height: 8, planes: [0x400 * 8, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 };
    this.charPix = decodeTiles(roms.gfx, g);
    this.spritePix = decodeTiles(roms.gfx.subarray(0x200), g);
    const col = (v) => rgba((v >> 2 & 1) * 0xFF, (v >> 1 & 1) * 0xFF, (v & 1) * 0xFF);
    this.tileColors = Uint32Array.from({ length: 16 }, (_, i) => col(roms.prom[(i >> 2) * 16 + (i & 3)]));
    this.spriteColors = Uint32Array.from({ length: 16 }, (_, i) => col(roms.prom[(i >> 2) * 16 + (i & 3) * 4]));
    this.paddle = 0x80;
  }

  setColor() {}

  read(a) {
    a &= 0x7FFF;
    if (a < 0x800) return this.ram[a];
    if (a >= 0x5000) return this.roms.main[a - 0x5000];
    switch (a) {
      case 0x0800: return this.dsw1;
      case 0x0801: return this.dsw2;
      case 0x0C00: return 0x20 | (this.line >= 240 ? 0x40 : 0);   // service off, vblank, cocktail colors
      case 0x0C01: return this.in1;
    }
    if (a >= 0x1000 && a < 0x1010) return this.sound.read(a);
    return 0xFF;
  }

  write(a, v) {
    a &= 0x7FFF;
    if (a < 0x800) { this.ram[a] = v; return; }
    if (a >= 0x1000 && a < 0x1010) { this.sound.write(a, v); return; }
    if (a === 0x1800) this.cpu.irq = false;
    // 1C00-1C06 coin counters and button lamps, 4000 watchdog.
  }

  // Your paddle turns with the dial or the stick; the fire button catches.
  setInputs(s) {
    const turn = (s.spin || 0) + (s.right ? 4 : 0) - (s.left ? 4 : 0);
    this.paddle = Math.max(0x1D, Math.min(0xCB, this.paddle + Math.round(turn)));
    this.in1 = 0xFF & ~((s.fire || s.start1 ? 0x01 : 0) | (s.coin ? 0x20 : 0));
    this.stick.x = this.stick.y = 0;
  }
  applySwitches(v) { this.dsw1 = v.music; this.dsw2 = 0x02; }

  render() {
    const out = this.frame, ram = this.ram;
    for (let row = 0; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const data = ram[0x400 + row * 32 + col], src = (data & 0x3F) * 64;
        const flipX = data & 0x40, flipY = data & 0x80, pal = ((col >> 4) | ((row >> 4) << 1)) * 4;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y) * W + col * 8;
          const sy = (flipY ? 7 - y : y) * 8;
          for (let x = 0; x < 8; x++) out[o++] = this.tileColors[pal + this.charPix[src + sy + (flipX ? 7 - x : x)]];
        }
      }
    }
    // Sprites: code/flips at 7C0, y at 7D0, x at 7E0; colored by quadrant.
    for (let n = 0; n < 16; n++) {
      const c = ram[0x7C0 + n], src = (c & 0x3F) * 64, flipX = (c >> 6) & 1, flipY = (c >> 7) & 1;
      const sx = ram[0x7E0 + n], sy = 248 - ram[0x7D0 + n];
      const pal = (((sy & 0x80) >> 6) | ((sx & 0x80) >> 7)) * 4;
      for (let y = 0; y < 8; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        for (let x = 0; x < 8; x++) {
          const px = sx + x;
          if (px >= W) continue;
          const pen = this.spritePix[src + (flipY ? 7 - y : y) * 8 + (flipX ? 7 - x : x)];
          if (pen) out[py * W + px] = this.spriteColors[pal + pen];
        }
      }
    }
  }
}

Warlords.id = 'warlords';
Warlords.title = 'Warlords';
Warlords.switches = [
  { id: 'music', label: 'Music', options: [['End of game', 0x00], ['High score only', 0x04]], default: 0x00 },
];
