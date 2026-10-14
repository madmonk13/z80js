// Konami's late-80s custom video chips, shared by many boards:
//
// K052109 (with the 051962): three 64x32 maps of 8x8 tiles. F is fixed, A
// and B scroll, by layer or per line or per column. A tile is a code byte,
// a color byte (whose bits 2-3 pick one of four ROM banks set by registers)
// and, on some boards, a second code byte. What the color byte's other
// bits mean is up to each board, so each game supplies a callback that
// turns (layer, bank, code, color) into a final code, color, flips and
// priority. RAM: 0000-17FF colors (F, A, B), 2000-37FF codes; registers in
// 1800-1FFF and 3800-3FFF (scroll RAM, scroll mode at 1C80, interrupt
// enable at 1D00, bank registers at 1D80/1F00, ROM read bank at 1E00).
//
// K051960 (with the 051937): 128 sprites of 16x16 cells grouped up to 8x8,
// zoomable, with an 8-bit "color" byte the board interprets through a
// callback (color, priority, shadow). Pen 15 of a shadowed sprite darkens
// what's under it. The 051937's registers enable interrupts and ROM reading.
//
// K051316: a 32x32 map of 16x16 tiles that's scaled and rotated by two
// 24-bit counters stepped per pixel and per line (Ajax's 3D stages).
//
// Drawing works on the board's visible window of the chips' 512x256 bitmap:
// `win` = { x, y, w, h } in bitmap coordinates. Layers write colors into
// `frame` and OR a priority value into `pri` where they draw, so a board can
// order them and let sprites test the priority buffer, as the boards' own
// priority logic does.

import { decodeTiles, run } from './video.js';
import { capture, apply } from './state.js';

// Konami's graphics ROMs come in pairs that the board reads 16 bits at a
// time; this puts them in that order (two halves -> alternating words).
export function deinterleave2(rom) {
  const w = new Uint16Array(rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.length));
  const shuffle = (base, len) => {
    if (len === 2) return;
    len /= 2;
    for (let i = 0; i < len / 2; i++) {
      const t = w[base + len / 2 + i]; w[base + len / 2 + i] = w[base + len + i]; w[base + len + i] = t;
    }
    shuffle(base, len); shuffle(base + len, len);
  };
  shuffle(0, w.length);
  return new Uint8Array(w.buffer);
}

const darken = (c) => (c & 0xFF000000) | ((((c >> 16) & 0xFF) * 0.55) << 16) | ((((c >> 8) & 0xFF) * 0.55) << 8) | ((c & 0xFF) * 0.55);

// ---------------------------------------------------------------- K052109

const T_STATE = ['ram', 'bank', 'romSub', 'scrollCtrl', 'irqEnabled', 'rmrd', 'flipEnable'];

export class K052109 {
  saveState() { return capture(this, T_STATE); }
  loadState(s) { apply(this, T_STATE, s); }

  // rom: the tile ROM (deinterleaved); callback(layer, bank, code, color) -> { code, color, flags, priority }
  constructor(rom, callback) {
    this.rom = rom;
    this.callback = callback;
    this.count = rom.length / 32;
    this.pix = decodeTiles(rom, { count: this.count, width: 8, height: 8, planes: [24, 16, 8, 0], xs: run(0, 8), ys: run(0, 8, 32), size: 256 });
    this.dx = [0, 0, 0]; this.dy = [0, 0, 0];
    this.reset();
  }
  reset() {
    this.ram = new Uint8Array(0x6000);
    this.bank = new Uint8Array(4);
    this.romSub = 0; this.scrollCtrl = 0; this.irqEnabled = 0; this.rmrd = 0; this.flipEnable = 0;
  }

  read(o) {
    if (!this.rmrd) return this.ram[o];
    // ROM test: the tile ROM read through the RAM window, banked by 1E00.
    let code = (o & 0x1FFF) >> 5;
    const bank = this.bank[(this.romSub & 0x0C) >> 2] >> 2;
    code = this.callback(0, bank, code, this.romSub).code;
    return this.rom[((code << 5) + (o & 0x1F)) & (this.rom.length - 1)];
  }
  write(o, v) {
    this.ram[o] = v;
    if ((o & 0x1FFF) < 0x1800) return;
    switch (o) {
      case 0x1C80: this.scrollCtrl = v; break;
      case 0x1D00: this.irqEnabled = v & 0x04; break;
      case 0x1D80: this.bank[0] = v & 15; this.bank[1] = v >> 4; break;
      case 0x1E00: this.romSub = v; break;
      case 0x1E80: this.flipEnable = (v & 6) >> 1; break;
      case 0x1F00: this.bank[2] = v & 15; this.bank[3] = v >> 4; break;
    }
  }

  // The 2048 tiles of a layer as [pixel offset, palette color base, flags, priority].
  tiles(layer) {
    const ram = this.ram, cbase = layer * 0x800, out = new Int32Array(2048 * 4), cnt = this.count;
    for (let i = 0; i < 2048; i++) {
      let color = ram[cbase + i];
      const code = ram[0x2000 + cbase + i] + 256 * ram[0x4000 + cbase + i];
      let bank = this.bank[(color & 0x0C) >> 2];
      color = (color & 0xF3) | ((bank & 3) << 2);
      bank >>= 2;
      const flipY = color & 2;
      const t = this.callback(layer, bank, code, color);
      let flags = t.flags || 0;
      if (!(this.flipEnable & 1)) flags &= ~1;
      if (flipY && (this.flipEnable & 2)) flags |= 2;
      out[i * 4] = ((t.code % cnt) + cnt) % cnt * 64; out[i * 4 + 1] = t.color * 16; out[i * 4 + 2] = flags; out[i * 4 + 3] = t.priority || 0;
    }
    return out;
  }

  // Scroll for layer 1 (A) or 2 (B): per-line x and per-column y values.
  scrolls(layer) {
    const ram = this.ram, base = layer === 1 ? 0x1800 : 0x3800, ctrl = layer === 1 ? this.scrollCtrl & 7 : (this.scrollCtrl >> 3) & 7;
    const xs = new Int32Array(256), ys = new Int32Array(512);
    const rowMode = (ctrl & 3) >= 2, colMode = !rowMode && (ctrl & 4);
    const x0 = ram[base + 0x200] + 256 * ram[base + 0x201] - 6, y0 = ram[base + 0x0C];
    for (let line = 0; line < 256; line++) {
      const k = rowMode ? ((ctrl & 3) === 2 ? line & ~7 : line) : 0;
      xs[line] = (rowMode ? ram[base + 0x200 + 2 * k] + 256 * ram[base + 0x201 + 2 * k] - 6 : x0) + this.dx[layer];
    }
    for (let col = 0; col < 512; col++) ys[col] = (colMode ? ram[base + (col >> 3)] : y0) + this.dy[layer];
    return { xs, ys, colMode };
  }

  // Draw a layer. opts: { opaque, priority (OR'd into pri), category (only tiles with this priority) }
  draw(layer, frame, pri, palette, win, opts = {}) {
    const t = this.tiles(layer), pix = this.pix, opaque = !!opts.opaque, orPri = opts.priority || 0, cat = opts.category;
    const sc = layer ? this.scrolls(layer) : null;
    for (let y = 0; y < win.h; y++) {
      const by = win.y + y;
      for (let x = 0; x < win.w; x++) {
        const bx = win.x + x;
        let tx, ty;
        if (sc) {
          if (sc.colMode) { tx = (bx + sc.xs[0]) & 511; ty = (by + sc.ys[bx & 511]) & 255; }
          else { ty = (by + sc.ys[0]) & 255; tx = (bx + sc.xs[by]) & 511; }
        } else { tx = bx & 511; ty = by & 255; }
        const ti = ((ty >> 3) * 64 + (tx >> 3)) * 4;
        if (cat !== undefined && t[ti + 3] !== cat) continue;
        const f = t[ti + 2];
        const px = f & 1 ? 7 - (tx & 7) : tx & 7, py = f & 2 ? 7 - (ty & 7) : ty & 7;
        const pen = pix[t[ti] + py * 8 + px];
        if (!pen && !opaque) continue;
        const o = y * win.w + x;
        frame[o] = palette[t[ti + 1] + pen];
        pri[o] |= orPri;
      }
    }
  }
}

// ---------------------------------------------------------------- K051960 / K051937

const S_STATE = ['ram', 'romBank', 'irqEnabled', 'nmiEnabled', 'readRoms', 'romOffset', 'counter'];
const XOFF = [0, 1, 4, 5, 16, 17, 20, 21], YOFF = [0, 2, 8, 10, 32, 34, 40, 42];
const SW = [1, 2, 1, 2, 4, 2, 4, 8], SH = [1, 1, 2, 2, 2, 4, 4, 8];

export class K051960 {
  saveState() { return capture(this, S_STATE); }
  loadState(s) { apply(this, S_STATE, s); }

  // rom: the sprite ROM (deinterleaved); callback(code, color) -> { code, color, priority, shadow };
  // reversed: the boards that wire the bit planes the other way round (TMNT, M.I.A.)
  constructor(rom, callback, reversed = false) {
    this.rom = rom;
    this.callback = callback;
    this.count = rom.length / 128;
    this.pix = decodeTiles(rom, {
      count: this.count, width: 16, height: 16, planes: reversed ? [24, 16, 8, 0] : [0, 8, 16, 24],
      xs: [...run(0, 8), ...run(256, 8)], ys: [...run(0, 8, 32), ...run(512, 8, 32)], size: 1024,
    });
    this.dx = 0; this.dy = 0;
    this.reset();
  }
  reset() {
    this.ram = new Uint8Array(0x400);
    this.romBank = new Uint8Array(3);
    this.irqEnabled = 0; this.nmiEnabled = 0; this.readRoms = 0; this.romOffset = 0; this.counter = 0;
  }

  romData(byte) {
    const addr = this.romOffset + (this.romBank[0] << 8) + ((this.romBank[1] & 3) << 16);
    const color = ((this.romBank[1] & 0xFC) >> 2) + ((this.romBank[2] & 3) << 6);
    const t = this.callback((addr & 0x3FFE0) >> 5, color);
    return this.rom[((t.code << 7) | ((addr & 0x1F) << 2) | byte) & (this.rom.length - 1)];
  }
  read(o) {
    if (this.readRoms) { this.romOffset = (o & 0x3FC) >> 2; return this.romData(o & 3); }
    return this.ram[o];
  }
  write(o, v) { this.ram[o] = v; }
  // 051937 registers: 0 interrupt enables / ROM reading, 2-4 ROM read bank.
  readReg(o) {
    if (this.readRoms && o >= 4 && o < 8) return this.romData(o & 3);
    if (o === 0) return (this.counter++) & 1;        // some games wait for this bit to toggle
    return 0;
  }
  writeReg(o, v) {
    if (o === 0) { this.irqEnabled = v & 1; this.nmiEnabled = v & 4; this.readRoms = v & 0x20; }
    else if (o >= 2 && o < 5) this.romBank[o - 2] = v;
  }

  // Draw sprites. opts.mask: true -> the callback's priority is a mask of
  // pri-buffer values that hide the sprite (drawn front to back, the first
  // sprite at a pixel wins); otherwise only sprites whose priority is within
  // [min, max] are drawn, back to front.
  draw(frame, pri, palette, win, opts = {}) {
    const ram = this.ram, maskMode = !!opts.mask, list = new Int32Array(128).fill(-1);
    for (let offs = 0; offs < 0x400; offs += 8) {
      if (ram[offs] & 0x80) list[maskMode ? (ram[offs] & 0x7F) ^ 0x7F : ram[offs] & 0x7F] = offs;
    }
    const pix = this.pix, cnt = this.count;
    for (let k = 0; k < 128; k++) {
      const offs = list[k];
      if (offs < 0) continue;
      const raw = ram[offs + 3];
      const t = this.callback(ram[offs + 2] + ((ram[offs + 1] & 0x1F) << 8), raw);
      const p = t.priority || 0;
      if (!maskMode && opts.min !== undefined && (p < opts.min || p > opts.max)) continue;
      const shadow = t.shadow !== undefined ? t.shadow : raw & 0x80;
      const size = (ram[offs + 1] & 0xE0) >> 5, w = SW[size], h = SH[size];
      let code = t.code;
      if (w >= 2) code &= ~1; if (h >= 2) code &= ~2; if (w >= 4) code &= ~4;
      if (h >= 4) code &= ~8; if (w >= 8) code &= ~0x10; if (h >= 8) code &= ~0x20;
      const ox = ((256 * ram[offs + 6] + ram[offs + 7]) & 0x1FF) + this.dx;
      const oy = 256 - ((256 * ram[offs + 4] + ram[offs + 5]) & 0x1FF) + this.dy;
      const flipX = ram[offs + 6] & 2, flipY = ram[offs + 4] & 2;
      const zx = (128 - ((ram[offs + 6] & 0xFC) >> 2)) / 128, zy = (128 - ((ram[offs + 4] & 0xFC) >> 2)) / 128;
      const colorBase = t.color * 16;
      for (let cy = 0; cy < h; cy++) {
        const sy0 = oy + Math.round(16 * zy * cy), sy1 = oy + Math.round(16 * zy * (cy + 1));
        for (let cx = 0; cx < w; cx++) {
          const c = (code + XOFF[flipX ? w - 1 - cx : cx] + YOFF[flipY ? h - 1 - cy : cy]) % cnt;
          const sx0 = ox + Math.round(16 * zx * cx), sx1 = ox + Math.round(16 * zx * (cx + 1));
          const cw = sx1 - sx0, ch = sy1 - sy0;
          for (let y = 0; y < ch; y++) {
            const py = sy0 + y - win.y;
            if (py < 0 || py >= win.h) continue;
            let srcY = Math.floor((y * 16) / ch); if (flipY) srcY = 15 - srcY;
            for (let x = 0; x < cw; x++) {
              const px = ((sx0 + x) & 0x1FF) - win.x;
              if (px < 0 || px >= win.w) continue;
              let srcX = Math.floor((x * 16) / cw); if (flipX) srcX = 15 - srcX;
              const pen = pix[c * 256 + srcY * 16 + srcX];
              if (!pen) continue;
              const o = py * win.w + px;
              if (maskMode) {
                if (pri[o] & 0x80) continue;            // a nearer sprite already drew here
                const hidden = (p >> (pri[o] & 0x1F)) & 1;
                pri[o] |= 0x80;
                if (hidden) continue;
              }
              frame[o] = shadow && pen === 15 ? darken(frame[o]) : palette[colorBase + pen];
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- K051316

const Z_STATE = ['ram', 'ctrl', 'wrap'];

export class K051316 {
  saveState() { return capture(this, Z_STATE); }
  loadState(s) { apply(this, Z_STATE, s); }

  // rom: tile ROM; bpp 4 or 7; callback(code, color) -> { code, color, flags }
  constructor(rom, bpp, callback, offset = [0, 0]) {
    this.rom = rom; this.bpp = bpp; this.callback = callback; this.offset = offset;
    if (bpp === 4) {
      this.count = rom.length / 128;
      this.pix = decodeTiles(rom, { count: this.count, width: 16, height: 16, planes: [0, 1, 2, 3], xs: run(0, 16, 4), ys: run(0, 16, 64), size: 1024 });
    } else {
      this.count = rom.length / 256;
      this.pix = new Uint8Array(rom.length);
      for (let i = 0; i < rom.length; i++) this.pix[i] = rom[i] & 0x7F;   // one byte a pixel, 7 bits used
    }
    this.reset();
  }
  reset() { this.ram = new Uint8Array(0x800); this.ctrl = new Uint8Array(16); this.wrap = 0; }

  read(o) { return this.ram[o]; }
  write(o, v) { this.ram[o] = v; }
  writeCtrl(o, v) { this.ctrl[o & 15] = v; }
  readRom(o) {
    if (this.ctrl[0x0E] & 1) return 0;
    let addr = o + (this.ctrl[0x0C] << 11) + (this.ctrl[0x0D] << 19);
    if (this.bpp <= 4) addr >>= 1;
    return this.rom[addr & (this.rom.length - 1)];
  }

  // Draw the rotated, scaled layer: pen 0 is see-through.
  draw(frame, pri, palette, win, opts = {}) {
    const c = this.ctrl, s16 = (hi, lo) => ((c[hi] << 8 | c[lo]) << 16) >> 16;
    let startx = 256 * s16(0, 1), starty = 256 * s16(6, 7);
    const incxx = s16(2, 3), incyx = s16(4, 5), incxy = s16(8, 9), incyy = s16(10, 11);
    startx -= (16 + this.offset[1]) * incyx; starty -= (16 + this.offset[1]) * incyy;
    startx -= (89 + this.offset[0]) * incxx; starty -= (89 + this.offset[0]) * incxy;
    // Precompute each map cell's tile.
    const codes = new Int32Array(1024), colors = new Int32Array(1024), flags = new Uint8Array(1024);
    const tileSize = 256, cnt = this.count;
    for (let i = 0; i < 1024; i++) {
      const t = this.callback(this.ram[i], this.ram[i + 0x400]);
      codes[i] = (t.code % cnt) * tileSize; colors[i] = t.color << this.bpp; flags[i] = t.flags || 0;
    }
    const orPri = opts.priority || 0, wrap = this.wrap, pix = this.pix;
    for (let y = 0; y < win.h; y++) {
      const by = win.y + y;
      let cx = startx + win.x * incxx + by * incyx, cy = starty + win.x * incxy + by * incyy;
      for (let x = 0; x < win.w; x++, cx += incxx, cy += incxy) {
        let mx = cx >> 11, my = cy >> 11;
        if (wrap) { mx &= 511; my &= 511; } else if (mx < 0 || mx > 511 || my < 0 || my > 511) continue;
        const i = (my >> 4) * 32 + (mx >> 4), f = flags[i];
        const px = f & 1 ? 15 - (mx & 15) : mx & 15, py = f & 2 ? 15 - (my & 15) : my & 15;
        const pen = pix[codes[i] + py * 16 + px];
        if (!pen) continue;
        const o = y * win.w + x;
        frame[o] = palette[colors[i] + pen];
        pri[o] |= orPri;
      }
    }
  }
}

// ---------------------------------------------------------------- K053245 / K053244

// K053245 (with the 053244): 128 zoomable sprites of up to 8x8 16x16 cells,
// eight words each in 2K of RAM, drawn from a buffer the game copies the RAM
// into (by touching register 6). Higher "priority order" values are in front;
// the color byte goes to the board's callback for color and layer priority;
// a shadow bit makes pen 15 darken. The 053244 also reads the sprite ROM back.
const K53_STATE = ['ram', 'buffer', 'regs'];
export class K053245 {
  saveState() { return capture(this, K53_STATE); }
  loadState(s) { apply(this, K53_STATE, s); }

  // rom: the sprite ROM (deinterleaved); callback(code, color) -> { code, color, priority (a mask) }
  constructor(rom, callback) {
    this.rom = rom;
    this.callback = callback;
    this.count = rom.length / 128;
    this.pix = decodeTiles(rom, {
      count: this.count, width: 16, height: 16, planes: [24, 16, 8, 0],
      xs: [...run(0, 8), ...run(256, 8)], ys: [...run(0, 8, 32), ...run(512, 8, 32)], size: 1024,
    });
    this.reset();
  }
  reset() { this.ram = new Uint16Array(0x400); this.buffer = new Uint16Array(0x400); this.regs = new Uint8Array(16); }

  // Byte access: even bytes are each word's high half.
  read(o) { const w = this.ram[(o >> 1) & 0x3FF]; return o & 1 ? w & 0xFF : w >> 8; }
  write(o, v) { const i = (o >> 1) & 0x3FF; this.ram[i] = o & 1 ? (this.ram[i] & 0xFF00) | v : (this.ram[i] & 0xFF) | (v << 8); }
  readReg(o) {
    const r = this.regs;
    if ((r[5] & 0x10) && o >= 0x0C && o < 0x10) {
      const addr = ((r[11] & 7) << 18) | (r[8] << 10) | (r[9] << 2) | ((o & 3) ^ 1);
      return this.rom[addr & (this.rom.length - 1)];
    }
    if (o === 6) this.buffer.set(this.ram);
    return 0;
  }
  writeReg(o, v) { this.regs[o] = v; if (o === 6) this.buffer.set(this.ram); }

  // Front to back: a sprite pixel hidden by the layers (its mask bit for the
  // pri-buffer value is set) still blocks the sprites behind it.
  draw(frame, pri, palette, win) {
    const b = this.buffer, list = new Int32Array(128).fill(-1);
    for (let offs = 0; offs < 0x400; offs += 8) {
      if (b[offs] & 0x8000) { const p = b[offs] & 0x7F; if (list[p] < 0) list[p] = offs; }
    }
    const r = this.regs, offX = (r[0] << 8) | r[1], offY = (r[2] << 8) | r[3], pix = this.pix, cnt = this.count;
    for (let k = 127; k >= 0; k--) {                 // the highest priority order is in front
      const offs = list[k];
      if (offs < 0) continue;
      let code = b[offs + 1];
      code = (code & 0xFFE1) + ((code & 0x10) >> 2) + ((code & 8) << 1) + ((code & 4) >> 1) + ((code & 2) << 2);
      const t = this.callback(code, b[offs + 6] & 0xFF);
      code = t.code;
      const mask = t.priority || 0, colorBase = t.color * 16;
      const size = (b[offs] & 0x0F00) >> 8, w = 1 << (size & 3), h = 1 << ((size >> 2) & 3);
      const zy0 = b[offs + 4];
      if (zy0 > 0x2000) continue;
      const zoomy = zy0 ? Math.floor((0x400000 + (zy0 >> 1)) / zy0) : 0x800000;
      let zoomx = zoomy;
      if (!(b[offs] & 0x4000)) {
        const zx0 = b[offs + 5];
        if (zx0 > 0x2000) continue;
        zoomx = zx0 ? Math.floor((0x400000 + (zx0 >> 1)) / zx0) : 0x800000;
      }
      let flipX = b[offs] & 0x1000, flipY = b[offs] & 0x2000;
      const mirrorX = b[offs + 6] & 0x100, mirrorY = b[offs + 6] & 0x200, shadow = b[offs + 6] & 0x80;
      if (mirrorX) flipX = 0;
      // Register 5: flip the whole sprite layer horizontally (bit 0) or vertically (bit 1).
      let ox = b[offs + 3] + offX, oy = b[offs + 2];
      if (r[5] & 1) { ox = 512 - ox; if (!mirrorX) flipX = !flipX; }
      if (r[5] & 2) { oy = -oy; if (!mirrorY) flipY = !flipY; }
      ox = (ox + 0x5D) & 0x3FF; if (ox >= 768) ox -= 1024;
      oy = (-(oy + offY + 7)) & 0x3FF; if (oy >= 640) oy -= 1024;
      ox -= (zoomx * w) >> 13; oy -= (zoomy * h) >> 13;
      for (let cy = 0; cy < h; cy++) {
        const sy = oy + ((zoomy * cy + 0x800) >> 12), ch = oy + ((zoomy * (cy + 1) + 0x800) >> 12) - sy;
        for (let cx = 0; cx < w; cx++) {
          const sx = ox + ((zoomx * cx + 0x800) >> 12), cw = ox + ((zoomx * (cx + 1) + 0x800) >> 12) - sx;
          let c = code, fx, fy;
          if (mirrorX) { if (!flipX ^ (2 * cx < w)) { c += w - cx - 1; fx = 1; } else { c += cx; fx = 0; } }
          else { c += flipX ? w - 1 - cx : cx; fx = flipX; }
          if (mirrorY) { if (!flipY ^ (2 * cy >= h)) { c += 8 * (h - cy - 1); fy = 1; } else { c += 8 * cy; fy = 0; } }
          else { c += 8 * (flipY ? h - 1 - cy : cy); fy = flipY; }
          c = ((c & 0x3F) | (code & ~0x3F)) % cnt;
          for (let y = 0; y < ch; y++) {
            const py = sy + y - win.y;
            if (py < 0 || py >= win.h) continue;
            let srcY = Math.floor((y * 16) / ch); if (fy) srcY = 15 - srcY;
            for (let x = 0; x < cw; x++) {
              const px = sx + x - win.x;
              if (px < 0 || px >= win.w) continue;
              let srcX = Math.floor((x * 16) / cw); if (fx) srcX = 15 - srcX;
              const pen = pix[c * 256 + srcY * 16 + srcX];
              if (!pen) continue;
              const o = py * win.w + px;
              if (pri[o] & 0x80) continue;
              const hidden = (mask >> (pri[o] & 0x1F)) & 1;
              pri[o] |= 0x80;
              if (hidden) continue;
              frame[o] = shadow && pen === 15 ? darken(frame[o]) : palette[colorBase + pen];
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- K053251

// K053251: the priority and palette-bank mixer. Registers 0-8 hold each
// input's priority; 9 and 10 the palette bases of the five inputs (CI0-CI4).
export class K053251 {
  saveState() { return { ram: Array.from(this.ram) }; }
  loadState(s) { this.ram.set(s.ram); }
  constructor() { this.ram = new Uint8Array(16); }
  reset() { this.ram.fill(0); }
  write(o, v) { this.ram[o & 15] = v & 0x3F; }
  priority(ci) { return this.ram[ci]; }
  paletteIndex(ci) {
    const r = this.ram;
    return ci < 3 ? 32 * ((r[9] >> (2 * ci)) & 3) : 16 * ((r[10] >> (3 * (ci - 3))) & 7);
  }
}

// ---------------------------------------------------------------- K053246 / K053247

// K053247 (with the 053246): 256 zoomable sprites of up to 8x8 16x16 cells
// at 4 bits per pixel (packed nibbles), eight words each. They're drawn in
// order of an 8-bit z code (smaller in front); word 6 is the "color" the
// board interprets, plus mirror bits and a shadow code that makes the last
// pen darken. Positions wrap at 1024 and are offset by the board's dx/dy.
// The 053246's registers hold the global offsets, flips, the DMA enable
// (5 bit 4) and the ROM read address.
const K47_STATE = ['ram', 'regs'];
const XO47 = [0, 1, 4, 5, 16, 17, 20, 21], YO47 = [0, 2, 8, 10, 32, 34, 40, 42];
export class K053247 {
  saveState() { return capture(this, K47_STATE); }
  loadState(s) { apply(this, K47_STATE, s); }

  // rom: the sprite ROM (deinterleaved by 4); callback(code, color word) -> { code, color, priority (a mask) }
  constructor(rom, callback, dx, dy) {
    this.rom = rom;
    this.callback = callback;
    this.dx = dx; this.dy = dy;
    this.count = rom.length / 128;
    this.pix = decodeTiles(rom, {
      count: this.count, width: 16, height: 16, planes: [0, 1, 2, 3],
      xs: [8, 12, 0, 4, 24, 28, 16, 20, 40, 44, 32, 36, 56, 60, 48, 52], ys: run(0, 16, 64), size: 1024,
    });
    this.reset();
  }
  reset() { this.ram = new Uint16Array(0x800); this.regs = new Uint8Array(8); }

  writeReg(o, v) { this.regs[o & 7] = v; }
  get dmaEnabled() { return this.regs[5] & 0x10; }
  // ROM read-back (when the board raises OBJCHA).
  readRom(o) {
    const r = this.regs, addr = (r[6] << 17) | (r[7] << 9) | (r[4] << 1) | ((o & 1) ^ 1);
    return this.rom[addr & (this.rom.length - 1)];
  }

  draw(frame, pri, palette, win) {
    const ram = this.ram, r = this.regs, s16 = (v) => (v << 16) >> 16;
    const list = [];
    for (let offs = 0; offs < 0x800; offs += 8) if (ram[offs] & 0x8000) list.push(offs);
    // Smallest z code in front; we draw front to back (the first sprite at a pixel wins).
    list.sort((a, b) => (ram[a] & 0xFF) - (ram[b] & 0xFF));
    const offx = s16((r[0] << 8) | r[1]) & 0x3FF, offy = s16((r[2] << 8) | r[3]) & 0x3FF, pix = this.pix, cnt = this.count;
    for (const offs of list) {
      const attr = ram[offs], word6 = ram[offs + 6];
      const t = this.callback(ram[offs + 1], word6);
      let code = t.code;
      const mask = t.priority || 0, colorBase = t.color * 16;
      const size = (attr & 0x0F00) >> 8, w = 1 << (size & 3), h = 1 << ((size >> 2) & 3);
      let xa = 0, ya = 0;
      if (code & 1) xa += 1; if (code & 2) ya += 1; if (code & 4) xa += 2;
      if (code & 8) ya += 2; if (code & 0x10) xa += 4; if (code & 0x20) ya += 4;
      code &= ~0x3F;
      let oy = ram[offs + 2] & 0x3FF, ox = ram[offs + 3] & 0x3FF;
      const zy0 = ram[offs + 4] & 0x3FF, zoomy = zy0 ? Math.floor((0x400000 + (zy0 >> 1)) / zy0) : 0x800000;
      let zoomx = zoomy;
      if (!(attr & 0x4000)) { const zx0 = ram[offs + 5] & 0x3FF; zoomx = zx0 ? Math.floor((0x400000 + (zx0 >> 1)) / zx0) : 0x800000; }
      let flipX = attr & 0x1000, flipY = attr & 0x2000;
      const mirrorX = word6 & 0x4000, mirrorY = word6 & 0x8000, shadow = (word6 >> 10) & 3;
      if (mirrorX) flipX = 0;
      if (r[5] & 1) { ox = -ox; if (!mirrorX) flipX = !flipX; }
      if (r[5] & 2) { oy = -oy; if (!mirrorY) flipY = !flipY; }
      ox = (ox - offx) & 0x3FF; oy = (-oy - offy) & 0x3FF;
      if (ox >= 0x300) ox -= 0x400; if (oy >= 0x280) oy -= 0x400;
      ox += this.dx; oy -= this.dy;
      ox -= (zoomx * w) >> 13; oy -= (zoomy * h) >> 13;
      const cell = (c, fx, fy, sx, sy, cw, ch) => {
        for (let y = 0; y < ch; y++) {
          const py = sy + y - win.y;
          if (py < 0 || py >= win.h) continue;
          let srcY = Math.floor((y * 16) / ch); if (fy) srcY = 15 - srcY;
          for (let x = 0; x < cw; x++) {
            const px = sx + x - win.x;
            if (px < 0 || px >= win.w) continue;
            let srcX = Math.floor((x * 16) / cw); if (fx) srcX = 15 - srcX;
            const pen = pix[c * 256 + srcY * 16 + srcX];
            if (!pen) continue;
            const o = py * win.w + px;
            if (pri[o] & 0x80) continue;
            const hidden = (mask >> (pri[o] & 0x1F)) & 1;
            pri[o] |= 0x80;
            if (hidden) continue;
            frame[o] = shadow && pen === 15 ? darken(frame[o]) : palette[colorBase + pen];
          }
        }
      };
      for (let cy = 0; cy < h; cy++) {
        const sy = oy + ((zoomy * cy + 0x800) >> 12), ch = oy + ((zoomy * (cy + 1) + 0x800) >> 12) - sy;
        for (let cx = 0; cx < w; cx++) {
          const sx = ox + ((zoomx * cx + 0x800) >> 12), cw = ox + ((zoomx * (cx + 1) + 0x800) >> 12) - sx;
          let c = code, fx, fy;
          if (mirrorX) { if (!flipX ^ (2 * cx < w)) { c += XO47[(w - 1 - cx + xa) & 7]; fx = 1; } else { c += XO47[(cx + xa) & 7]; fx = 0; } }
          else { c += XO47[(flipX ? w - 1 - cx : cx) + xa & 7]; fx = flipX; }
          if (mirrorY) { if (!flipY ^ (2 * cy >= h)) { c += YO47[(h - 1 - cy + ya) & 7]; fy = 1; } else { c += YO47[(cy + ya) & 7]; fy = 0; } }
          else { c += YO47[(flipY ? h - 1 - cy : cy) + ya & 7]; fy = flipY; }
          c %= cnt;
          cell(c, fx, fy, sx, sy, cw, ch);
          if (mirrorY && h === 1) cell(c, fx, !fy, sx, sy, cw, ch);   // (the Simpsons' shadows)
        }
      }
    }
  }
}
