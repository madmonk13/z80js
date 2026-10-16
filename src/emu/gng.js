// Capcom Ghosts'n Goblins (1985): a Motorola 6809 at 1.5 MHz with banked
// ROM, a 32x32 layer of 16x16 background tiles (3 bits per pixel) that
// scrolls both ways, 128 sprites of 16x16 at 4 bits per pixel (from a copy
// of sprite RAM taken each frame), and a layer of 8x8 text on top. Each
// background tile is split in two by priority: some of its colors draw in
// front of the sprites (gravestones, ladders, foliage). Sound: a Z80 at
// 3 MHz with two YM2203s.
//
// 60 Hz; the visible picture is 256x224 on a horizontal monitor.

import { M6809 } from './m6809.js';
import { Z80 } from './z80.js';
import { YM2203 } from './ym2203.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16;
const LINES = 262, LINE_CYCLES = 1500000 / 60 / LINES, SOUND_LINE_CYCLES = 3000000 / 60 / LINES;
const SAMPLES_PER_LINE = 48000 / 60 / LINES;
const STATE = ['ram', 'palLo', 'palHi', 'bank', 'scrollX', 'scrollY', 'latch', 'soundRam', 'spriteBuf',
  'cycleCarry', 'soundCarry', 'sampleCarry', 'in0', 'in1', 'cpu', 'snd', 'sound'];

export class GhostsNGoblins {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 256; i++) this.setColor(i); }

  // roms: { main (0x18000 region), sound 32K, chars 16K, tiles 96K, sprites 128K }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = 60;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Jump';
    this.roms = roms;
    this.ram = new Uint8Array(0x3000);         // 0000-2FFF: work RAM, sprites at 1E00, text 2000, background 2800
    this.palLo = new Uint8Array(256);          // 3900: BBBB....
    this.palHi = new Uint8Array(256);          // 3800: RRRRGGGG
    this.palette = new Uint32Array(256).fill(0xFF000000);
    this.soundRam = new Uint8Array(0x800);
    this.spriteBuf = new Uint8Array(0x200);

    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.ym = [new YM2203(1500000, 1), new YM2203(1500000, 1)];
    this.sound = new SoundMix(this.ym, 0.7);

    this.charPix = decodeTiles(roms.chars, { count: 1024, width: 8, height: 8, planes: [4, 0], xs: [0, 1, 2, 3, 8, 9, 10, 11], ys: run(0, 8, 16), size: 128 });
    const third = roms.tiles.length / 3 * 8;
    this.tilePix = decodeTiles(roms.tiles, {
      count: 1024, width: 16, height: 16, planes: [third * 2, third, 0], xs: [...run(0, 8), ...run(128, 8)], ys: run(0, 16, 8), size: 256,
    });
    const half = roms.sprites.length / 2 * 8;
    this.spritePix = decodeTiles(roms.sprites, {
      count: 1024, width: 16, height: 16, planes: [half + 4, half, 4, 0],
      xs: [0, 1, 2, 3, 8, 9, 10, 11, 256, 257, 258, 259, 264, 265, 266, 267], ys: run(0, 16, 16), size: 512,
    });
    this.frame = new Uint32Array(W * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.palLo.fill(0); this.palHi.fill(0); this.soundRam.fill(0); this.spriteBuf.fill(0);
    this.palette.fill(0xFF000000);
    this.bank = 0; this.scrollX = 0; this.scrollY = 0; this.latch = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
  }

  setColor(i) { const lo = this.palLo[i], hi = this.palHi[i]; this.palette[i] = rgba((hi >> 4) * 17, (hi & 15) * 17, (lo >> 4) * 17); }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x3000) return this.ram[a];
    if (a >= 0x6000) return this.roms.main[a];
    if (a >= 0x4000) return this.bank === 4 ? this.roms.main[a] : this.roms.main[0x10000 + this.bank * 0x2000 + (a - 0x4000)];
    switch (a) {
      case 0x3000: return this.in0;
      case 0x3001: return this.in1;
      case 0x3002: return 0xFF;
      case 0x3003: return this.dsw0;
      case 0x3004: return this.dsw1;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a < 0x3000) { this.ram[a] = v; return; }
    if (a >= 0x3800 && a < 0x3900) { this.palHi[a & 0xFF] = v; this.setColor(a & 0xFF); return; }
    if (a >= 0x3900 && a < 0x3A00) { this.palLo[a & 0xFF] = v; this.setColor(a & 0xFF); return; }
    switch (a) {
      case 0x3A00: this.latch = v; break;
      case 0x3B08: this.scrollX = (this.scrollX & 0xFF00) | v; break;
      case 0x3B09: this.scrollX = (this.scrollX & 0xFF) | (v << 8); break;
      case 0x3B0A: this.scrollY = (this.scrollY & 0xFF00) | v; break;
      case 0x3B0B: this.scrollY = (this.scrollY & 0xFF) | (v << 8); break;
      case 0x3E00: this.bank = v === 4 ? 4 : v & 3; break;
      // 3C00 watchdog, 3D00 flip screen, 3D02-3D03 coin counters.
    }
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a >= 0xC000 && a < 0xC800) return this.soundRam[a - 0xC000];
    if (a === 0xC800) return this.latch;
    if (a >= 0xE000 && a < 0xE004) return a & 1 ? this.ym[(a >> 1) & 1].read() : this.ym[(a >> 1) & 1].status();
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0xC000 && a < 0xC800) { this.soundRam[a - 0xC000] = v; return; }
    if (a >= 0xE000 && a < 0xE004) { const chip = this.ym[(a >> 1) & 1]; if (a & 1) chip.write(v); else chip.select(v); }
  }

  // ---------------------------------------------------------------- inputs

  // Active low. IN0: start 1, start 2, coin. IN1: right, left, down, up, fire, jump.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.start1 ? 0x01 : 0) | (s.start2 ? 0x02 : 0) | (s.coin ? 0x40 : 0));
    this.in1 = 0xFF & ~((s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.down ? 0x04 : 0) | (s.up ? 0x08 : 0) | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0));
  }
  // DSW0: 1 coin 1 credit, demo sounds, service off, no flip. DSW1: lives, upright, bonus, difficulty.
  applySwitches(v) {
    this.dsw0 = 0xDF;
    this.dsw1 = v.lives | v.bonus | v.difficulty | 0x80;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === 240) { this.render(); this.spriteBuf.set(this.ram.subarray(0x1E00, 0x2000)); this.cpu.irq = true; }
      if (line === 241) this.cpu.irq = false;            // held long enough to be taken
      if (line % 66 === 0) this.snd.irq = true;           // four a frame
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.soundCarry += SOUND_LINE_CYCLES;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, ram = this.ram, pal = this.palette;
    // Background (32x32 tiles of 16x16, stored a column at a time): attribute
    // bits 7-6 code high, 5/4 flips, 3 priority split, 2-0 color.
    // A 16-pixel tile run at a time; each pixel's color is kept for the pass over the sprites.
    const front = this.front || (this.front = new Uint8Array(W * H)), bgCol = this.bgCol || (this.bgCol = new Uint32Array(W * H));
    front.fill(0);
    for (let y = 0; y < H; y++) {
      const by = (y + TOP + this.scrollY) & 0x1FF;
      for (let x = 0; x < W;) {
        const bx = (x + this.scrollX) & 0x1FF, n = Math.min(16 - (bx & 15), W - x);
        const i = (bx >> 4) * 32 + (by >> 4), attr = ram[0x2C00 + i];
        const py = attr & 0x20 ? 15 - (by & 15) : by & 15, src = (ram[0x2800 + i] + ((attr & 0xC0) << 2)) * 256 + py * 16;
        const cb = (attr & 7) * 8, split = attr & 0x08, o = y * W + x;
        for (let k = 0; k < n; k++) {
          const c = (bx + k) & 15, pen = this.tilePix[src + (attr & 0x10 ? 15 - c : c)], col = pal[cb + pen];
          out[o + k] = col; bgCol[o + k] = col;
          // Split type 1: all but colors 0 and 6 draw in front of the sprites.
          if (split && pen !== 0 && pen !== 6) front[o + k] = 1;
        }
        x += n;
      }
    }
    // Sprites, last to first, from last frame's copy: code, attributes
    // (code bits 9-8, color, flips, x bit 8), y, x. Pen 15 is see-through.
    const spr = this.spriteBuf;
    for (let offs = 0x1FC; offs >= 0; offs -= 4) {
      const attr = spr[offs + 1];
      const code = spr[offs] + ((attr << 2) & 0x300), color = 0x40 + ((attr >> 4) & 3) * 16;
      const sx = spr[offs + 3] - 0x100 * (attr & 1), sy = spr[offs + 2] - TOP;
      const flipX = attr & 0x04, flipY = attr & 0x08;
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        const row = code * 256 + (flipY ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= W) continue;
          const pen = this.spritePix[row + (flipX ? 15 - x : x)];
          if (pen !== 15) out[py * W + px] = pal[color + pen];
        }
      }
    }
    // The front half of the background over the sprites.
    for (let i = 0; i < W * H; i++) if (front[i]) out[i] = bgCol[i];
    // Text: code bits 9-8, flips and color in the attribute byte; pen 3 see-through.
    for (let row = 2; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const i = row * 32 + col, attr = ram[0x2400 + i];
        const src = (ram[0x2000 + i] + ((attr & 0xC0) << 2)) * 64, color = 0x80 + (attr & 15) * 4;
        for (let y = 0; y < 8; y++) {
          const sy = attr & 0x20 ? 7 - y : y;
          let o = (row * 8 + y - TOP) * W + col * 8;
          for (let x = 0; x < 8; x++, o++) {
            const pen = this.charPix[src + sy * 8 + (attr & 0x10 ? 7 - x : x)];
            if (pen !== 3) out[o] = pal[color + pen];
          }
        }
      }
    }
  }
}

GhostsNGoblins.id = 'gng';
GhostsNGoblins.title = "Ghosts'n Goblins";
GhostsNGoblins.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x03], ['4', 0x02], ['5', 0x01], ['7', 0x00]], default: 0x03 },
  { id: 'bonus', label: 'Bonus', options: [['20K/70K', 0x18], ['30K/80K', 0x10], ['20K/80K', 0x08], ['30K/80K once', 0x00]], default: 0x18 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x40], ['Normal', 0x60], ['Difficult', 0x20], ['Very difficult', 0x00]], default: 0x60 },
];
