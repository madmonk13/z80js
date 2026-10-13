// Konami Green Beret / Rush'n Attack (1985) and Mr. Goemon (1986): one Z80
// at 3 MHz, one SN76489, a 64x32 map of 8x8 tiles that scrolls row by row
// (the playfield; its tiles draw over the sprites unless marked to stay
// behind), and 48 sprites of 16x16, double-buffered. All graphics are 4 bits per pixel
// through color lookup PROMs into a 32-color palette PROM.
//
// Interrupts come from a custom chip: one IRQ a frame and a stream of NMIs
// (16 a frame on Green Beret's 30 Hz timing, 8 on Mr. Goemon's 60 Hz). Mr.
// Goemon also banks 2K of extra ROM in at F800.

import { Z80 } from './z80.js';
import { SN76489 } from './sn76489.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const CLOCK = 18432000 / 6;
const W = 240, H = 224, LEFT = 8, TOP = 16;     // visible area of the 256x256 screen
const STATE = ['ram', 'scroll', 'spriteBank', 'control', 'romBank', 'cycleCarry', 'sampleCarry', 'in0', 'in2', 'cpu', 'sound'];

export class GreenBeret {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (0000-BFFF, plus banked 10000+ on Mr. Goemon), chars 16K, sprites 64K, palette 32, sprLut 256, charLut 256 }
  constructor(roms) {
    this.width = W;
    this.height = H;
    const cfg = this.constructor.config;
    this.refresh = cfg.refresh;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = cfg.button2;
    this.roms = roms;
    this.ram = new Uint8Array(0x2000);         // C000-DFFF: colors, codes, sprites, work RAM
    this.scroll = new Uint8Array(0x40);        // E000-E03F: per-row scroll, low then high bytes
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.sn = new SN76489(18432000 / 12);
    this.sound = new SoundMix([this.sn], 1.3);

    // Both layers pack the four bitplanes in each nibble.
    this.charPix = decodeTiles(roms.chars, { count: 512, width: 8, height: 8, planes: [0, 1, 2, 3], xs: run(0, 8, 4), ys: run(0, 8, 32), size: 256 });
    this.spritePix = decodeTiles(roms.sprites, {
      count: 512, width: 16, height: 16, planes: [0, 1, 2, 3],
      xs: [...run(0, 8, 4), ...run(256, 8, 4)], ys: [...run(0, 8, 32), ...run(512, 8, 32)], size: 1024,
    });
    // Palette PROM: red bits 0-2, green 3-5, blue 6-7.
    const lvl = (b0, b1, b2) => 0x21 * b0 + 0x47 * b1 + 0x97 * b2;
    this.palette = Uint32Array.from(roms.palette, (v) =>
      rgba(lvl(v & 1, (v >> 1) & 1, (v >> 2) & 1), lvl((v >> 3) & 1, (v >> 4) & 1, (v >> 5) & 1), lvl(0, (v >> 6) & 1, (v >> 7) & 1)));
    // Lookups: sprites use palette 0-15 (0 = see-through), characters 16-31.
    this.sprLut = Uint8Array.from(roms.sprLut, (v) => v & 15);
    this.charLut = Uint8Array.from(roms.charLut, (v) => (v & 15) + 16);
    this.frame = new Uint32Array(W * H);
    this.front = new Uint8Array(W * H);
    this.in0 = this.in2 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.scroll.fill(0);
    this.spriteBank = 0; this.control = 0; this.romBank = 0;
    this.cycleCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0xC000) return this.roms.main[a];
    if (a < 0xE000) return this.ram[a - 0xC000];
    if (a < 0xE040) return this.scroll[a - 0xE000];
    if (a >= 0xF800 && this.constructor.config.banked) return this.roms.main[0x10000 + this.romBank * 0x800 + (a - 0xF800)];
    switch (a) {
      case 0xF200: return this.dsw1;
      case 0xF400: return this.dsw2;
      case 0xF600: return this.dsw0;
      case 0xF601: return 0xFF;                   // player 2
      case 0xF602: return this.in0;
      case 0xF603: return this.in2;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0xC000 && a < 0xE000) { this.ram[a - 0xC000] = v; return; }
    if (a >= 0xE000 && a < 0xE040) { this.scroll[a - 0xE000] = v; return; }
    switch (a) {
      case 0xE043: this.spriteBank = v; return;
      case 0xE044: this.control = v; return;      // NMI enable (bit 0), IRQ enable, flip screen
      case 0xF000: if (this.constructor.config.banked) this.romBank = v >> 5; return;   // coin counters; Mr. Goemon's ROM bank in bits 5-7
      case 0xF400: this.sn.write(v); return;
    }
    // F200 sound latch (unused), F600 watchdog.
  }

  // ---------------------------------------------------------------- inputs

  // Active low. IN0: left, right, up, down, button 1, button 2. IN2: coin, start 1, start 2.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.left ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.up ? 0x04 : 0) | (s.down ? 0x08 : 0)
      | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0));
    this.in2 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
  }
  // DSW0 1 coin 1 credit; DSW1 lives, upright, bonus, difficulty, demo sounds; DSW2 no flip, single controls.
  applySwitches(v) { this.dsw0 = 0xFF; this.dsw1 = v.lives | v.bonus | v.difficulty; this.dsw2 = 0xFF; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const cfg = this.constructor.config, slices = cfg.slices;
    const sliceCycles = CLOCK / this.refresh / slices, sliceSamples = 48000 / this.refresh / slices;
    for (let k = 0; k < slices; k++) {
      // Slice 0 brings the IRQ (and the picture); every odd slice an NMI.
      if (k === 0) { this.render(); if (this.control & cfg.irqBit) this.cpu.irq = true; }
      if ((k & 1) && (this.control & 1)) this.cpu.nmi();
      this.cycleCarry += sliceCycles;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += sliceSamples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, front = this.front, ram = this.ram, pal = this.palette, lut = this.charLut;
    front.fill(0);
    // The playfield: 64x32 tiles, each 8-pixel row scrolled on its own.
    for (let y = 0; y < H; y++) {
      const sy = y + TOP, row = sy >> 3;
      const scroll = this.scroll[row] | (this.scroll[row | 0x20] << 8);
      for (let x = 0; x < W; x++) {
        const sx = (x + LEFT + scroll) & 511;
        const i = row * 64 + (sx >> 3), attr = ram[i];
        const code = ram[0x800 + i] + ((attr & 0x40) << 2);
        const px = attr & 0x10 ? 7 - (sx & 7) : sx & 7, py = attr & 0x20 ? 7 - (sy & 7) : sy & 7;
        const c = lut[(attr & 15) * 16 + this.charPix[code * 64 + py * 8 + px]];
        out[y * W + x] = pal[c];
        if (!(attr & 0x80) && c !== 0x10) front[y * W + x] = 1;     // tiles without bit 7 cover the sprites, except their see-through color
      }
    }
    // Sprites: 48, from the bank picked by bit 3 of E043; Y of 0 means unused.
    const base = this.spriteBank & 8 ? 0x1000 : 0x1100;
    for (let offs = 0; offs < 0xC0; offs += 4) {
      const sy = ram[base + offs + 3];
      if (!sy) continue;
      const attr = ram[base + offs + 1];
      const code = ram[base + offs] + ((attr & 0x40) << 2), color = (attr & 15) * 16;
      const sx = ram[base + offs + 2] - 2 * (attr & 0x80) - LEFT, top = sy - TOP;
      const flipX = attr & 0x10, flipY = attr & 0x20;
      for (let y = 0; y < 16; y++) {
        const py = top + y;
        if (py < 0 || py >= H) continue;
        const src = code * 256 + (flipY ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= W) continue;
          const c = this.sprLut[color + this.spritePix[src + (flipX ? 15 - x : x)]];
          if (c && !front[py * W + px]) out[py * W + px] = pal[c];
        }
      }
    }
  }
}

const SWITCHES = [
  { id: 'lives', label: 'Lives', options: [['2', 0x03], ['3', 0x02], ['5', 0x01], ['7', 0x00]], default: 0x02 },
  { id: 'bonus', label: 'Bonus life', options: [['30K, 70K', 0x18], ['40K, 80K', 0x10], ['50K, 100K', 0x08], ['50K, 200K', 0x00]], default: 0x08 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Hardest', 0x00]], default: 0x40 },
];

export class RushNAttack extends GreenBeret {}
RushNAttack.config = { refresh: 30, slices: 32, irqBit: 0x04, banked: false, button2: 'Shoot' };
RushNAttack.id = 'rushatck';
RushNAttack.title = "Rush'n Attack";
RushNAttack.switches = SWITCHES;

export class GreenBeretJ extends GreenBeret {}
GreenBeretJ.config = RushNAttack.config;
GreenBeretJ.id = 'gberet';
GreenBeretJ.title = 'Green Beret';
GreenBeretJ.switches = SWITCHES;

export class MrGoemon extends GreenBeret {}
MrGoemon.config = { refresh: 60, slices: 16, irqBit: 0x02, banked: true, button2: 'Jump' };
MrGoemon.id = 'mrgoemon';
MrGoemon.title = 'Mr. Goemon';
MrGoemon.switches = SWITCHES;
