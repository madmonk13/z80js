// Konami Yie Ar Kung-Fu (1985): a Motorola 6809 at 1.5 MHz, a fixed 32x32
// map of 8x8 tiles, 24 sprites of 16x16, all at 4 bits per pixel straight
// into a 32-color palette PROM (sprites 0-15, tiles 16-31). Sound is an
// SN76489 plus a VLM5030 speaking the moves and the fighters' names.
//
// One IRQ a frame; the music runs off a stream of NMIs (about 500 a second).
// 60 Hz; the visible picture is 256x224 on a horizontal monitor.

import { M6809 } from './m6809.js';
import { SN76489 } from './sn76489.js';
import { VLM5030 } from './vlm5030.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const CLOCK = 18432000 / 12, W = 256, H = 224, TOP = 16;
const SLICES = 120, SLICE_CYCLES = CLOCK / 60 / SLICES, SLICE_SAMPLES = 48000 / 60 / SLICES, NMI_PER_SLICE = 500 / 60 / SLICES;
const STATE = ['ram', 'control', 'snLatch', 'cycleCarry', 'sampleCarry', 'nmiCarry', 'in0', 'in1', 'cpu', 'sound'];

export class YieArKungFu {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (8000-FFFF, 32K), chars 16K, sprites 64K, palette 32, speech 8K }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = 60;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Kick';
    this.roms = roms;
    this.ram = new Uint8Array(0x1000);         // 5000-5FFF: sprites (5000, 5400), work RAM, tiles at 5800
    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sn = new SN76489(CLOCK);
    this.vlm = new VLM5030(3580000, roms.speech, 0.9);
    this.sound = new SoundMix([this.sn, this.vlm], 1.2);

    const half = roms.chars.length / 2 * 8;
    this.charPix = decodeTiles(roms.chars, {
      count: 512, width: 8, height: 8, planes: [4, 0, half + 4, half], xs: [0, 1, 2, 3, 64, 65, 66, 67], ys: run(0, 8, 8), size: 128,
    });
    const shalf = roms.sprites.length / 2 * 8;
    this.spritePix = decodeTiles(roms.sprites, {
      count: 512, width: 16, height: 16, planes: [4, 0, shalf + 4, shalf],
      xs: [0, 64, 128, 192].flatMap((b) => [b, b + 1, b + 2, b + 3]), ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    // Palette PROM: red bits 0-2, green 3-5, blue 6-7.
    const lvl = (b0, b1, b2) => 0x21 * b0 + 0x47 * b1 + 0x97 * b2;
    this.palette = Uint32Array.from(roms.palette, (v) =>
      rgba(lvl(v & 1, (v >> 1) & 1, (v >> 2) & 1), lvl((v >> 3) & 1, (v >> 4) & 1, (v >> 5) & 1), lvl(0, (v >> 6) & 1, (v >> 7) & 1)));
    this.frame = new Uint32Array(W * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0);
    this.control = 0; this.snLatch = 0;
    this.cycleCarry = this.sampleCarry = this.nmiCarry = 0;
    this.cpu.reset(); this.sound.reset(); this.vlm.reset();
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a >= 0x8000) return this.roms.main[a - 0x8000];
    if (a >= 0x5000 && a < 0x6000) return this.ram[a - 0x5000];
    switch (a) {
      case 0x0000: return this.vlm.busy;
      case 0x4C00: return this.dsw0;
      case 0x4D00: return this.dsw1;
      case 0x4E00: return this.in0;
      case 0x4E01: return this.in1;
      case 0x4E02: return 0xFF;                   // player 2
      case 0x4E03: return this.dsw2;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x5000 && a < 0x6000) { this.ram[a - 0x5000] = v; return; }
    switch (a) {
      case 0x4000: this.control = v; return;      // flip (bit 0), NMI enable (1), IRQ enable (2), coin counters
      case 0x4800: this.snLatch = v; return;
      case 0x4900: this.sn.write(this.snLatch); return;
      case 0x4A00: this.vlm.setSt(v & 2); this.vlm.setRst(v & 4); return;
      case 0x4B00: this.vlm.write(v); return;
    }
    // 4F00 watchdog.
  }

  // ---------------------------------------------------------------- inputs

  // Active low. IN0: coin, start 1, start 2. IN1: left, right, up, down, punch, kick.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.left ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.up ? 0x04 : 0) | (s.down ? 0x08 : 0)
      | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0));
  }
  // DSW0 lives, upright, bonus, difficulty, demo sounds on. DSW1 no flip, upright controls, service off. DSW2 1 coin 1 credit.
  applySwitches(v) { this.dsw0 = v.lives | v.bonus | v.difficulty | 0x40; this.dsw1 = 0xFF; this.dsw2 = 0xFF; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let k = 0; k < SLICES; k++) {
      if (k === 0) { this.render(); if (this.control & 4) this.cpu.irq = true; }
      if (k === 1) this.cpu.irq = false;           // held long enough to be taken
      this.nmiCarry += NMI_PER_SLICE;
      if (this.nmiCarry >= 1) { this.nmiCarry -= 1; if (this.control & 2) this.cpu.nmi(); }
      this.cycleCarry += SLICE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += SLICE_SAMPLES;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, ram = this.ram, pal = this.palette;
    // Tiles: two bytes each at 5800 (attributes, then the code's low 8 bits).
    for (let row = TOP >> 3; row < (TOP + H) >> 3; row++) {
      for (let col = 0; col < 32; col++) {
        const i = 0x800 + (row * 32 + col) * 2, attr = ram[i];
        const code = ram[i + 1] | ((attr & 0x10) << 4);
        const fx = attr & 0x80 ? 7 : 0, fy = attr & 0x40 ? 7 : 0, src = code * 64;
        for (let y = 0; y < 8; y++) {
          const o = (row * 8 + y - TOP) * W + col * 8, line = src + (y ^ fy) * 8;
          for (let x = 0; x < 8; x++) out[o + x] = pal[16 + this.charPix[line + (x ^ fx)]];
        }
      }
    }
    // Sprites: 24, attributes and Y at 5000, X and code at 5400; the first in the list draws on top.
    for (let offs = 0x2E; offs >= 0; offs -= 2) {
      const attr = ram[offs], code = ram[0x401 + offs] | ((attr & 1) << 8);
      const flipX = !(attr & 0x40), flipY = attr & 0x80;
      const sx = ram[0x400 + offs], top = 240 - ram[offs + 1] + (offs < 0x26 ? 1 : 0) - TOP;
      for (let y = 0; y < 16; y++) {
        const py = top + y;
        if (py < 0 || py >= H) continue;
        const src = code * 256 + (flipY ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px >= W) break;
          const c = this.spritePix[src + (flipX ? 15 - x : x)];
          if (c) out[py * W + px] = pal[c];
        }
      }
    }
  }
}

YieArKungFu.id = 'yiear';
YieArKungFu.title = 'Yie Ar Kung-Fu';
YieArKungFu.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x03], ['2', 0x02], ['3', 0x01], ['5', 0x00]], default: 0x01 },
  { id: 'bonus', label: 'Bonus life', options: [['30K, 80K', 0x08], ['40K, 90K', 0x00]], default: 0x08 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x30], ['Normal', 0x10], ['Difficult', 0x20], ['Very difficult', 0x00]], default: 0x10 },
];
