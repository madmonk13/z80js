// Nintendo Popeye (1982): a Z80 at 4 MHz on a 512x448 raster (higher than
// most of its peers), a scrolling background drawn as a bitmap of 8x4 color
// blocks, 16x16 sprites at 2 bits per pixel, a layer of doubled 8x8 text on
// top, and one AY-3-8910 that also reads the switches. The program ROMs are
// encrypted (address and data lines swapped), and a small shifter chip at
// E000 acts as protection.
//
// 60 Hz; horizontal monitor.

import { Z80 } from './z80.js';
import { AY8910 } from './ay8910.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 512, H = 448, TOP = 32;
const LINES = 262, LINE_CYCLES = 4000000 / 60 / LINES, VBLANK_LINE = 240;
const SAMPLES_PER_LINE = 48000 / 60 / LINES;
const STATE = ['ram', 'vram', 'bitmap', 'prot', 'dswBit', 'cycleCarry', 'sampleCarry', 'in0', 'in2', 'cpu', 'sound'];

// Bit `order[k]` of v becomes bit (n-1-k) of the result.
const swap = (v, order) => order.reduce((r, b, k) => r | (((v >> b) & 1) << (order.length - 1 - k)), 0);
const ADDR = [15, 14, 13, 12, 11, 10, 8, 7, 6, 3, 9, 5, 4, 2, 1, 0], DATA = [3, 4, 2, 5, 1, 6, 0, 7];

// Resistor weights, outputs inverted: the sprite and text PROMs use
// 1K/470/220 ohms, the background one 1.2K/680/470.
const FG = [0x21, 0x47, 0x97], BG = [0x1C, 0x31, 0x47];
function color(v, w) {
  v = ~v;
  const c = (b0, b1, b2) => w[0] * ((v >> b0) & 1) + w[1] * ((v >> b1) & 1) + w[2] * ((v >> b2) & 1);
  return rgba(c(0, 1, 2), c(3, 4, 5), w[1] * ((v >> 6) & 1) + w[2] * ((v >> 7) & 1));
}

export class Popeye {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 32K (encrypted), chars 2K, sprites 32K, bgPal 32, charPal 32, spriteLo 256, spriteHi 256 }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = 60;
    this.controls = 'four-way';
    this.buttons = 1;
    this.main = Uint8Array.from({ length: 0x8000 }, (_, i) => swap(roms.main[swap(i, ADDR) ^ 0x3F], DATA));
    this.ram = new Uint8Array(0x1000);         // 8000-8FFF; 8C00-8C02 background position, 8C03 palette bank, 8C04- sprites
    this.vram = new Uint8Array(0x800);         // A000-A3FF codes, A400-A7FF colors
    this.bitmap = new Uint8Array(0x2000);      // C000-DFFF: one color per 8x4 block, 64 blocks across
    this.cpu = new Z80({
      read: (a) => this.read(a), write: (a, v) => this.write(a, v),
      input: (p) => this.input(p & 0xFF), output: (p, v) => this.output(p & 0xFF, v),
    });
    this.sound = new AY8910(2000000, (port) => (port === 0 ? this.portA() : 0xFF), 2);
    this.sound.portOut = (port, v) => { if (port === 1) this.dswBit = (v >> 1) & 7; };

    this.charPix = decodeTiles(roms.chars, { count: 256, width: 8, height: 8, planes: [0], xs: run(7, 8, -1), ys: run(0, 8, 8), size: 64 });
    const q = roms.sprites.length / 4 * 8;
    this.spritePix = decodeTiles(roms.sprites, {
      count: 512, width: 16, height: 16, planes: [0, q * 2],
      xs: [...run(q + 7, 8, -1), ...run(7, 8, -1)], ys: run(15 * 8, 16, -8), size: 128,
    });
    // Text color i is stored at i with address bits 3 and 4 tied together.
    this.charPal = Uint32Array.from({ length: 16 }, (_, i) => color(roms.charPal[i | ((i & 8) << 1)], FG));
    this.spritePal = Uint32Array.from({ length: 256 }, (_, i) => color((roms.spriteLo[i] & 15) | ((roms.spriteHi[i] & 15) << 4), FG));
    this.bgPal = Uint32Array.from(roms.bgPal, (v) => color(v, BG));

    this.frame = new Uint32Array(W * H);
    this.in0 = 0; this.in2 = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.bitmap.fill(0);
    this.prot = [0, 0, 0];                     // shift, previous value, last value
    this.dswBit = 0;
    this.cycleCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x8000) return this.main[a];
    if (a < 0x9000) return this.ram[a - 0x8000];
    if (a >= 0xA000 && a < 0xA800) return this.vram[a - 0xA000];
    // The protection chip returns its last two values written, shifted.
    if (a === 0xE000) { const [s, p0, p1] = this.prot; return ((p1 << s) | (p0 >> (8 - s))) & 0xFF; }
    if (a === 0xE001) return 0;
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0x9000) this.ram[a - 0x8000] = v;
    else if (a >= 0xA000 && a < 0xA800) this.vram[a - 0xA000] = v;
    else if (a >= 0xC000 && a < 0xE000) this.bitmap[a - 0xC000] = v;
    else if (a === 0xE000) this.prot[0] = v & 7;
    else if (a === 0xE001) { this.prot[1] = this.prot[2]; this.prot[2] = v; }
  }

  input(p) {
    switch (p) {
      case 0: return this.in0;
      case 1: return 0;
      case 2: return this.in2;
      case 3: return this.sound.read();
    }
    return 0xFF;
  }

  output(p, v) {
    if (p === 0) this.sound.select(v);
    else if (p === 1) this.sound.write(v);
  }

  // DSW0, with bit 7 one bit of DSW1 at a time (the AY's port B picks which).
  portA() { return (this.dsw0 & 0x7F) | ((this.dsw1 << (7 - this.dswBit)) & 0x80); }

  // ---------------------------------------------------------------- inputs

  // Active high. IN0: right, left, up, down, punch. IN2: starts, coin.
  setInputs(s) {
    this.in0 = (s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.up ? 0x04 : 0) | (s.down ? 0x08 : 0) | (s.fire ? 0x10 : 0);
    this.in2 = (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0) | (s.coin ? 0x80 : 0);
  }
  // DSW0: 1 coin 1 credit, Nintendo copyright. DSW1: lives, difficulty, bonus, demo sounds, upright.
  applySwitches(v) {
    this.dsw0 = 0x0F | 0x10 | 0x40;
    this.dsw1 = v.lives | v.difficulty | v.bonus | 0x40;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      // The NMI is gated by bit 0 of the CPU's I register (the board decodes it).
      if (line === VBLANK_LINE) { this.render(); if (this.cpu.i & 1) this.cpu.nmi(); }
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, ram = this.ram, bank = (ram[0xC03] & 8) << 1;

    // Background bitmap, scrolled; position byte 1 of zero blanks it.
    if (ram[0xC01] === 0) out.fill(this.bgPal[bank]);
    else {
      const sx = 200 - ram[0xC00] - 256 * (ram[0xC02] & 1), sy = 2 * (256 - ram[0xC01]);
      for (let y = 0; y < H; y++) {
        const by = (y + TOP - sy) & 511, row = (by >> 2) * 64;
        for (let x = 0; x < W; x++) {
          const bx = (x - sx) & 511;
          out[y * W + x] = this.bgPal[bank | (this.bitmap[row + (bx >> 3)] & 15)];
        }
      }
    }

    // Sprites, first to last: x, y, code/flip, attributes (code bits, flip, color).
    const pbank = (ram[0xC03] & 7) * 8;
    for (let offs = 0xC04; offs < 0xE80; offs += 4) {
      if (!ram[offs]) continue;
      const b2 = ram[offs + 2], b3 = ram[offs + 3];
      const code = ((b2 & 0x7F) + ((b3 & 0x10) << 3) + ((b3 & 0x04) << 6)) ^ 0x1FF;
      const col = ((b3 & 7) + pbank) * 4, flipX = b2 & 0x80, flipY = b3 & 0x08;
      const sx = 2 * ram[offs] - 8, sy = 2 * (256 - ram[offs + 1]) - TOP;
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        const src = code * 256 + (flipY ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= W) continue;
          const pen = this.spritePix[src + (flipX ? 15 - x : x)];
          if (pen) out[py * W + px] = this.spritePal[col + pen];
        }
      }
    }

    // Text: 8x8 characters doubled to 16x16; pen 0 see-through.
    const vram = this.vram;
    for (let row = 2; row < 30; row++) {
      for (let c = 0; c < 32; c++) {
        const i = row * 32 + c, src = vram[i] * 64, ink = this.charPal[vram[0x400 + i] & 15];
        for (let y = 0; y < 16; y++) {
          const o = (row * 16 + y - TOP) * W + c * 16, srow = src + (y >> 1) * 8;
          for (let x = 0; x < 16; x++) if (this.charPix[srow + (x >> 1)]) out[o + x] = ink;
        }
      }
    }
  }
}

Popeye.id = 'popeye';
Popeye.title = 'Popeye';
Popeye.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x03], ['2', 0x02], ['3', 0x01], ['4', 0x00]], default: 0x01 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x0C], ['Medium', 0x08], ['Hard', 0x04], ['Hardest', 0x00]], default: 0x0C },
  { id: 'bonus', label: 'Bonus', options: [['40K', 0x30], ['60K', 0x20], ['80K', 0x10], ['None', 0x00]], default: 0x30 },
];
