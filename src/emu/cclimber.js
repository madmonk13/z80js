// Nichibutsu Crazy Climber (1980): a Z80 at 3.072 MHz with encrypted opcodes,
// a 32x32 tile layer whose columns scroll up and down on their own, eight
// 16x16 sprites, and a "big sprite" (16x16 tiles of its own, the giant gorilla
// or the helicopter) above or below them. An AY-3-8910 plays the music; its
// port A picks one of the 4-bit voice samples ("Ohhh!", "Ganbare!") that a
// separate circuit plays at a rate and volume the CPU sets.
//
// The climber has two arms on two sticks: push them up one after the other to
// climb. With only one stick in use, up and down alternate the arms for you.
// 256x224 on a horizontal monitor at 60 Hz.

import { Z80 } from './z80.js';
import { AY8910 } from './ay8910.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, promPalette, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16, LINES = 264, REFRESH = 60;
const LINE_CYCLES = 3072000 / REFRESH / LINES, SAMPLES_PER_LINE = RATE / REFRESH / LINES;
const STATE = ['ram', 'video', 'bigVideo', 'regs', 'color', 'nmiOn', 'cycleCarry', 'sampleCarry', 'in0', 'in2', 'climb',
  'cpu', 'ay', 'voice'];

// Opcode decryption: each opcode byte keeps bits 1, 3, 5 and 7; bits 0, 2, 4
// and 6 come from a table picked by address bit 0 and data bits 1 and 7,
// indexed by those same four bits.
const CONV = [
  [0x44, 0x14, 0x54, 0x10, 0x11, 0x41, 0x05, 0x50, 0x51, 0x00, 0x40, 0x55, 0x45, 0x04, 0x01, 0x15],
  [0x44, 0x10, 0x15, 0x55, 0x00, 0x41, 0x40, 0x51, 0x14, 0x45, 0x11, 0x50, 0x01, 0x54, 0x04, 0x05],
  [0x45, 0x10, 0x11, 0x44, 0x05, 0x50, 0x51, 0x04, 0x41, 0x14, 0x15, 0x40, 0x01, 0x54, 0x55, 0x00],
  [0x04, 0x51, 0x45, 0x00, 0x44, 0x10, 0x00, 0x55, 0x11, 0x54, 0x50, 0x40, 0x05, 0x00, 0x14, 0x01],
  [0x54, 0x51, 0x15, 0x45, 0x44, 0x01, 0x11, 0x41, 0x04, 0x55, 0x50, 0x00, 0x00, 0x10, 0x40, 0x00],
  [0x00, 0x54, 0x14, 0x50, 0x51, 0x01, 0x00, 0x40, 0x41, 0x10, 0x00, 0x55, 0x05, 0x44, 0x11, 0x45],
  [0x51, 0x04, 0x10, 0x00, 0x50, 0x40, 0x00, 0x00, 0x41, 0x01, 0x05, 0x15, 0x11, 0x14, 0x44, 0x54],
  [0x00, 0x00, 0x54, 0x01, 0x15, 0x40, 0x45, 0x41, 0x51, 0x04, 0x50, 0x05, 0x11, 0x44, 0x10, 0x14],
];
function decryptOpcodes(rom) {
  return rom.map((v, a) => {
    const t = (a & 1) | (v & 0x02) | ((v & 0x80) >> 5);
    const i = (v & 0x01) | ((v & 0x04) >> 1) | ((v & 0x10) >> 2) | ((v & 0x40) >> 3);
    return (v & 0xAA) | CONV[t][i];
  });
}

// The sample player: 4-bit samples, two to a byte (high nibble first), ending at a 0x70 byte.
class Voice {
  constructor(rom) { this.rom = rom; this.reset(); }
  reset() { this.select = 0; this.rate = 0; this.volume = 0; this.pos = -1; this.step = 0; this.frac = 0; this.level = 0; this.out = 0; }
  saveState() { const { rom, ...s } = this; return s; }
  loadState(s) { Object.assign(this, s); }
  trigger() {
    this.pos = this.select * 64;                       // in nibbles
    this.level = this.volume / 31;
    this.step = 3072000 / 4 / (256 - this.rate) / RATE;
    this.frac = 0;
  }
  sample() {
    if (this.pos < 0) { this.out = 0; return; }
    const b = this.rom[this.pos >> 1];
    if (b === undefined || b === 0x70) { this.pos = -1; this.out = 0; return; }
    const n = this.pos & 1 ? b & 0x0F : b >> 4;
    this.out = ((n - 7.5) / 7.5) * this.level * 0.5;
    this.frac += this.step;
    while (this.frac >= 1) { this.frac -= 1; this.pos++; }
  }
}

export class CrazyClimber {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 20K (encrypted), gfx 16K (two tile/sprite sets), big 4K, palette 96, samples 8K }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 0;
    this.twinStick = true;                             // a stick for each arm
    this.roms = roms;
    this.ops = decryptOpcodes(roms.main);
    this.ram = new Uint8Array(0x400);                  // 8000-83FF
    this.video = new Uint8Array(0x400);                // 9000-93FF (mirrored at 9400)
    this.bigVideo = new Uint8Array(0x400);             // 8800-8BFF: the big sprite's tiles (first 256)
    this.regs = new Uint8Array(0x400);                 // 9800-9BFF: column scroll, sprites, big sprite registers
    this.color = new Uint8Array(0x400);                // 9C00-9FFF (two rows share each line)
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v), opRead: (a) => (a < 0x6000 ? this.ops[a] ?? 0xFF : this.read(a)),
      input: (p) => ((p & 0xFF) === 0x0C ? this.ay.read() : 0xFF), output: (p, v) => this.port(p & 0xFF, v) });
    this.ay = new AY8910(1536000);
    this.voice = new Voice(roms.samples);
    this.ay.portOut = (n, v) => { if (n === 0) this.voice.select = v; };
    this.sound = new SoundMix([this.ay, this.voice], 1);
    this.frame = new Uint32Array(W * H);

    const tiles = (base) => decodeTiles(roms.gfx, { count: 256, width: 8, height: 8, planes: [0, 0x1000 * 8], xs: run(0, 8), ys: run(0, 8, 8), size: 64, base: base * 8 });
    const sprites = (base) => decodeTiles(roms.gfx, {
      count: 64, width: 16, height: 16, planes: [0, 0x1000 * 8], xs: [...run(0, 8), ...run(64, 8)], ys: [...run(0, 8, 8), ...run(128, 8, 8)], size: 256, base: base * 8,
    });
    this.tilePix = [tiles(0), tiles(0x2000)];
    this.spritePix = [sprites(0), sprites(0x2000)];
    this.bigPix = decodeTiles(roms.big, { count: 256, width: 8, height: 8, planes: [0, 0x800 * 8], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    this.palette = promPalette(roms.palette, 96, [0x47, 0x97]);
    this.in0 = 0; this.in2 = 0x10;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.video, this.bigVideo, this.regs, this.color]) a.fill(0);
    this.nmiOn = false; this.climb = 0;
    this.cycleCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x6000) return this.roms.main[a] ?? 0xFF;
    if (a >= 0x8000 && a < 0x8400) return this.ram[a - 0x8000];
    if (a >= 0x8800 && a < 0x8C00) return this.bigVideo[a - 0x8800];
    if (a >= 0x9000 && a < 0x9800) return this.video[a & 0x3FF];
    if (a >= 0x9800 && a < 0x9C00) return this.regs[a - 0x9800];
    if (a >= 0x9C00 && a < 0xA000) return this.color[a - 0x9C00];
    switch (a & 0xF800) {
      case 0xA000: return this.in0;
      case 0xA800: return 0;                           // player 2 (cocktail)
      case 0xB000: return this.dsw;
      case 0xB800: return this.in2;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0x8400) this.ram[a - 0x8000] = v;
    else if (a >= 0x8800 && a < 0x8C00) this.bigVideo[a - 0x8800] = v;
    else if (a >= 0x9000 && a < 0x9800) this.video[a & 0x3FF] = v;
    else if (a >= 0x9800 && a < 0x9C00) this.regs[a - 0x9800] = v;
    else if (a >= 0x9C00 && a < 0xA000) { const o = (a - 0x9C00) & ~0x20; this.color[o] = this.color[o + 0x20] = v; }
    else if (a === 0xA000) this.nmiOn = !!(v & 1);
    else if (a === 0xA004) { if (v) this.voice.trigger(); }
    else if (a === 0xA800) this.voice.rate = v;
    else if (a === 0xB000) this.voice.volume = v & 0x1F;
    // A001/A002: flip screen (cocktail only)
  }

  port(p, v) {
    if (p === 0x08) this.ay.select(v);
    else if (p === 0x09) this.ay.write(v);
  }

  // ---------------------------------------------------------------- inputs

  // Active high. IN0: left stick up, down, left, right, then the right stick. IN2: coin, start 1, start 2, upright.
  setInputs(s) {
    const a = s.aim || {}, aiming = a.up || a.down || a.left || a.right;
    const stick = (u, d, l, r) => (u ? 1 : 0) | (d ? 2 : 0) | (l ? 4 : 0) | (r ? 8 : 0);
    let left = stick(s.up, s.down, s.left, s.right), right;
    if (aiming) right = stick(a.up, a.down, a.left, a.right);
    else if (s.up || s.down) {
      // One stick climbing: one arm reaches while the other pulls, swapping every few frames.
      const phase = (this.climb >> 3) & 1, reach = s.up ? 1 : 2, pull = s.up ? 2 : 1;
      left = (phase ? reach : pull) | (left & 0x0C);
      right = (phase ? pull : reach) | (left & 0x0C);
    } else right = left;
    this.in0 = left | (right << 4);
    this.in2 = 0x10 | (s.coin ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0);
  }

  // DSW: lives, 1 coin 1 credit both slots (the B slot setting also picks the bonus).
  applySwitches(v) { this.dsw = v.lives | v.bonus; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    this.climb++;
    for (let line = 0; line < LINES; line++) {
      if (line === 240) { this.render(); if (this.nmiOn) this.cpu.nmi(); }
      this.cycleCarry += LINE_CYCLES;
      const n = Math.floor(this.cycleCarry);
      this.cycleCarry -= this.cpu.run(n);
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, pal = this.palette, regs = this.regs;
    // Tiles: bit 4 of the color picks the set, 6 and 7 flip (a vertical flip swaps a pair of rows).
    for (let x = 0; x < W; x++) {
      const col = x >> 3, scroll = regs[col];
      for (let y = 0; y < H; y++) {
        const sy = (y + TOP + scroll) & 0xFF;
        const row = sy >> 3, ty = sy & 7, tx = x & 7;
        // The rows of a pair share their colors, so a vertical flip swaps the pair's tiles.
        const c = this.color[row * 32 + col], offs = (c & 0x80 ? row ^ 1 : row) * 32 + col;
        const code = (this.video[offs] + ((c & 0x20) << 3)) & 0xFF;
        const px = c & 0x40 ? 7 - tx : tx, py = c & 0x80 ? 7 - ty : ty;
        const pen = this.tilePix[(c >> 4) & 1][code * 64 + py * 8 + px];
        out[y * W + x] = pal[pen ? (c & 0x0F) * 4 + pen : 0];
      }
    }
    const big = regs[0xDC] & 1;
    if (big) this.drawBig();
    for (let offs = 0x9C; offs >= 0x80; offs -= 4) {
      const code = regs[offs] & 0x3F, attr = regs[offs + 1], color = (attr & 0x0F) * 4;
      const sx = regs[offs + 3], sy = 240 - regs[offs + 2] - TOP;
      const pix = this.spritePix[(attr >> 4) & 1], fx = regs[offs] & 0x40, fy = regs[offs] & 0x80;
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        const src = (code * 16 + (fy ? 15 - y : y)) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px >= W) continue;
          const pen = pix[src + (fx ? 15 - x : x)];
          if (pen) out[py * W + px] = pal[color + pen];
        }
      }
    }
    if (!big) this.drawBig();
  }

  // The big sprite: 16x16 tiles of its own, wrapping around the screen, in colors 64-95.
  drawBig() {
    const regs = this.regs, out = this.frame, pal = this.palette;
    const ctl = regs[0xDD], ox = 136 - regs[0xDF], oy = 128 - regs[0xDE];
    const fx = ctl & 0x10, fy = ctl & 0x20, color = 64 + (ctl & 0x07) * 4;
    for (let offs = 0; offs < 256; offs++) {
      let tx = offs & 15, ty = offs >> 4;
      if (fx) tx = 15 - tx;
      if (fy) ty = 15 - ty;
      const code = this.bigVideo[offs], bx = (ox + 8 * tx) & 0xFF, by = ((oy + 8 * ty) & 0xFF) - TOP;
      for (let y = 0; y < 8; y++) {
        const py = by + y;
        if (py < 0 || py >= H) continue;
        const src = code * 64 + (fy ? 7 - y : y) * 8;
        for (let x = 0; x < 8; x++) {
          const pen = this.bigPix[src + (fx ? 7 - x : x)];
          if (pen) out[py * W + ((bx + x) & 0xFF)] = pal[color + pen];
        }
      }
    }
  }
}

CrazyClimber.id = 'cclimber';
CrazyClimber.title = 'Crazy Climber';
CrazyClimber.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x00], ['4', 0x01], ['5', 0x02], ['6', 0x03]], default: 0x00 },
  { id: 'bonus', label: 'Bonus', options: [['30K', 0x00], ['50K', 0x40]], default: 0x00 },
];
