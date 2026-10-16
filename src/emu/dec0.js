// Data East's MEC-M1 board (1987-88: Heavy Barrel, Bad Dudes, RoboCop,
// Hippodrome): a 68000 at 10 MHz, a 6502 at 1.5 MHz for sound (YM2203,
// YM3812 and an OKI M6295), three BAC06 playfield chips and an MXC06
// sprite chip, 1024 colors of 8 bits per gun.
//
// Playfields: one of 8x8 text, two of 16x16 tiles; each 1024 (or 4096)
// tiles laid out as 4x1, 2x2 or 1x4 screens, with scroll registers, and
// optional per-line row scroll and per-column column scroll whose
// granularity is set by shift registers. A tile word holds a 12-bit code
// and a 4-bit color; colors 8-15 with pens 8-15 can be drawn over the
// sprites. Sprites are 16x16, stacked 1, 2, 4 or 8 high, copied from RAM by
// a DMA write at the end of each frame.
//
// Heavy Barrel has an 8751 MCU (simulated here from its known replies) and
// a rotary joystick per player: twelve positions read as one low bit each.
//
// RoboCop adds a HuC6280 running a small protection program, sharing 8K of
// RAM with the 68000 (which sees its first 2K, a byte per word, and kicks
// it with an interrupt by writing the last byte).
//
// The 68000 takes IRQ 6 at vblank; the 6502 an NMI per sound command and
// the YM3812's timer IRQ. 57.41 Hz; the picture is 256x240.

import { M68000 } from './m68000.js';
import { CPU6502 } from './m6502.js';
import { H6280 } from './h6280.js';
import { YM2203 } from './ym2203.js';
import { YM3812 } from './ym3812.js';
import { OKIM6295 } from './okim6295.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, run, rotate270 } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 240, TOP = 8, REFRESH = 57.41, LINES = 272;
const MAIN_CLOCK = 10000000, SOUND_CLOCK = 1500000, SUB_CLOCK = 21477200 / 16;
const STATE = ['ram', 'spriteRam', 'spriteBuf', 'pal', 'palB', 'pf', 'ctl0', 'ctl1', 'rowScroll', 'colScroll', 'extraRam',
  'soundRam', 'subRam', 'shared', 'latch', 'pri', 'frameCount', 'in0', 'in2', 'cycleCarry', 'soundCarry', 'subCarry',
  'sampleCarry', 'cpu', 'snd', 'sub', 'ym2203', 'ym3812', 'oki'];
const STATE_MCU = ['irqs', 'mcuPending', 'mcuReturn', 'mcuLevel', 'mcuTitle', 'rot'];

// Tile index of a map cell for each layout (4x1, 2x2, 1x4 screens), for 16x16 and 8x8 tiles.
const SCAN16 = [
  (c, r) => (c & 0xF) + ((r & 0xF) << 4) + ((c & 0x30) << 4),
  (c, r) => (c & 0xF) + ((r & 0xF) << 4) + ((r & 0x10) << 4) + ((c & 0x10) << 5),
  (c, r) => (c & 0xF) + ((r & 0x3F) << 4),
];
const SCAN8 = [
  (c, r) => (c & 0x1F) + ((r & 0x1F) << 5) + ((c & 0x60) << 5),
  (c, r) => (c & 0x1F) + ((r & 0x1F) << 5) + ((r & 0x20) << 5) + ((c & 0x20) << 6),
  (c, r) => (c & 0x1F) + ((r & 0x7F) << 5),
];
const SHAPES = [[64, 16], [32, 32], [16, 64]];      // map size in tiles for 16x16; double each for 8x8

export class Dec0 {
  saveState() { return capture(this, this.mcu ? [...STATE, ...STATE_MCU] : STATE); }
  loadState(s) { apply(this, this.mcu ? [...STATE, ...STATE_MCU] : STATE, s); for (let i = 0; i < 1024; i++) this.setColor(i); }

  // roms: { main (68000, big-endian bytes), sound (6502, 32K at 8000), sub (HuC6280, 64K) or null,
  //         chars, tiles2, tiles3, sprites, samples }
  // cfg: { rotate: ROT270 monitor, mcu: an 8751 simulation (write(value) -> reply) }
  constructor(roms, cfg = {}) {
    this.rotated = !!cfg.rotate;
    this.mcu = cfg.mcu || null;
    this.width = this.rotated ? H : W;
    this.height = this.rotated ? W : H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.roms = roms;
    this.ram = new Uint8Array(0x4000);          // FF8000-FFBFFF
    this.spriteRam = new Uint16Array(0x400);    // FFC000-FFC7FF
    this.spriteBuf = new Uint16Array(0x400);    // what the DMA copied
    this.pal = new Uint16Array(0x400);          // red (low byte) and green (high)
    this.palB = new Uint16Array(0x400);         // blue
    this.pf = [new Uint16Array(0x1000), new Uint16Array(0x400), new Uint16Array(0x400)];
    this.ctl0 = [new Uint16Array(4), new Uint16Array(4), new Uint16Array(4)];
    this.ctl1 = [new Uint16Array(4), new Uint16Array(4), new Uint16Array(4)];
    this.rowScroll = [new Uint16Array(0x200), new Uint16Array(0x200), new Uint16Array(0x200)];
    this.colScroll = [new Uint16Array(0x40), new Uint16Array(0x40), new Uint16Array(0x40)];
    this.extraRam = new Uint16Array(0xC00);     // 242800-243FFF
    this.soundRam = new Uint8Array(0x600);
    this.subRam = new Uint8Array(0x2000);
    this.shared = new Uint8Array(0x2000);
    this.palette = new Uint32Array(1024).fill(0xFF000000);

    this.cpu = new M68000({
      read8: (a) => this.read8(a), read16: (a) => this.read16(a),
      write8: (a, v) => this.write8(a, v), write16: (a, v) => this.write16(a, v),
    });
    this.cpu.onIrqAck = () => {
      // Pending levels as a bit mask: taking one clears it and leaves the rest waiting.
      this.irqs &= ~(1 << this.cpu.irq);
      this.cpu.irq = this.irqs ? 31 - Math.clz32(this.irqs) : 0;
    };
    this.snd = new CPU6502({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.sub = roms.sub ? new H6280({ read: (a) => this.subRead(a), write: (a, v) => this.subWrite(a, v) }) : null;
    if (this.sub) this.sub.onIrqAck = (line) => { if (line === 0) this.sub.setIrq(0, false); };
    this.ym2203 = new YM2203(1500000, 0.9);
    this.ym3812 = new YM3812(3000000, 0.8);
    this.oki = new OKIM6295(1023924, roms.samples, 0.8);
    this.sound = new SoundMix([this.ym2203, this.ym3812, this.oki], 0.8);

    const q = (rom) => rom.length * 2;          // bits in a quarter of the region
    const chars = roms.chars;
    this.charPix = decodeTiles(chars, {
      count: chars.length / 32, width: 8, height: 8, planes: [0, q(chars) * 2, q(chars), q(chars) * 3],
      xs: run(0, 8), ys: run(0, 8, 8), size: 64,
    });
    const tiles = (rom) => decodeTiles(rom, {
      count: rom.length / 128, width: 16, height: 16, planes: [q(rom), q(rom) * 3, 0, q(rom) * 2],
      xs: [...run(128, 8), ...run(0, 8)], ys: run(0, 16, 8), size: 256,
    });
    this.tilePix = [this.charPix, tiles(roms.tiles2), tiles(roms.tiles3)];
    this.tileCount = [chars.length / 32, roms.tiles2.length / 128, roms.tiles3.length / 128];
    this.spritePix = tiles(roms.sprites);
    this.spriteCount = roms.sprites.length / 128;

    this.native = new Uint32Array(W * H);
    this.frame = this.rotated ? new Uint32Array(W * H) : this.native;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.in0 = 0xFFFF; this.in2 = 0xFF;
    this.reset();
  }

  reset() {
    for (const r of [this.ram, this.spriteRam, this.spriteBuf, this.pal, this.palB, ...this.pf, ...this.ctl0, ...this.ctl1,
      ...this.rowScroll, ...this.colScroll, this.extraRam, this.soundRam, this.subRam, this.shared]) r.fill(0);
    this.palette.fill(0xFF000000);
    this.latch = 0; this.pri = 0; this.frameCount = 0;
    this.irqs = 0; this.mcuPending = 0; this.mcuReturn = 0; this.mcuLevel = 0; this.mcuTitle = 0; this.rot = 0;
    this.cycleCarry = this.soundCarry = this.subCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); if (this.sub) this.sub.reset();
    this.ym2203.reset(); this.ym3812.reset(); this.oki.reset();
  }

  setColor(i) {
    const rg = this.pal[i];
    this.palette[i] = rgba(rg & 0xFF, rg >> 8, this.palB[i] & 0xFF);
  }

  // ---------------------------------------------------------------- main CPU

  // Word-wide areas: reads and writes go through these. A hit leaves the array, the byte
  // offset into it and whether it's palette RAM in arArr / arOff / arPal (no allocation per access).
  area(a) {
    if (a >= 0x244000 && a < 0x246000) return this.hit(this.pf[0], a - 0x244000);
    if (a >= 0x24A000 && a < 0x24A800) return this.hit(this.pf[1], a - 0x24A000);
    if (a >= 0x24D000 && a < 0x24D800) return this.hit(this.pf[2], a - 0x24D000);
    if (a >= 0x242000 && a < 0x242080) return this.hit(this.colScroll[0], a - 0x242000);
    if (a >= 0x242400 && a < 0x242800) return this.hit(this.rowScroll[0], a - 0x242400);
    if (a >= 0x242800 && a < 0x244000) return this.hit(this.extraRam, a - 0x242800);
    if (a >= 0x248000 && a < 0x248080) return this.hit(this.colScroll[1], a - 0x248000);
    if (a >= 0x248400 && a < 0x248800) return this.hit(this.rowScroll[1], a - 0x248400);
    if (a >= 0x24C800 && a < 0x24C880) return this.hit(this.colScroll[2], a - 0x24C800);
    if (a >= 0x24CC00 && a < 0x24D000) return this.hit(this.rowScroll[2], a - 0x24CC00);
    if (a >= 0x240000 && a < 0x240008) return this.hit(this.ctl0[0], a - 0x240000);
    if (a >= 0x240010 && a < 0x240018) return this.hit(this.ctl1[0], a - 0x240010);
    if (a >= 0x246000 && a < 0x246008) return this.hit(this.ctl0[1], a - 0x246000);
    if (a >= 0x246010 && a < 0x246018) return this.hit(this.ctl1[1], a - 0x246010);
    if (a >= 0x24C000 && a < 0x24C008) return this.hit(this.ctl0[2], a - 0x24C000);
    if (a >= 0x24C010 && a < 0x24C018) return this.hit(this.ctl1[2], a - 0x24C010);
    if (a >= 0x310000 && a < 0x310800) return this.hit(this.pal, a - 0x310000, true);
    if (a >= 0x314000 && a < 0x314800) return this.hit(this.palB, a - 0x314000, true);
    if (a >= 0xFFC000 && a < 0xFFC800) return this.hit(this.spriteRam, a - 0xFFC000);
    return false;
  }
  hit(arr, off, pal = false) { this.arArr = arr; this.arOff = off; this.arPal = pal; return true; }

  read16(a) {
    a &= 0xFFFFFF;
    if (a < 0x60000) { const r = this.roms.main; return a < r.length ? (r[a] << 8) | r[a + 1] : 0xFFFF; }
    if (a >= 0xFF8000 && a < 0xFFC000) { const o = a - 0xFF8000; return (this.ram[o] << 8) | this.ram[o + 1]; }
    if (a >= 0x180000 && a < 0x181000 && this.sub) return this.shared[(a - 0x180000) >> 1];
    if (this.area(a)) return this.arArr[this.arOff >> 1];
    if (a >= 0x30C000 && a < 0x30C00C) {
      switch (a & 0xE) {
        case 0: return this.in0;
        case 2: return this.in2 | (this.line >= TOP + H ? 0x80 : 0);
        case 4: return this.dsw0 | (this.dsw1 << 8);
        case 8: return this.mcuReturn;
      }
    }
    if (a >= 0x300000 && a < 0x300020 && this.mcu) return (a & 0x1E) === 0 ? 0xFFFF & ~(1 << this.rot) : 0xFFFF;
    return 0xFFFF;
  }
  read8(a) { const w = this.read16(a & ~1); return a & 1 ? w & 0xFF : w >> 8; }

  write16(a, v) {
    a &= 0xFFFFFF;
    if (a >= 0xFF8000 && a < 0xFFC000) { const o = a - 0xFF8000; this.ram[o] = v >> 8; this.ram[o + 1] = v & 0xFF; return; }
    if (a >= 0x180000 && a < 0x181000 && this.sub) {
      const o = (a - 0x180000) >> 1;
      this.shared[o] = v & 0xFF;
      if (o === 0x7FF) this.sub.setIrq(0, true);
      return;
    }
    if (this.area(a)) { const i = this.arOff >> 1; this.arArr[i] = v; if (this.arPal) this.setColor(i); return; }
    if (a >= 0x30C010 && a < 0x30C020) {
      switch (a & 0xE) {
        case 0x0: this.pri = v; break;
        case 0x2: this.spriteBuf.set(this.spriteRam); break;   // sprite DMA
        case 0x4: this.latch = v & 0xFF; this.snd.nmi(); break;
        case 0x6: if (this.mcu) { this.mcuReturn = this.mcu.call(this, v); this.mcuPending = 1; } break;
        // 8 IRQ acknowledge, C coin lockout, E 8751 reset.
      }
    }
  }
  write8(a, v) {
    a &= 0xFFFFFF;
    if (a >= 0xFF8000 && a < 0xFFC000) { this.ram[a - 0xFF8000] = v; return; }
    if (a >= 0x180000 && a < 0x181000 && this.sub) { if (a & 1) this.write16(a & ~1, v); return; }
    if (this.area(a)) {
      const arr = this.arArr, i = this.arOff >> 1, w = arr[i];
      arr[i] = a & 1 ? (w & 0xFF00) | v : (w & 0xFF) | (v << 8);
      if (this.arPal) this.setColor(i);
      return;
    }
    if (a >= 0x30C010 && a < 0x30C020) this.write16(a & ~1, (v << 8) | v);
  }

  // ---------------------------------------------------------------- sound CPU (6502)

  soundRead(a) {
    if (a < 0x600) return this.soundRam[a];
    if (a >= 0x8000) return this.roms.sound[a - 0x8000];
    if (a === 0x3000) return this.latch;
    if (a === 0x3800) return this.oki.read();
    if (a === 0x0800 || a === 0x0801) return this.ym2203.status();
    if (a === 0x1000 || a === 0x1001) return this.ym3812.status();
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a < 0x600) { this.soundRam[a] = v; return; }
    switch (a) {
      case 0x0800: this.ym2203.select(v); break;
      case 0x0801: this.ym2203.write(v); break;
      case 0x1000: this.ym3812.select(v); break;
      case 0x1001: this.ym3812.write(v); break;
      case 0x3800: this.oki.write(v); break;
    }
  }

  // ---------------------------------------------------------------- protection CPU (HuC6280)

  subRead(pa) {
    if (pa < 0x10000) return this.roms.sub[pa] ?? 0xFF;
    if (pa >= 0x1F0000 && pa < 0x1F2000) return this.subRam[pa - 0x1F0000];
    if (pa >= 0x1F2000 && pa < 0x1F4000) return this.shared[pa - 0x1F2000];
    return 0xFF;
  }
  subWrite(pa, v) {
    if (pa >= 0x1F0000 && pa < 0x1F2000) this.subRam[pa - 0x1F0000] = v;
    else if (pa >= 0x1F2000 && pa < 0x1F4000) this.shared[pa - 0x1F2000] = v;
  }

  // ---------------------------------------------------------------- inputs

  // IN0 (active low): player 1 up, down, left, right, fire, jump in the low
  // byte; player 2 in the high. IN2: starts, coin; bit 7 is vblank (high).
  setInputs(s) {
    const p1 = (s.up ? 1 : 0) | (s.down ? 2 : 0) | (s.left ? 4 : 0) | (s.right ? 8 : 0) | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0);
    this.in0 = 0xFFFF & ~p1;
    this.in2 = 0x7F & ~((s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0) | (s.coin ? 0x10 : 0));
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const mainLine = MAIN_CLOCK / REFRESH / LINES, soundLine = SOUND_CLOCK / REFRESH / LINES, subLine = SUB_CLOCK / REFRESH / LINES;
    const samples = RATE / REFRESH / LINES, dt = 1 / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      if (line === TOP + H) { this.render(); this.finish(); this.raise(6); this.frameCount = (this.frameCount + 1) >>> 0; }
      // The 8751 answers a command with IRQ 5 a little later (the game needs that delay).
      if (this.mcuPending) { this.mcuPending = 0; this.raise(5); }
      this.cycleCarry += mainLine;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      if (this.sub) { this.subCarry += subLine; this.subCarry -= this.sub.run(Math.floor(this.subCarry)); }
      this.ym3812.timers(dt); this.ym2203.timers(dt);
      this.snd.irq = this.ym3812.irq;
      this.soundCarry += soundLine;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  raise(level) { this.irqs |= 1 << level; this.cpu.irq = 31 - Math.clz32(this.irqs); }

  // ---------------------------------------------------------------- video

  // Draw playfield n (0 text, 1 and 2 tiles): mode 'opaque', 'trans' (pen 0
  // see-through) or 'front' (only colors 8-15 / pens 8-15: what goes over sprites).
  playfield(n, mode) {
    const out = this.native, pal = this.palette, c0 = this.ctl0[n], c1 = this.ctl1[n], data = this.pf[n];
    const pix = this.tilePix[n], count = this.tileCount[n], base = [0, 512, 768][n];
    const size = n === 0 ? 8 : 16, shift = n === 0 ? 3 : 4, shape = Math.min(2, c0[3] & 3);
    const [tw, th] = SHAPES[shape], mapW = (n === 0 ? tw * 2 : tw) * size, mapH = (n === 0 ? th * 2 : th) * size;
    const scan = (n === 0 ? SCAN8 : SCAN16)[shape];
    const rowOn = c0[0] & 4, colOn = c0[0] & 8, rs = c1[3] & 15, cs = c1[2] & 15;
    const area = size * size;
    // Each row goes a run at a time: to the end of a tile, or of an 8-pixel column-scroll group.
    const m = mode === 'opaque' ? 0 : mode === 'trans' ? 1 : 2, tmask = size - 1;
    const rows = this.rowScroll[n], colsS = this.colScroll[n];
    let srcY = c1[1] + TOP;
    for (let y = 0; y < H; y++, srcY++) {
      let srcX = c1[0] + (rowOn ? rows[(srcY >> rs) & (0x1FF >> rs)] : 0);
      for (let x = 0; x < W;) {
        const colOff = colOn ? colsS[((srcX >> 3) >> cs) & (0x3F >> cs)] : 0;
        const py = (srcY + colOff) & (mapH - 1), px = srcX & (mapW - 1);
        let run = Math.min(size - (px & tmask), W - x);
        if (colOn) run = Math.min(run, 8 - (srcX & 7));
        const tile = data[scan(px >> shift, py >> shift)], color = tile >> 12, cb = base + color * 16;
        const src = ((tile & 0xFFF) % count) * area + (py & tmask) * size + (px & tmask), o = y * W + x;
        if (m === 0) for (let i = 0; i < run; i++) out[o + i] = pal[cb + pix[src + i]];
        else if (m === 1) for (let i = 0; i < run; i++) { const pen = pix[src + i]; if (pen) out[o + i] = pal[cb + pen]; }
        else if (color & 8) for (let i = 0; i < run; i++) { const pen = pix[src + i]; if (pen & 8) out[o + i] = pal[cb + pen]; }
        x += run; srcX += run;
      }
    }
  }

  // Sprites whose color matches (color & mask) === val, in table order (later on top).
  drawSprites(mask, val) {
    const out = this.native, pal = this.palette, spr = this.spriteBuf, pix = this.spritePix;
    for (let offs = 0; offs < 0x400; offs += 4) {
      let y = spr[offs];
      if (!(y & 0x8000)) continue;
      let x = spr[offs + 2];
      const colour = x >> 12;
      if ((colour & mask) !== val) continue;
      if ((x & 0x800) && (this.frameCount & 1)) continue;       // flashing
      const fx = y & 0x2000, fy = y & 0x4000;
      let multi = (1 << ((y & 0x1800) >> 11)) - 1;
      let code = spr[offs + 1] & 0xFFF;
      x &= 0x1FF; y &= 0x1FF;
      if (x >= 256) x -= 512;
      if (y >= 256) y -= 512;
      x = 240 - x; y = 240 - y;
      if (x > 256) continue;
      code &= ~multi;
      let inc;
      if (fy) inc = -1; else { code += multi; inc = 1; }
      for (; multi >= 0; multi--) {
        const c = ((code - multi * inc) % this.spriteCount + this.spriteCount) % this.spriteCount;
        const sy = y - 16 * multi - TOP;
        for (let row = 0; row < 16; row++) {
          const py = sy + row;
          if (py < 0 || py >= H) continue;
          const src = c * 256 + (fy ? 15 - row : row) * 16;
          for (let col = 0; col < 16; col++) {
            const px = x + col;
            if (px < 0 || px >= W) continue;
            const pen = pix[src + (fx ? 15 - col : col)];
            if (pen) out[py * W + px] = pal[256 + colour * 16 + pen];
          }
        }
      }
    }
  }

  // RoboCop's layer order: the priority word swaps the two tile layers
  // (bit 0) and can split the sprites around the upper one (bits 1-2).
  render() {
    const pri = this.pri, trans = pri & 4 ? 8 : 0;
    const [lower, upper] = pri & 1 ? [1, 2] : [2, 1];
    this.playfield(lower, 'opaque');
    if (pri & 2) this.drawSprites(8, trans);
    this.playfield(upper, 'trans');
    if (pri & 2) this.drawSprites(8, trans ^ 8); else this.drawSprites(0, 0);
    this.playfield(0, 'trans');
  }
  finish() { if (this.rotated) rotate270(this.native, W, H, this.frame); }
}

// ---------------------------------------------------------------- RoboCop

export class RoboCop extends Dec0 {
  constructor(roms) { super(roms); this.button2 = 'Jump'; }
  // DSW0: 1 coin 1 credit, demo sounds, upright. DSW1: energy, difficulty, continues, bonus energy, brink time.
  applySwitches(v) { this.dsw0 = 0x5F | v.demoSounds; this.dsw1 = 0xF0 | v.energy | v.difficulty; }
}
RoboCop.id = 'robocop';
RoboCop.title = 'RoboCop';
RoboCop.switches = [
  { id: 'energy', label: 'Player energy', options: [['Low', 0x01], ['Medium', 0x03], ['High', 0x02], ['Very high', 0x00]], default: 0x03 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x08], ['Normal', 0x0C], ['Hard', 0x04], ['Hardest', 0x00]], default: 0x0C },
  { id: 'demoSounds', label: 'Demo sounds', options: [['On', 0x20], ['Off', 0x00]], default: 0x20 },
];

// ---------------------------------------------------------------- Heavy Barrel

// The 8751's replies, as documented by MAME: the order title-screen pieces
// are drawn in, and per level where the weapon crates appear.
const HB_TITLE = [1, 2, 5, 6, 9, 10, 13, 14, 17, 18, 21, 22, 25, 26, 29, 30, 33, 34, 37, 38, 41, 42, 0,
  3, 4, 7, 8, 11, 12, 15, 16, 19, 20, 23, 24, 27, 28, 31, 32, 35, 36, 39, 40, 43, 44, 0,
  45, 46, 49, 50, 53, 54, 57, 58, 61, 62, 65, 66, 69, 70, 73, 74, 77, 78, 81, 82, 0,
  47, 48, 51, 52, 55, 56, 59, 60, 63, 64, 67, 68, 71, 72, 75, 76, 79, 80, 83, 84, 0,
  85, 86, 89, 90, 93, 94, 97, 98, 101, 102, 105, 106, 109, 110, 113, 114, 117, 118, 121, 122, 125, 126, 0,
  87, 88, 91, 92, 95, 96, 99, 100, 103, 104, 107, 108, 111, 112, 115, 116, 119, 120, 123, 124, 127, 128, 0,
  129, 130, 133, 134, 137, 138, 141, 142, 145, 146, 149, 150, 153, 154, 157, 158, 161, 162, 165, 166, 169, 170, 173, 174, 0,
  131, 132, 135, 136, 139, 140, 143, 144, 147, 148, 151, 152, 155, 156, 159, 160, 163, 164, 167, 168, 171, 172, 175, 176, 0,
  0x10B1, 0x10B2, 0, 0x10B3, 0x10B4, -1];
const HB_WEAPONS = [
  [0x558, 0x520, 0x5C0, 0x600, 0x520, 0x540, 0x560, 0x5C0, 0x688, 0x688, 0x7A8, 0x850, 0x880, 0x880, 0x990, 0x9B0, 0x9B0, 0x9E0, 0xFFFF],
  [0x330, 0x370, 0x3D8, 0x580, 0x5B0, 0x640, 0x6A0, 0x8E0, 0x8E0, 0x940, 0x9F0, 0xA20, 0xA50, 0xA80, 0xFFFF],
  [0xB20, 0xBD0, 0xB20, 0xB20, 0xBD8, 0xB50, 0xBD8, 0xB20, 0xBE0, 0xB40, 0xB80, 0xA18, 0xA08, 0xA08, 0x980, 0x8E0, 0x780, 0x790, 0x650, 0x600, 0x5D0, 0x5A0, 0x570, 0x590, 0x5E0, 0xFFFF],
  [0x530, 0x5D0, 0x5E0, 0x5C8, 0x528, 0x520, 0x5D8, 0x5E0, 0x5D8, 0x540, 0x570, 0x5A0, 0x658, 0x698, 0x710, 0x7B8, 0x8E0, 0x8E0, 0x8D8, 0x818, 0x8E8, 0x820, 0x8E0, 0x848, 0x848, 0xFFFF],
  [0x230, 0x280, 0x700, 0x790, 0x790, 0x7E8, 0x7E8, 0x8D0, 0x920, 0x950, 0xAD0, 0xB90, 0xB50, 0xB10, 0xBE0, 0xBE0, 0xFFFF],
  [0xD20, 0xDE0, 0xD20, 0xDE0, 0xD80, 0xD80, 0xD90, 0xDD0, 0xDB0, 0xB20, 0xA40, 0x9E0, 0x960, 0x8A0, 0x870, 0x840, 0x7E0, 0x7B0, 0x780, 0xFFFF],
  [0x730, 0x7E0, 0x720, 0x7E0, 0x740, 0x7C0, 0x730, 0x7D0, 0x740, 0x7C0, 0x730, 0x7D0, 0x720, 0x7E0, 0x720, 0x7E0, 0x720, 0x7E0, 0x720, 0x7E0, 0x730, 0x7D0, 0xFFFF],
];
function hbarrelMcu(v) {
  let r = 0;
  switch (v >> 8) {
    case 0x2: r = this.mcuLevel; break;                          // which level
    case 0x3: this.mcuLevel++; r = 0x301; break;                 // next level
    case 0x5: this.mcuLevel = 0; r = 0xB3B; break;               // back to level 1
    case 0x6: r = (HB_WEAPONS[this.mcuLevel] || [])[v & 0x1F] ?? 0; break;   // weapon crates
  }
  if (v === 0x007) r = 0xC000;                                   // stack pointer
  if (v === 0x175) r = 0x68B;                                    // ID check (US)
  if (v === 0x4FF) this.mcuTitle = 0;
  if (v > 0x3FF && v < 0x4FF) {                                  // title screen pieces
    const t = HB_TITLE[this.mcuTitle++] ?? -1;
    r = t === 0 ? 0xFFFE : t === -1 ? 0xFFFF : t > 0x1000 ? (t & 0xFFF) + 143 : t + 143 + 0x2000;
  }
  return r & 0xFFFF;
}

// Heavy Barrel (1987): a vertical overhead shooter with a rotary joystick.
// The gun turns to face the way the stick (or the aim keys / right stick) points.
export class HeavyBarrel extends Dec0 {
  constructor(roms) { super(roms, { rotate: true, mcu: hbarrelMcu }); this.button2 = 'Grenade'; }
  render() {
    this.playfield(2, 'opaque');
    this.drawSprites(8, 8);
    this.playfield(1, 'trans');
    this.drawSprites(8, 0);
    this.playfield(0, 'trans');
  }
  // The rotary joystick is read as relative clicks (each one turns the gun 45 degrees
  // anticlockwise), so turn it a click at a time until the gun, whose direction the
  // game keeps at FF8066 (0 up, 4 per 45 degrees clockwise), points the chosen way.
  setInputs(s) {
    super.setInputs(s);
    const a = s.aim || {};
    const d = a.up || a.down || a.left || a.right ? a : s;
    const dx = (d.right ? 1 : 0) - (d.left ? 1 : 0), dy = (d.down ? 1 : 0) - (d.up ? 1 : 0);
    if (!(dx || dy) || (this.frameCount & 1)) return;
    const want = Math.round(((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360) / 45) & 7;
    const have = ((this.ram[0x66] + 2) >> 2) & 7;
    const diff = (want - have) & 7;
    if (diff) this.rot = (this.rot + (diff <= 4 ? 11 : 1)) % 12;
  }
  // DSW0: 1 coin 1 credit, no service, demo sounds, no flip. DSW1: lives, difficulty, bonus, continues.
  applySwitches(v) { this.dsw0 = 0xFF; this.dsw1 = 0x80 | v.lives | v.difficulty | v.bonus; }
}
HeavyBarrel.id = 'hbarrel';
HeavyBarrel.title = 'Heavy Barrel';
HeavyBarrel.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x01], ['3', 0x03], ['5', 0x02], ['Infinite (cheat)', 0x00]], default: 0x03 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x08], ['Normal', 0x0C], ['Hard', 0x04], ['Hardest', 0x00]], default: 0x0C },
  { id: 'bonus', label: 'Bonus life', options: [['30K 80K 160K', 0x30], ['50K 120K 190K', 0x10], ['100K 200K 300K', 0x20], ['150K 300K 450K', 0x00]], default: 0x30 },
];
