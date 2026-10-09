// Universal Lady Bug (1981): a Z80 at 4 MHz, one 32x32 layer of 8x8 tiles,
// 8x8 and 16x16 sprites, and two SN76489 sound chips. There's no vblank
// interrupt (the program polls vblank on IN1); a coin causes an NMI.
//
// 60 Hz; the visible picture is 240x192 on a vertical monitor mounted
// counter-clockwise (the same raster as Mr. Do!, Universal's next game).

import { Z80 } from './z80.js';
import { SN76489 } from './sn76489.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, rotate270, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const NATIVE_W = 240, NATIVE_H = 192, LEFT = 8, TOP = 32;   // visible window of the 256x256 raster
const LINES = 262, LINE_CYCLES = 4000000 / 60 / LINES, VBLANK_LINE = 224;
const SAMPLES_PER_LINE = 48000 / 60 / LINES;

const STATE = ['ram', 'vram', 'sprites', 'cycleCarry', 'sampleCarry', 'line', 'in0', 'coinWas', 'cpu', 'sound'];

// Bit order reversed: the lookup PROM's nibbles are wired backwards.
const rev4 = (v) => ((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3);

export class LadyBug {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 24K, chars 8K, sprites 8K, palette 32, spriteLut 32 }
  constructor(roms) {
    this.width = NATIVE_H;
    this.height = NATIVE_W;
    this.refresh = 60;
    this.controls = 'four-way';
    this.buttons = 0;
    this.roms = roms;
    this.ram = new Uint8Array(0x1000);         // 6000-6FFF
    this.vram = new Uint8Array(0x800);         // D000-D3FF codes, D400-D7FF colors
    this.sprites = new Uint8Array(0x400);      // 7000-73FF
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sn = [new SN76489(4000000), new SN76489(4000000)];
    this.sound = new SoundMix(this.sn, 1.2);
    this.frame = new Uint32Array(this.width * this.height);
    this.native = new Uint32Array(NATIVE_W * NATIVE_H);

    this.charPix = decodeTiles(roms.chars, {
      count: 512, width: 8, height: 8, planes: [0, 512 * 64], xs: run(7, 8, -1), ys: run(0, 8, 8), size: 64,
    });
    // Sprites store their two planes in adjacent bits, rows bottom to top.
    this.bigPix = decodeTiles(roms.sprites, {
      count: 128, width: 16, height: 16, planes: [1, 0],
      xs: [...run(0, 8, 2), ...run(128, 8, 2)], ys: [...run(23 * 16, 8, -16), ...run(7 * 16, 8, -16)], size: 512,
    });
    this.smallPix = decodeTiles(roms.sprites, {
      count: 512, width: 8, height: 8, planes: [1, 0], xs: run(0, 8, 2), ys: run(7 * 16, 8, -16), size: 128,
    });
    // Palette PROM (inverted): red bits 0/5, green 2/6, blue 4/7.
    this.palette = Uint32Array.from(roms.palette, (p) => {
      const v = ~p, c = (lo, hi) => 0x47 * ((v >> lo) & 1) + 0x97 * ((v >> hi) & 1);
      return rgba(c(0, 5), c(2, 6), c(4, 7));
    });
    // Sprite colors 0-7 come from the lookup PROM's low nibbles, 8-15 the high ones.
    this.spriteLut = Uint8Array.from({ length: 64 }, (_, i) =>
      i < 32 ? rev4(roms.spriteLut[i] & 15) : rev4(roms.spriteLut[i - 32] >> 4));
    this.in0 = 0xFF; this.coin = false;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.sprites.fill(0);
    this.cpu.reset();
    this.sound.reset();
    this.cycleCarry = this.sampleCarry = 0;
    this.line = 0;
    this.coinWas = false;
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x6000) return this.roms.main[a];
    if (a < 0x7000) return this.ram[a - 0x6000];
    if (a >= 0xD000 && a < 0xD800) return this.vram[a - 0xD000];
    switch (a) {
      case 0x9000: return this.in0;
      case 0x9001: return 0x3F | (this.line >= VBLANK_LINE ? 0x80 : 0x40);   // two vblank bits, opposite senses
      case 0x9002: return this.dsw0;
      case 0x9003: return this.dsw1;
      case 0xE000: return 0xFF;
    }
    return a >= 0x8000 && a < 0x9000 ? 0 : 0xFF;
  }

  write(a, v) {
    if (a >= 0x6000 && a < 0x7000) this.ram[a - 0x6000] = v;
    else if (a >= 0x7000 && a < 0x7400) this.sprites[a - 0x7000] = v;
    else if (a >= 0xD000 && a < 0xD800) this.vram[a - 0xD000] = v;
    else if (a >= 0xB000 && a < 0xC000) this.sn[0].write(v);
    else if (a >= 0xC000 && a < 0xD000) this.sn[1].write(v);
    // A000 flip screen: upright only.
  }

  // ---------------------------------------------------------------- inputs

  // IN0 (active low): left, down, right, up, -, start 1, start 2.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.left ? 0x01 : 0) | (s.down ? 0x02 : 0) | (s.right ? 0x04 : 0) | (s.up ? 0x08 : 0)
      | (s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0));
    this.coin = !!s.coin;
  }

  // DSW0: difficulty, 10-letter names, rack test off, freeze off, upright,
  // no free play, lives. DSW1: 1 coin 1 credit for both slots.
  applySwitches(v) {
    this.dsw0 = v.difficulty | 0x04 | 0x08 | 0x10 | 0x40 | v.lives;
    this.dsw1 = 0xFF;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    // A coin pulses the NMI once per insertion.
    if (this.coin && !this.coinWas) this.cpu.nmi();
    this.coinWas = this.coin;
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      if (line === VBLANK_LINE) this.render();
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, vram = this.vram, pal = this.palette;
    // Tiles: code plus bank (color bit 3), 8 colors whose pens 1-3 pick
    // palette entries 8, 16 and 24 up. Each tile row can scroll sideways by
    // a value kept in the (offscreen) top rows of video RAM.
    for (let y = 0; y < NATIVE_H; y++) {
      const ty = y + TOP, row = ty >> 3;
      const scroll = vram[32 * (row & 3) + (row >> 2)];
      for (let x = 0; x < NATIVE_W; x++) {
        const tx = (x + LEFT - scroll) & 0xFF;
        const i = row * 32 + (tx >> 3), color = vram[0x400 + i];
        const pen = this.charPix[(vram[i] + ((color & 8) << 5)) * 64 + (ty & 7) * 8 + (tx & 7)];
        out[y * NATIVE_W + x] = pal[pen ? (color & 7) + 8 * pen : 0];
      }
    }

    // Sprites: 14 blocks of up to 16 entries, one block per 16 lines; each
    // block's list ends at the first empty entry and is drawn last to first.
    // Entry: enable/size/flips/y offset, code, bank/color, x.
    const spr = this.sprites;
    for (let offs = 0x380; offs >= 0x80; offs -= 0x40) {
      let n = 0;
      while (n < 0x40 && spr[offs + n]) n += 4;
      while (n > 0) {
        n -= 4;
        const b0 = spr[offs + n], b1 = spr[offs + n + 1], b2 = spr[offs + n + 2], b3 = spr[offs + n + 3];
        if (!(b0 & 0x80)) continue;
        const big = b0 & 0x40, size = big ? 16 : 8, flipX = b0 & 0x20, flipY = b0 & 0x10;
        const code = big ? (b1 >> 2) + 4 * (b2 & 0x10) : b1 + 16 * (b2 & 0x10);
        const pix = big ? this.bigPix : this.smallPix, color = (b2 & 15) * 4;
        const sx = b3 - LEFT, sy = offs / 4 - (big ? 8 : 0) + (b0 & 15) - TOP;
        for (let y = 0; y < size; y++) {
          const py = sy + y;
          if (py < 0 || py >= NATIVE_H) continue;
          const src = code * size * size + (flipY ? size - 1 - y : y) * size;
          for (let x = 0; x < size; x++) {
            const px = sx + x;
            if (px < 0 || px >= NATIVE_W) continue;
            const pen = pix[src + (flipX ? size - 1 - x : x)];
            if (pen) out[py * NATIVE_W + px] = pal[this.spriteLut[color + pen]];
          }
        }
      }
    }

    rotate270(out, NATIVE_W, NATIVE_H, this.frame);
  }
}

LadyBug.id = 'ladybug';
LadyBug.title = 'Lady Bug';
LadyBug.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x80], ['5', 0x00]], default: 0x80 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x03], ['Med', 0x02], ['Hard', 0x01], ['Hardest', 0x00]], default: 0x03 },
];
