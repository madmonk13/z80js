// Capcom CP System (CPS-1, 1988-92): a 68000 at 10 MHz (12 on Street
// Fighter II), a Z80 at 3.58 MHz for sound with a YM2151 and an OKI MSM6295,
// and the CPS-A/CPS-B custom video chips.
//
// Video comes from 192K of graphics RAM at 900000, which the game carves up
// through base registers: three tile layers (8x8, 16x16 and 32x32 tiles,
// each map 64x64 tiles), a 256-entry sprite list (16x16 tiles, grouped into
// blocks up to 16x16 tiles), "other" RAM for the 16x16 layer's row scroll,
// and the palette (192 palettes of 16 colors, 4-bit RGB with a brightness
// nibble). All graphics are 4 bits per pixel from one shared ROM space; pen
// 15 is see-through. A layer control register stacks the three layers and
// the sprites in any order, and the layer just under the sprites can hold
// some of its pens in front of them, chosen per tile by four priority masks.
// The CPS-B chip differs per game: which registers are where, which bits
// enable which layer, and an ID value the game checks at boot.
//
// Sprites are double-buffered (the list drawn is last frame's); the 68000
// gets a level-2 interrupt at vertical blank, the Z80 its interrupts from the
// YM2151's timers. 384x224 at about 59.6 Hz.

import { M68000 } from './m68000.js';
import { Z80 } from './z80.js';
import { YM2151 } from './ym2151.js';
import { OKIM6295 } from './okim6295.js';
import { SoundMix } from './mixer.js';
import { rgba, rotate270 } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

export const W = 384, H = 224, LEFT = 64, TOP = 16;
const LINES = 262, REFRESH = 59.637;
const Z80_CLOCK = 3579545;

// CPS-B variants: [ID register, ID value, multiply factor 1, factor 2, result lo, result hi,
// layer control, [priority masks], [layer enables: scroll1, scroll2, scroll3, stars1, stars2]]
const CPS_B = {
  B01: [0x00, 0x0000, 0, 0, 0, 0, 0x66, [0x68, 0x6a, 0x6c, 0x6e], [0x02, 0x04, 0x08, 0x30, 0x30]],
  B04: [0x60, 0x0004, 0, 0, 0, 0, 0x6e, [0x66, 0x70, 0x68, 0x72], [0x02, 0x0c, 0x0c, 0x00, 0x00]],
  B05: [0x60, 0x0005, 0, 0, 0, 0, 0x68, [0x6a, 0x6c, 0x6e, 0x70], [0x02, 0x08, 0x20, 0x14, 0x14]],
  B11: [0x72, 0x0401, 0, 0, 0, 0, 0x66, [0x68, 0x6a, 0x6c, 0x6e], [0x08, 0x10, 0x20, 0x00, 0x00]],
  B12: [0x60, 0x0402, 0, 0, 0, 0, 0x6c, [0x6a, 0x68, 0x66, 0x64], [0x02, 0x04, 0x08, 0x00, 0x00]],
  BAT3: [0x00, 0x0000, 0x46, 0x44, 0x42, 0x40, 0x60, [0x6e, 0x6c, 0x6a, 0x68], [0x20, 0x12, 0x12, 0x00, 0x00]],
  BAT4: [0x00, 0x0000, 0x46, 0x44, 0x42, 0x40, 0x68, [0x66, 0x64, 0x62, 0x60], [0x20, 0x10, 0x02, 0x00, 0x00]],
  // CPS-2 boards all use this one.
  NOBATTRY: [0x00, 0x0000, 0x40, 0x42, 0x44, 0x46, 0x66, [0x68, 0x6a, 0x6c, 0x6e], [0x02, 0x04, 0x08, 0x30, 0x30]],
};

const STATE = ['ram', 'gfxram', 'out', 'objBuf', 'soundRam', 'latch', 'fade', 'bank', 'dialBase', 'frameCount',
  'cycleCarry', 'zCarry', 'sampleCarry', 'in0', 'in1', 'in2', 'dial', 'cpu', 'snd', 'ym', 'oki'];

export class CPS1 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (68000 space, big-endian), gfx (raw graphics ROM space), sound (Z80, 0x18000 with banks at 10000), samples }
  constructor(roms) {
    const cfg = this.constructor.config;
    this.cfg = cfg;
    const b = CPS_B[cfg.cpsb];
    this.cpsb = { idAddr: b[0], idValue: b[1], mul1: b[2], mul2: b[3], mulLo: b[4], mulHi: b[5], layer: b[6], prio: b[7], enable: b[8] };
    this.rotated = !!cfg.rotate;                 // vertical monitor (1941, Mercs)
    this.width = this.rotated ? H : W;
    this.height = this.rotated ? W : H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = cfg.buttons ?? 2;
    this.button2 = cfg.button2;
    if (cfg.dial) { this.dialControl = true; this.dialHint = ['Fire & turn', 'Hold to fire; push left or right to turn the gun']; this.dialSpeed = 6; }
    this.roms = roms;
    this.clock = cfg.clock || 10000000;

    this.ram = new Uint8Array(0x10000);
    this.gfxram = new Uint8Array(0x30000);
    this.out = new Uint16Array(0x80);          // CPS-A/B registers at 800100
    this.objBuf = new Uint8Array(0x800);
    this.soundRam = new Uint8Array(0x800);
    this.pixels = decodeGfx(roms.gfx);
    this.count16 = this.pixels.length / 256;
    this.palette = new Uint32Array(4096);
    this.native = new Uint32Array(W * H);
    this.frame = this.rotated ? new Uint32Array(W * H) : this.native;
    this.mask = new Uint8Array(W * H);         // pens of the layer under the sprites that stay in front of them
    this.lineBuf = new Uint16Array(W);

    this.cpu = new M68000({
      read8: (a) => this.read8(a), read16: (a) => this.read16(a),
      write8: (a, v) => this.write8(a, v), write16: (a, v) => this.write16(a, v),
    });
    this.cpu.onIrqAck = () => { this.cpu.irq = 0; };
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.ym = new YM2151(Z80_CLOCK, 1);
    this.oki = new OKIM6295(1000000, roms.samples || new Uint8Array(0x40000), 0.9);
    this.sound = new SoundMix([this.ym, this.oki], 1);
    this.in0 = 0xFF; this.in1 = 0xFFFF; this.in2 = 0xFF; this.dial = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.gfxram.fill(0); this.out.fill(0); this.objBuf.fill(0); this.soundRam.fill(0);
    // The registers' power-on defaults.
    this.out[0] = 0x9200; this.out[1] = 0x9000; this.out[2] = 0x9040; this.out[3] = 0x9080; this.out[4] = 0x9100; this.out[5] = 0x90C0;
    this.latch = 0; this.fade = 0; this.bank = 0; this.dialBase = 0; this.frameCount = 0;
    this.cycleCarry = this.zCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- 68000 bus

  read16(a) {
    if (a < 0x200000) { const r = this.roms.main; return a < r.length ? (r[a] << 8) | r[a + 1] : 0xFFFF; }
    if (a >= 0xFF0000) { const o = a & 0xFFFF; return (this.ram[o] << 8) | this.ram[o + 1]; }
    if (a >= 0x900000 && a < 0x930000) { const o = a - 0x900000; return (this.gfxram[o] << 8) | this.gfxram[o + 1]; }
    if (a >= 0x800000 && a < 0x800200) return this.io(a & 0x1FF);
    return 0xFFFF;
  }
  read8(a) { const w = this.read16(a & ~1); return a & 1 ? w & 0xFF : w >> 8; }

  write16(a, v) {
    if (a >= 0xFF0000) { const o = a & 0xFFFF; this.ram[o] = v >> 8; this.ram[o + 1] = v; return; }
    if (a >= 0x900000 && a < 0x930000) { const o = a - 0x900000; this.gfxram[o] = v >> 8; this.gfxram[o + 1] = v; return; }
    if (a >= 0x800000 && a < 0x800200) this.ioWrite(a & 0x1FF, v, 3);
  }
  write8(a, v) {
    if (a >= 0xFF0000) { this.ram[a & 0xFFFF] = v; return; }
    if (a >= 0x900000 && a < 0x930000) { this.gfxram[a - 0x900000] = v; return; }
    if (a >= 0x800000 && a < 0x800200) this.ioWrite(a & 0x1FE, a & 1 ? v : v << 8, a & 1 ? 1 : 2);
  }

  io(o) {
    switch (o) {
      case 0x00: case 0x10: return this.in1;
      case 0x18: return (this.in0 << 8) | this.in0;
      case 0x1A: return (this.dswA << 8) | this.dswA;
      case 0x1C: return (this.dswB << 8) | this.dswB;
      case 0x1E: return (this.dswC << 8) | this.dswC;
      case 0x52: case 0x54: { const d = (this.dial - this.dialBase) & 0xFFF; return o === 0x52 ? d & 0xFF : d >> 8; }   // Forgotten Worlds
      case 0x176: case 0x1FC: return (this.in2 << 8) | this.in2;
      case 0x178: return 0xFFFF;
    }
    if (o >= 0x100) {
      const r = o - 0x100, c = this.cpsb;
      if (r && r === c.idAddr) return c.idValue;
      if (r && c.mulLo && (r === c.mulLo || r === c.mulHi)) {
        const p = this.out[c.mul1 >> 1] * this.out[c.mul2 >> 1];
        return r === c.mulLo ? p & 0xFFFF : (p / 65536) & 0xFFFF;
      }
      return this.out[r >> 1];
    }
    return 0xFFFF;
  }

  // mask: 1 low byte, 2 high byte, 3 both.
  ioWrite(o, v, mask) {
    if (o === 0x40) { this.dialBase = this.dial; return; }
    if (o >= 0x100) {
      const i = (o - 0x100) >> 1, old = this.out[i];
      this.out[i] = mask === 3 ? v : mask === 1 ? (old & 0xFF00) | (v & 0xFF) : (old & 0xFF) | (v & 0xFF00);
      if (o === 0x180 && (mask & 1)) this.latch = v & 0xFF;
      if (o === 0x188 && (mask & 1)) this.fade = v & 0xFF;
    }
    // 800030 coin control.
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0xC000) { const s = this.roms.sound, len = s.length - 0x10000; return s[0x10000 + ((this.bank * 0x4000) & (len - 1)) + (a - 0x8000)]; }
    if (a >= 0xD000 && a < 0xD800) return this.soundRam[a - 0xD000];
    switch (a) {
      case 0xF001: return this.ym.read();
      case 0xF002: return this.oki.read();
      case 0xF008: return this.latch;
      case 0xF00A: return this.fade;
    }
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0xD000 && a < 0xD800) { this.soundRam[a - 0xD000] = v; return; }
    switch (a) {
      case 0xF000: this.ym.select(v); break;
      case 0xF001: this.ym.write(v); break;
      case 0xF002: this.oki.write(v); break;
      case 0xF004: this.bank = v; break;
      case 0xF006: this.oki.pin7 = v & 1; break;
    }
  }

  // ---------------------------------------------------------------- inputs

  // IN1: right, left, down, up, buttons 1-3 (active low; player 2 in the high byte). IN0: coins, starts.
  setInputs(s) {
    const cfg = this.cfg;
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x10 : 0) | (s.start2 ? 0x20 : 0)) & cfg.in0;
    let b = 0;
    for (const [flag, bit] of cfg.map) if (s[flag]) b |= bit;
    this.in1 = 0xFFFF & ~((s.right ? 1 : 0) | (s.left ? 2 : 0) | (s.down ? 4 : 0) | (s.up ? 8 : 0) | (b & 0xFF));
    this.in2 = 0xFF & ~(b >> 8);
    if (cfg.dial && s.spin) this.dial = (this.dial + Math.round(s.spin)) & 0xFFF;
  }
  applySwitches(v) {
    const d = this.cfg.dsw;
    this.dswA = d[0]; this.dswB = d[1]; this.dswC = d[2];
    if (v.lives !== undefined) this.dswC = (this.dswC & ~this.cfg.livesMask) | v.lives;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const cycles = this.clock / REFRESH / LINES, zCycles = Z80_CLOCK / REFRESH / LINES;
    const samples = 48000 / REFRESH / LINES, dt = 1 / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === TOP + H) {
        this.render();
        this.objBuf.set(this.gfxram.subarray(this.base(0, 0x800), this.base(0, 0x800) + 0x800));
        this.cpu.irq = 2;
        this.frameCount = (this.frameCount + 1) >>> 0;
      }
      this.cycleCarry += cycles;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.snd.irq = this.ym.irq;
      this.zCarry += zCycles;
      this.zCarry -= this.snd.run(Math.floor(this.zCarry));
      this.ym.timers(dt);
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // A video RAM area from its base register (the register holds address / 256), aligned down.
  base(reg, boundary) { return ((this.out[reg] * 256) & ~(boundary - 1)) & 0x3FFFF; }
  gw(o) { return (this.gfxram[o] << 8) | this.gfxram[o + 1]; }   // a word of graphics RAM

  // ---------------------------------------------------------------- video

  buildPalette() {
    const p = this.base(5, 0x800), pal = this.palette;
    for (let i = 0; i < 4096; i++) {
      const o = p + i * 2;
      const v = o < 0x30000 ? this.gw(o) : 0;
      const bright = 0x10 + (v >> 12);
      const r = Math.trunc(((v >> 8) & 15) * bright * 0x11 / 0x1F), g = Math.trunc(((v >> 4) & 15) * bright * 0x11 / 0x1F), b = Math.trunc((v & 15) * bright * 0x11 / 0x1F);
      pal[i] = rgba(r, g, b);
    }
  }

  render() {
    this.buildPalette();
    const out = this.native, pal = this.palette;
    out.fill(pal[4095]);
    this.mask.fill(0);
    const layerCtl = this.out[this.cpsb.layer >> 1], en = this.cpsb.enable;
    this.drawStars(layerCtl);
    const order = [(layerCtl >> 6) & 3, (layerCtl >> 8) & 3, (layerCtl >> 10) & 3, (layerCtl >> 12) & 3];
    for (let k = 0; k < 4; k++) {
      const l = order[k];
      if (l === 0) { this.drawSprites(); continue; }
      if (!(layerCtl & en[l - 1])) continue;
      // The layer right under the sprites marks the pens that stay in front of them.
      this.drawLayer(l, k < 3 && order[k + 1] === 0);
    }
    if (this.rotated) rotate270(out, W, H, this.frame);
  }

  drawStars(layerCtl) {
    const en = this.cpsb.enable, raw = this.roms.gfx, pal = this.palette, out = this.native;
    const blink = (this.frameCount >> 4) & 15;
    for (const [on, sxReg, base, off] of [[layerCtl & en[3], 0x1C, 0xA00, 4], [layerCtl & en[4], 0x18, 0x800, 0]]) {
      if (!on) continue;
      const scx = this.out[sxReg >> 1], scy = this.out[(sxReg + 2) >> 1];
      for (let offs = 0; offs < 0x1000; offs++) {
        let col = raw[8 * offs + off];
        if (col === 0x0F) continue;
        const sx = (((offs >> 8) * 32) - scx + (col & 0x1F)) & 0x1FF, sy = ((offs & 0xFF) - scy) & 0xFF;
        const x = sx - LEFT, y = sy - TOP;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        col = ((col & 0xE0) >> 1) + blink;
        out[y * W + x] = pal[base + col];
      }
    }
  }

  // Tile layers: 1 = 8x8, 2 = 16x16, 3 = 32x32. priBit (CPS-2): OR this into this.pri for every pixel drawn.
  drawLayer(l, front, priBit = 0) {
    const cfg = this.cfg, out = this.native, pal = this.palette, pix = this.pixels, mask = this.mask;
    const size = l === 1 ? 8 : l === 2 ? 16 : 32, shift = l === 1 ? 3 : l === 2 ? 4 : 5;
    const span = 64 * size - 1;
    const mapBase = this.base(l, 0x4000);
    const sx0 = this.out[(0x0C + (l - 1) * 4) >> 1], sy = this.out[(0x0E + (l - 1) * 4) >> 1];
    const rowScroll = l === 2 && (this.out[0x22 >> 1] & 1);
    const other = this.base(4, 0x800), otherOffs = this.out[0x20 >> 1];
    const palBase = l * 32;
    const prio = this.cpsb.prio.map((r) => (r ? this.out[r >> 1] : 0));
    const bank = (cfg.banks?.[l - 1] || 0) * (l === 1 ? 0x8000 : l === 2 ? 0x4000 : 0x1000);
    const [lo, hi] = l === 2 ? cfg.range2 || [0, 0xFFFF] : l === 3 ? cfg.range3 || [0, 0xFFFF] : [0, 0xFFFF];
    const maxTile = this.pixels.length / (size * size);
    for (let y = 0; y < H; y++) {
      const screenY = y + TOP;
      let scx = sx0;
      if (rowScroll) scx += this.gw(other + (((screenY + otherOffs) & 0x3FF) * 2) % 0x800);
      const my = (screenY + sy) & span, ty = my >> shift, py = my & (size - 1);
      let x = 0;
      while (x < W) {
        const mx = (x + LEFT + scx) & span, tx = mx >> shift;
        const run = Math.min(size - (mx & (size - 1)), W - x);
        let idx;
        if (l === 1) idx = (ty & 0x1F) + ((tx & 0x3F) << 5) + ((ty & 0x20) << 6);
        else if (l === 2) idx = (ty & 0x0F) + ((tx & 0x3F) << 4) + ((ty & 0x30) << 6);
        else idx = (ty & 0x07) + ((tx & 0x3F) << 3) + ((ty & 0x38) << 6);
        const o = mapBase + idx * 4;
        let code = this.gw(o & 0x3FFFF);
        const attr = this.gw((o + 2) & 0x3FFFF);
        let blank = false;
        if (l === 1) { if ((code === 0x0020 && !cfg.cps2) || (cfg.kludge === 3 && code === 0xF020)) blank = true; }
        else if (code < lo || code > hi || (l === 2 && cfg.kludge === 4 && code >= 0x1E00 && code < 0x5400)) blank = true;
        if (l === 3 && cfg.kludge === 2 && code < 0x0E00) code += 0x1000;
        code += bank;
        if (!blank && code < maxTile) {
          const flipX = attr & 0x20, flipY = attr & 0x40;
          const row = flipY ? size - 1 - py : py;
          const colBase = ((attr & 0x1F) + palBase) * 16;
          const hiMask = front ? prio[(attr >> 7) & 3] : 0;
          let src;
          if (l === 1) src = code * 128 + ((idx & 0x20) ? 8 : 0) + row * 16;
          else src = code * size * size + row * size;
          let px = mx & (size - 1);
          for (let i = 0; i < run; i++, px++) {
            const pen = pix[src + (flipX ? size - 1 - px : px)];
            if (pen === 15) continue;
            out[y * W + x + i] = pal[colBase + pen];
            if ((hiMask >> pen) & 1) mask[y * W + x + i] = 1;
            if (priBit) this.pri[y * W + x + i] |= priBit;
          }
        }
        x += run;
      }
    }
  }

  drawSprites() {
    const cfg = this.cfg, obj = this.objBuf, pix = this.pixels, out = this.native, pal = this.palette, mask = this.mask;
    let last = 0x800 / 8 - 1;
    for (let i = 0; i < 0x100; i++) {
      if ((((obj[i * 8 + 6] << 8) | obj[i * 8 + 7]) & 0xFF00) === 0xFF00) { last = i - 1; break; }
    }
    const draw = (code, col, fx, fy, sx, sy) => {
      if (code >= this.count16) return;
      const colBase = col * 16;
      for (let y = 0; y < 16; y++) {
        const py = sy + y - TOP;
        if (py < 0 || py >= H) continue;
        const src = code * 256 + (fy ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x - LEFT;
          if (px < 0 || px >= W) continue;
          const pen = pix[src + (fx ? 15 - x : x)];
          if (pen === 15 || mask[py * W + px]) continue;
          out[py * W + px] = pal[colBase + pen];
        }
      }
    };
    for (let i = last; i >= 0; i--) {
      const o = i * 8;
      const x = (obj[o] << 8) | obj[o + 1], y = (obj[o + 2] << 8) | obj[o + 3];
      let code = (obj[o + 4] << 8) | obj[o + 5];
      const attr = (obj[o + 6] << 8) | obj[o + 7], col = attr & 0x1F;
      if (cfg.kludge === 7) code += 0x4000;
      if (cfg.kludge === 1 && code >= 0x1000) code += 0x4000;
      const fx = attr & 0x20, fy = attr & 0x40;
      if (!(attr & 0xFF00)) { draw(code, col, fx, fy, x & 0x1FF, y & 0x1FF); continue; }
      // A block of nx by ny tiles; tile numbers wrap within each row of 16.
      const nx = ((attr >> 8) & 15) + 1, ny = ((attr >> 12) & 15) + 1;
      for (let j = 0; j < ny; j++) {
        for (let k = 0; k < nx; k++) {
          const cx = fx ? nx - 1 - k : k, cy = fy ? ny - 1 - j : j;
          const c = (code & ~0xF) + ((code + cx) & 0xF) + 0x10 * cy;
          draw(c, col, fx, fy, (x + k * 16) & 0x1FF, (y + j * 16) & 0x1FF);
        }
      }
    }
  }
}

// The graphics ROMs hold four bitplanes interleaved a byte at a time in each
// 32-bit group; unpack them to one pen per byte, eight pixels per group.
export function decodeGfx(raw) {
  const px = new Uint8Array(raw.length * 2);
  for (let i = 0, o = 0; i < raw.length; i += 4) {
    const b0 = raw[i], b1 = raw[i + 1], b2 = raw[i + 2], b3 = raw[i + 3];
    for (let j = 0; j < 8; j++, o++) {
      const m = 0x80 >> j;
      px[o] = (b0 & m ? 1 : 0) | (b1 & m ? 2 : 0) | (b2 & m ? 4 : 0) | (b3 & m ? 8 : 0);
    }
  }
  return px;
}

// ---------------------------------------------------------------- the games

const LIVES = (opts, def, mask) => ({ switches: [{ id: 'lives', label: 'Lives', options: opts, default: def }], livesMask: mask });

function game(cls, id, title, cfg, extra = {}) {
  cls.id = id; cls.title = title;
  cls.config = { in0: 0xFF, map: [['fire', 0x10], ['fire2', 0x20]], ...cfg };
  cls.switches = extra.switches || [];
  if (extra.livesMask) cls.config.livesMask = extra.livesMask;
  return cls;
}

export class Strider extends CPS1 {}
game(Strider, 'strider', 'Strider', { cpsb: 'B01', banks: [1, 0, 1], dsw: [0xFF, 0xBF, 0xFF], button2: 'Jump' },
  LIVES([['2', 0x00], ['3', 0x03], ['4', 0x02], ['5', 0x01]], 0x03, 0x03));

export class Mercs extends CPS1 {}
game(Mercs, 'mercs', 'Mercs', { cpsb: 'B12', range2: [0x0600, 0x5BFF], range3: [0x0700, 0x17FF], kludge: 4, rotate: true, dsw: [0xFF, 0xFC, 0x9F], button2: 'Bomb' });

export class FinalFight extends CPS1 {}
game(FinalFight, 'ffight', 'Final Fight', { cpsb: 'B04', range2: [0x0001, 0xFFFF], range3: [0x0001, 0xFFFF], dsw: [0xFF, 0xF4, 0x9F], button2: 'Jump' });

export class StreetFighter2 extends CPS1 {}
game(StreetFighter2, 'sf2', 'Street Fighter II', {
  cpsb: 'B11', banks: [2, 2, 2], clock: 12000000, dsw: [0xFF, 0xFC, 0x9F], button2: 'Kick',
  map: [['fire', 0x20], ['fire2', 0x200]],     // medium punch, medium kick
});

export class GhoulsNGhosts extends CPS1 {}
game(GhoulsNGhosts, 'ghouls', "Ghouls'n Ghosts", { cpsb: 'B01', kludge: 1, dsw: [0xFF, 0xFF, 0xFF], button2: 'Jump' });

export class ForgottenWorlds extends CPS1 {}
game(ForgottenWorlds, 'forgottn', 'Forgotten Worlds', { cpsb: 'B01', kludge: 7, dsw: [0xFF, 0xF4, 0xBF], buttons: 1, dial: true });

export class Game1941 extends CPS1 {}
game(Game1941, '1941', '1941: Counter Attack', { cpsb: 'B05', range3: [0x0400, 0x07FF], rotate: true, dsw: [0xFF, 0xFC, 0x9F], button2: 'Loop' });

export class Knights extends CPS1 {}
game(Knights, 'knights', 'Knights of the Round', { cpsb: 'BAT4', kludge: 3, dsw: [0xCF, 0xFC, 0x9F], button2: 'Jump' });

export class CaptainCommando extends CPS1 {}
game(CaptainCommando, 'captcomm', 'Captain Commando', { cpsb: 'BAT3', dsw: [0xFF, 0xF4, 0x9F], button2: 'Jump' });
