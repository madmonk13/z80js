// Nintendo Mario Bros. (1983): Donkey Kong's design moved on a step. A Z80 at
// 3.072 MHz, a 32x32 layer of 8x8 tiles (2 bits per pixel, colored per tile)
// that can scroll vertically for the POW bump, 16x16 sprites at 3 bits per
// pixel, and an 8039 playing music and effects through a DAC. A few effects
// (running, skid, ice, coin) were analog circuits that MAME plays as samples;
// they aren't reproduced.
//
// 60 Hz; a 256x224 picture on a horizontal monitor, upside down (ROT180).

import { Z80 } from './z80.js';
import { I8035 } from './i8035.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16;
const LINES = 264, LINE_CYCLES = 3072000 / 60 / LINES, VBLANK_LINE = 240;
const SOUND_LINE_CYCLES = 730000 / 60 / LINES, SAMPLES_PER_LINE = 48000 / 60 / LINES;
const STATE = ['ram', 'vram', 'scroll', 'gfxBank', 'palBank', 'nmiEnable', 'latch', 'p1', 'p2', 't0',
  'cycleCarry', 'soundCarry', 'sampleCarry', 'in0', 'in1', 'cpu', 'snd', 'sound'];

// The 8039's DAC, as a chip for the mixer.
class Dac {
  constructor() { this.reset(); }
  reset() { this.value = 0x80; this.out = 0; }
  saveState() { return { value: this.value }; }
  loadState(s) { this.value = s.value; }
  sample() { this.out = (this.value - 128) / 128; }
}

export class MarioBros {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (0000-5FFF, F000-FFFF), sound 4K, chars 8K, sprites 24K, palette 512 }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = 60;
    this.controls = 'two-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x1000);         // 6000-6FFF (sprites at 6900-6A7F)
    this.vram = new Uint8Array(0x400);         // 7400-77FF
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.dac = new Dac();
    this.sound = new SoundMix([this.dac], 0.5);
    this.snd = new I8035({
      rom: roms.sound,
      read: () => this.latch,                    // MOVX reads the tune number
      write: (_, v) => { this.dac.value = v; },  // MOVX writes the DAC
      portIn: (n) => (n === 1 ? this.p1 : this.p2),
      portOut: (n, v) => { if (n === 1) this.p1 = v; else this.p2 = v; },
      test: (n) => (n === 0 ? this.t0 : 0),
    });

    this.charPix = decodeTiles(roms.chars, {
      count: 512, width: 8, height: 8, planes: [roms.chars.length * 4, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64,
    });
    const third = roms.sprites.length / 3 * 8, half = third / 2;
    this.spritePix = decodeTiles(roms.sprites, {
      count: 256, width: 16, height: 16, planes: [third * 2, third, 0],
      xs: [...run(0, 8), ...run(half, 8)], ys: run(0, 16, 8), size: 128,
    });
    // Palette PROM (the first, inverted half): red bits 5-7, green 2-4, blue 0-1.
    this.palette = Uint32Array.from(roms.palette.subarray(0, 256), (v) => {
      const c3 = (b0, b1, b2) => 255 - (0x21 * b0 + 0x47 * b1 + 0x97 * b2);
      return rgba(c3((v >> 5) & 1, (v >> 6) & 1, (v >> 7) & 1), c3((v >> 2) & 1, (v >> 3) & 1, (v >> 4) & 1),
        255 - (0x55 * (v & 1) + 0xAA * ((v >> 1) & 1)));
    });
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.in0 = this.in1 = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0);
    this.scroll = 0; this.gfxBank = 0; this.palBank = 0; this.nmiEnable = false;
    this.latch = 0; this.p1 = 0xF0; this.p2 = 0; this.t0 = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x6000) return this.roms.main[a];
    if (a < 0x7000) return this.ram[a - 0x6000];
    if (a >= 0x7400 && a < 0x7800) return this.vram[a - 0x7400];
    if (a >= 0xF000) return this.roms.main[a - 0x6000];
    switch (a) {
      case 0x7C00: return this.in0;
      case 0x7C80: return this.in1;
      case 0x7F80: return this.dsw;
    }
    return 0;
  }

  write(a, v) {
    if (a >= 0x6000 && a < 0x7000) { this.ram[a - 0x6000] = v; return; }
    if (a >= 0x7400 && a < 0x7800) { this.vram[a - 0x7400] = v; return; }
    switch (a) {
      case 0x7D00: this.scroll = v; break;
      case 0x7E00: this.latch = v; break;                 // tune select
      case 0x7E80: this.gfxBank = v & 1; break;
      case 0x7E83: this.palBank = v & 1; break;
      case 0x7E84: this.nmiEnable = !!(v & 1); break;
      case 0x7F00: this.snd.int = v !== 0; break;         // death: the sound CPU's interrupt
      case 0x7F01: this.t0 = v & 1; break;                // coin collected
      case 0x7F03: case 0x7F04: case 0x7F05: {            // crab, turtle, fly: P1 bits 0-2
        const bit = 1 << (a - 0x7F03);
        this.p1 = v & 1 ? this.p1 | bit : this.p1 & ~bit;
        break;
      }
      // 7C00/7C80 running, 7F02/7F06/7F07 ice, coin and skid: analog effects (not reproduced).
    }
  }

  // ---------------------------------------------------------------- inputs

  // Active high. IN0: right, left, jump, start 1, start 2. IN1: coins.
  setInputs(s) {
    this.in0 = (s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.fire ? 0x10 : 0) | (s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0);
    this.in1 = s.coin ? 0x40 : 0;            // either coin slot (the sets disagree on which is which)
  }
  // Lives, 1 coin 1 credit, bonus, difficulty.
  applySwitches(v) { this.dsw = v.lives | v.bonus | v.difficulty; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) { this.render(); if (this.nmiEnable) this.cpu.nmi(); }
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.soundCarry += SOUND_LINE_CYCLES;
      this.sampleCarry += SAMPLES_PER_LINE;
      // Interleave the 8039 with the output samples so the DAC's steps land in time.
      const samples = Math.floor(this.sampleCarry);
      this.sampleCarry -= samples;
      for (let k = 0; k < samples; k++) {
        const c = Math.floor(this.soundCarry / (samples - k));
        const before = this.snd.cycles;
        this.snd.run(c);
        this.soundCarry -= this.snd.cycles - before;
        this.sound.sample();
      }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, pal = this.palette, vram = this.vram;
    // Tiles: color from the code's top 3 bits (plus the palette bank), from
    // palette entries 40-7F and C0-FF. The layer scrolls vertically.
    for (let y = 0; y < H; y++) {
      const ty = (y + TOP + this.scroll + 17) & 0xFF;
      for (let x = 0; x < W; x++) {
        const code = vram[(ty >> 3) * 32 + (x >> 3)], color = (code >> 5) + 8 * this.palBank;
        const pen = this.charPix[(code + 256 * this.gfxBank) * 64 + (ty & 7) * 8 + (x & 7)];
        out[y * W + x] = pal[64 + 128 * (color >> 3) + 8 * (color & 7) + pen];
      }
    }
    // Sprites (y, attributes, code, x), first to last; y 0 is unused.
    const ram = this.ram;
    for (let o = 0x900; o < 0xA80; o += 4) {
      if (!ram[o]) continue;
      const attr = ram[o + 1], src = ram[o + 2] * 256, color = ((attr & 15) + 16 * this.palBank) * 8;
      const flipX = attr & 0x80, flipY = attr & 0x40;
      const sx = ram[o + 3] - 8, sy = 248 - ram[o] - TOP;
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        const row = src + (flipY ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= W) continue;
          const pen = this.spritePix[row + (flipX ? 15 - x : x)];
          if (pen) out[py * W + px] = pal[color + pen];
        }
      }
    }
    // The monitor is mounted upside down.
    const n = out.length - 1;
    for (let i = 0; i <= n; i++) this.frame[i] = out[n - i];
  }
}

MarioBros.id = 'mario';
MarioBros.title = 'Mario Bros.';
MarioBros.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x00], ['4', 0x01], ['5', 0x02], ['6', 0x03]], default: 0x00 },
  { id: 'bonus', label: 'Bonus', options: [['20K', 0x00], ['30K', 0x10], ['40K', 0x20], ['None', 0x30]], default: 0x00 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x00], ['Medium', 0x80], ['Hard', 0x40], ['Hardest', 0xC0]], default: 0x00 },
];
