// Taito SJ system (1981-84): Elevator Action, Jungle King, Front Line.
//
// A 4 MHz Z80 with its graphics in RAM: the game copies them out of the
// graphics ROMs (read a byte at a time through a port) into two 3-bit sets of
// 256 8x8 characters and 64 16x16 sprites. Three 32x32 character layers scroll
// independently, each column of each layer with its own vertical scroll; up
// to 24 sprites; a PROM sets the order of the four planes. The hardware also
// detects collisions (sprite with sprite, sprite with each layer) in pixels,
// which the games read back. A second Z80 runs three AY-3-8910s and a DAC
// (the first AY, on the main board, reads two of the DIP banks). Some games
// add a 68705 microcontroller that talks to the Z80 through latches and can
// read and write its memory directly.

import { Z80 } from './z80.js';
import { M6805 } from './m6805.js';
import { AY8910 } from './ay8910.js';
import { SoundMix } from './mixer.js';
import { rgba, rotate270 } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16;
const LINES = 256;
const SAMPLES_PER_LINE = 48000 / 60 / LINES;

// The DAC's volume control (AY #2 port B) through its resistor network.
const VOLTABLE = [255,254,252,251,249,247,246,244,243,242,241,239,238,236,235,234,232,231,229,228,226,225,224,223,222,221,220,219,217,216,215,214,213,212,211,210,209,208,207,206,205,204,203,202,201,200,199,198,197,196,195,194,193,192,191,191,190,189,188,187,186,186,185,184,183,183,182,181,180,179,179,178,177,177,176,175,174,174,173,172,171,170,170,169,168,168,167,166,166,165,165,164,163,162,162,161,161,160,160,159,158,158,157,157,156,156,155,155,154,153,153,152,151,151,150,150,149,149,148,148,147,147,146,146,145,145,144,144,139,139,138,138,137,137,137,136,136,135,135,135,134,134,133,133,132,132,131,131,130,130,130,129,129,129,128,128,127,127,127,126,126,126,125,125,124,124,124,123,123,123,122,122,122,121,121,121,120,120,119,119,119,118,118,118,117,117,117,116,116,116,115,115,115,115,114,114,114,113,113,113,112,112,112,112,111,111,111,110,110,110,109,109,109,108,108,108,108,107,107,107,107,106,106,106,106,105,105,105,104,104,104,104,104,103,103,103,102,102,102,102,101,101,101,101,100,100,100,100,100,99,99,99,99,98,98,98];

const STATE = ['ram', 'ram2', 'charRam', 'vram', 'colScroll', 'spriteRam', 'paletteRam', 'scroll', 'colorBank', 'soundRam',
  'priority', 'videoEnable', 'collision', 'gfxPointer', 'bank', 'soundLatch', 'nmiDisable', 'in5', 'dacOut', 'dacVol',
  'fromZ80', 'toZ80', 'zAccept', 'zReady', 'portAIn', 'portAOut', 'mcuAddr', 'busReq', 'mcuRam',
  'cycleCarry', 'soundCarry', 'mcuCarry', 'sampleCarry', 'soundIrqCarry', 'ip', 'cpu', 'snd', 'mcu', 'sound'];

class DAC {
  constructor(gain) { this.gain = gain; this.reset(); }
  reset() { this.value = 0; this.out = 0; }
  saveState() { return { value: this.value }; }
  loadState(s) { this.value = s.value; }
  sample() { this.out = this.value / 32768 * this.gain; }
}

export class TaitoSJ {
  saveState() { return capture(this, STATE); }
  loadState(s) {
    apply(this, STATE, s);
    for (let i = 0; i < 64; i++) this.setColor(i);
    this.dirty.fill(1);
  }

  // roms: { main (0x12000: 0000-7FFF, E000-EFFF, bank 1 at 10000), sound, gfx, prom (priority), mcu (optional) }
  constructor(roms) {
    const cfg = this.constructor.config;
    this.cfg = cfg;
    this.roms = roms;
    this.refresh = 60;
    this.width = cfg.rotate ? H : W;
    this.height = cfg.rotate ? W : H;
    this.ram = new Uint8Array(0x800);
    this.ram2 = new Uint8Array(0x400);          // C000-C3FF
    this.charRam = new Uint8Array(0x3000);      // 9000-BFFF: two sets of characters and sprites
    this.vram = new Uint8Array(0xC00);          // three layers of 32x32
    this.colScroll = new Uint8Array(0x60);
    this.spriteRam = new Uint8Array(0x100);
    this.paletteRam = new Uint8Array(0x80);
    this.scroll = new Uint8Array(6);
    this.colorBank = new Uint8Array(2);
    this.soundRam = new Uint8Array(0x400);
    this.collision = new Uint8Array(4);
    this.gfxPointer = new Uint8Array(2);
    this.mcuRam = new Uint8Array(0x80);
    this.palette = new Uint32Array(64);
    this.ip = new Uint8Array(8).fill(0xFF);
    // Decoded graphics, redone when the character RAM changes: [set][256 chars x 64] and [set][64 sprites x 256].
    this.charPix = [new Uint8Array(256 * 64), new Uint8Array(256 * 64)];
    this.spritePix = [new Uint8Array(64 * 256), new Uint8Array(64 * 256)];
    this.dirty = new Uint8Array(2);
    this.drawOrder = drawOrders(roms.prom);
    this.layers = [0, 1, 2].map(() => ({ chars: null, scrollX: 0, colY: new Int32Array(32) }));   // each layer's scroll set-up for the frame

    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v), input: () => 0xFF, output: () => {} });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.snd = new Z80({ read: (a) => this.sRead(a), write: (a, v) => this.sWrite(a, v), input: () => 0xFF, output: () => {} });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    if (roms.mcu) this.mcu = new M6805({ read: (a) => this.mRead(a), write: (a, v) => this.mWrite(a, v) });
    const clock = 1500000;
    this.ay = [
      new AY8910(clock, (p) => this.ip[6 + p], 0.15),                 // DIP banks B and C
      new AY8910(clock, () => 0xFF, 0.15),                            // its ports drive the DAC
      new AY8910(clock, () => 0xFF, 0.15),                            // port A: status to the main CPU
      new AY8910(clock, () => 0xFF, 0.3),                             // port B: the NMI mask
    ];
    this.ay[1].portOut = (p, v) => { if (p === 0) this.dacOut = v - 0x80; else this.dacVol = VOLTABLE[v]; this.dac.value = this.dacOut * this.dacVol; };
    this.ay[2].portOut = (p, v) => { if (p === 0) this.in5 = v & 0xF0; };
    this.ay[3].portOut = (p, v) => { if (p === 1) this.nmiDisable = v & 1; };
    this.dac = new DAC(0.25);
    this.sound = new SoundMix([...this.ay, this.dac], cfg.gain || 1.2);
    this.native = new Uint32Array(W * H);
    this.frame = cfg.rotate ? new Uint32Array(W * H) : this.native;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.ram2, this.charRam, this.vram, this.colScroll, this.spriteRam, this.paletteRam, this.scroll,
      this.colorBank, this.soundRam, this.collision, this.gfxPointer, this.mcuRam]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.dirty.fill(1);
    this.priority = 0; this.videoEnable = 0; this.bank = 0;
    this.soundLatch = 0; this.nmiDisable = 1; this.in5 = 0; this.dacOut = 0; this.dacVol = 0;
    this.fromZ80 = 0; this.toZ80 = 0; this.zAccept = 1; this.zReady = 0; this.portAIn = 0; this.portAOut = 0; this.mcuAddr = 0; this.busReq = 0;
    this.cycleCarry = this.soundCarry = this.mcuCarry = this.sampleCarry = this.soundIrqCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
    if (this.mcu) { this.mcu.reset(); this.mcu.irq = false; }
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x6000) return this.roms.main[a];
    if (a < 0x8000) return this.roms.main[(this.bank ? 0x10000 - 0x6000 : 0) + a] ?? 0xFF;
    if (a < 0x8800) return this.ram[a & 0x7FF];
    if (a < 0x9000) {
      if (!this.mcu) return a & 1 ? 0xFF : 0;
      if (a & 1) return ~((this.zReady << 0) | (this.zAccept << 1)) & 0xFF;
      this.zAccept = 1;
      return this.toZ80;
    }
    if (a < 0xC000) return this.charRam[a - 0x9000];
    if (a < 0xC400) return this.ram2[a & 0x3FF];
    if (a < 0xD000) return this.vram[a - 0xC400];
    if (a < 0xD100) return a < 0xD060 ? this.colScroll[a & 0x7F] : 0xFF;
    if (a < 0xD200) return this.spriteRam[a & 0xFF];
    if (a >= 0xD400 && a < 0xD500) {
      const r = a & 0x0F;
      if (r < 4) return this.collision[r];
      if (r < 8) return this.gfxRead();
      switch (r) {
        case 8: return this.ip[0];
        case 9: return this.ip[1];
        case 10: return this.ip[5];                   // DIP A
        case 11: return this.ip[2];
        case 12: return this.ip[3];
        case 13: return (this.ip[4] & 0x0F) | (this.in5 & 0xF0);
        case 15: return this.ay[0].read();
      }
      return 0xFF;
    }
    if (a >= 0xE000 && a < 0xF000) return this.roms.main[a];
    return 0xFF;
  }

  write(a, v) {
    if (a < 0x8000) return;
    if (a < 0x8800) { this.ram[a & 0x7FF] = v; return; }
    if (a < 0x9000) {
      if (this.mcu && !(a & 1)) { this.zReady = 1; this.fromZ80 = v; this.mcu.irq = true; }
      return;
    }
    if (a < 0xC000) {
      const o = a - 0x9000;
      if (this.charRam[o] !== v) { this.charRam[o] = v; this.dirty[o < 0x1800 ? 0 : 1] = 1; }
      return;
    }
    if (a < 0xC400) { this.ram2[a & 0x3FF] = v; return; }
    if (a < 0xD000) { this.vram[a - 0xC400] = v; return; }
    if (a < 0xD060) { this.colScroll[a & 0x7F] = v; return; }
    if (a >= 0xD100 && a < 0xD200) { this.spriteRam[a & 0xFF] = v; return; }
    if (a >= 0xD200 && a < 0xD280) { this.paletteRam[a & 0x7F] = v; this.setColor((a & 0x7F) >> 1); return; }
    if (a >= 0xD300 && a < 0xD400) { this.priority = v; return; }
    if (a >= 0xD400 && a < 0xD500) {
      const r = a & 0x0F;
      if (r === 14) this.ay[0].select(v); else if (r === 15) this.ay[0].write(v);
      return;
    }
    if (a >= 0xD500 && a < 0xD600) {
      const r = a & 0x0F;
      if (r < 6) this.scroll[r] = v;
      else if (r < 8) this.colorBank[r - 6] = v;
      else if (r === 8) this.collision.fill(0);
      else if (r < 11) this.gfxPointer[r - 9] = v;
      else if (r === 11) { this.soundLatch = v; if (!this.nmiDisable) this.snd.nmi(); }
      else if (r === 14) this.bank = v & 0x80;
      return;
    }
    if (a >= 0xD600 && a < 0xD700) this.videoEnable = v;
  }

  // The graphics ROMs, a byte at a time from an auto-incrementing pointer.
  gfxRead() {
    const p = this.gfxPointer[0] | (this.gfxPointer[1] << 8);
    this.gfxPointer[0] = (this.gfxPointer[0] + 1) & 0xFF;
    if (!this.gfxPointer[0]) this.gfxPointer[1] = (this.gfxPointer[1] + 1) & 0xFF;
    return p < 0x8000 ? this.roms.gfx[p] ?? 0 : 0;
  }

  // 9-bit color from a pair of bytes, every bit inverted.
  setColor(i) {
    const even = ~this.paletteRam[i * 2], odd = ~this.paletteRam[i * 2 + 1];
    const c = (b0, b1, b2) => 0x21 * (b0 & 1) + 0x47 * (b1 & 1) + 0x97 * (b2 & 1);
    this.palette[i] = rgba(c(odd >> 6, odd >> 7, even), c(odd >> 3, odd >> 4, odd >> 5), c(odd, odd >> 1, odd >> 2));
  }

  // ---------------------------------------------------------------- sound CPU

  sRead(a) {
    if (a < 0x4000) return this.roms.sound[a] ?? 0xFF;
    if (a < 0x4800) return this.soundRam[a & 0x3FF];
    if (a < 0x5000) {
      const r = a & 7;
      if (r === 1) return this.ay[1].read();
      if (r === 3) return this.ay[2].read();
      if (r === 5) return this.ay[3].read();
      return 0xFF;
    }
    if (a < 0x5800) {
      const r = a & 3;
      if (r === 0) return this.soundLatch;
      if (r === 1) return 0x03;
      return 0xFF;
    }
    return 0xFF;
  }

  sWrite(a, v) {
    if (a >= 0x4000 && a < 0x4800) { this.soundRam[a & 0x3FF] = v; return; }
    if (a >= 0x4800 && a < 0x5000) {
      const n = 1 + ((a & 7) >> 1);
      if (n > 3) return;
      if (a & 1) this.ay[n].write(v); else this.ay[n].select(v);
    }
  }

  // ---------------------------------------------------------------- the 68705

  mRead(a) {
    a &= 0x7FF;
    if (a === 0) return this.portAIn;
    if (a === 1) return 0xFF;
    if (a === 2) return this.zReady | (this.zAccept << 1) | ((this.busReq ^ 1) << 2);      // bit 2: the Z80 has granted the bus
    if (a < 0x80) return this.mcuRam[a];
    return this.roms.mcu[a];
  }

  // Port B's low-active outputs: read the Z80's byte, hand one back, and
  // read or write the Z80's memory at a latched address.
  mWrite(a, v) {
    a &= 0x7FF;
    if (a === 0) { this.portAOut = v; return; }
    if (a === 1) {
      if (!(v & 0x02)) { this.zReady = 0; this.mcu.irq = false; this.portAIn = this.fromZ80; }
      this.busReq = v & 0x08 ? 0 : 1;
      if (!(v & 0x04)) { this.toZ80 = this.portAOut; this.zAccept = 0; }
      if (!(v & 0x10)) { this.write(this.mcuAddr, this.portAOut); this.mcuAddr = (this.mcuAddr & 0xFF00) | ((this.mcuAddr + 1) & 0xFF); }
      if (!(v & 0x20)) this.portAIn = this.read(this.mcuAddr);
      if (!(v & 0x40)) this.mcuAddr = (this.mcuAddr & 0xFF00) | this.portAOut;
      if (!(v & 0x80)) this.mcuAddr = (this.mcuAddr & 0x00FF) | (this.portAOut << 8);
      return;
    }
    if (a >= 3 && a < 0x80) this.mcuRam[a] = v;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const mainPerLine = 4000000 / 60 / LINES, sndPerLine = 3000000 / 60 / LINES, mcuPerLine = 750000 / 60 / LINES;
    const soundIrqPerLine = 6000000 / (4 * 16 * 16 * 10 * 16) / 60 / LINES;   // about 36.6 Hz
    for (let line = 0; line < LINES; line++) {
      if (line === 240) this.cpu.irq = true;
      this.cycleCarry += mainPerLine;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      if (this.mcu) {
        this.mcuCarry += mcuPerLine;
        this.mcuCarry -= this.mcu.run(Math.floor(this.mcuCarry));
      }
      this.soundIrqCarry += soundIrqPerLine;
      if (this.soundIrqCarry >= 1) { this.soundIrqCarry -= 1; this.snd.irq = true; }
      this.soundCarry += sndPerLine;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    this.render();
  }

  // ---------------------------------------------------------------- video

  decodeGraphics(set) {
    const ram = this.charRam, base = set * 0x1800, cp = this.charPix[set], sp = this.spritePix[set];
    const bit = (o, b) => (ram[base + o] >> b) & 1;
    // Characters: three planes 0x1000, 0x800 and 0 bytes in; bit 0 is the leftmost pixel.
    for (let c = 0; c < 256; c++) {
      for (let y = 0; y < 8; y++) {
        const o = c * 8 + y;
        for (let x = 0; x < 8; x++) cp[c * 64 + y * 8 + x] = (bit(0x1000 + o, x) << 2) | (bit(0x800 + o, x) << 1) | bit(o, x);
      }
    }
    // Sprites: the same planes; 16x16 as four 8x8 quarters (left column then right).
    for (let s = 0; s < 64; s++) {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const o = s * 32 + (x >> 3) * 8 + (y >> 3) * 16 + (y & 7);
          sp[s * 256 + y * 16 + x] = (bit(0x1000 + o, x & 7) << 2) | (bit(0x800 + o, x & 7) << 1) | bit(o, x & 7);
        }
      }
    }
  }

  // A layer's scroll set-up for this frame: one X scroll for the layer, a Y scroll per column.
  setupLayer(n) {
    const L = this.layers[n];
    const bankBit = [this.colorBank[0] & 0x08, this.colorBank[0] & 0x80, this.colorBank[1] & 0x08][n];
    L.chars = this.charPix[bankBit ? 1 : 0];
    const sx = this.scroll[2 * n], fudge1 = [3, 1, -1][n], fudge2 = [8, 10, 12][n];
    L.scrollX = -(sx & 0xF8) + ((sx + fudge1) & 7) + fudge2;
    for (let col = 0; col < 32; col++) L.colY[col] = -this.colScroll[32 * n + col] - this.scroll[2 * n + 1];
  }

  // Layer n's pen at screen position (x, y), both 0-255.
  layerPixel(n, x, y) {
    const L = this.layers[n], srcX = (x - L.scrollX) & 255, col = srcX >> 3, srcY = (y - L.colY[col]) & 255;
    return L.chars[this.vram[n * 0x400 + (srcY >> 3) * 32 + col] * 64 + (srcY & 7) * 8 + (srcX & 7)];
  }

  spriteXY(i) {
    const s = this.spriteRam, o = (this.videoEnable & 4 ? 0x80 : 0) + i * 4;
    return { o, sx: (s[o] - 1) & 0xFF, sy: (240 - s[o + 1]) & 0xFF };
  }

  spritePixels(o) {
    const s = this.spriteRam;
    return { pix: this.spritePix[s[o + 3] & 0x40 ? 1 : 0], code: s[o + 3] & 0x3F, flipX: s[o + 2] & 1, flipY: s[o + 2] & 2 };
  }

  render() {
    for (let set = 0; set < 2; set++) if (this.dirty[set]) { this.decodeGraphics(set); this.dirty[set] = 0; }
    const ve = this.videoEnable;
    for (let n = 0; n < 3; n++) if (ve & (0x10 << n)) this.setupLayer(n);
    const out = this.native, pal = this.palette;
    out.fill(pal[8 * (this.colorBank[1] & 7)]);
    const colorOf = [this.colorBank[0] & 7, (this.colorBank[0] >> 4) & 7, this.colorBank[1] & 7];
    for (const plane of this.drawOrder[this.priority & 0x1F]) {
      if (plane === 0) { if (ve & 0x80) this.drawSprites(); continue; }
      const n = plane - 1;
      if (!(ve & (0x10 << n))) continue;
      const L = this.layers[n], chars = L.chars, colY = L.colY, scrollX = L.scrollX, vram = this.vram, vbase = n * 0x400, base = colorOf[n] * 8;
      for (let y = 0; y < H; y++) {
        const sy = y + TOP, dst = y * W;
        for (let x = 0; x < W; x++) {
          const srcX = (x - scrollX) & 255, col = srcX >> 3, srcY = (sy - colY[col]) & 255;
          const p = chars[vram[vbase + (srcY >> 3) * 32 + col] * 64 + (srcY & 7) * 8 + (srcX & 7)];
          if (p) out[dst + x] = pal[base + p];
        }
      }
    }
    if (ve & 0x80) this.collide();
    if (this.cfg.rotate) rotate270(out, W, H, this.frame);
  }

  // Sprites 0-15 and 24-31, the last one first; clipped 3 pixels in from the left and 1 from the right.
  drawSprites() {
    const out = this.native, pal = this.palette, bank = 2 * ((this.colorBank[1] >> 4) & 3);
    for (let n = 31; n >= 0; n--) {
      const i = (n - 1) & 31;
      if (i >= 0x10 && i <= 0x17) continue;
      const { o, sx, sy } = this.spriteXY(i);
      if (sy >= 240) continue;
      const { pix, code, flipX, flipY } = this.spritePixels(o);
      const color = (bank + ((this.spriteRam[o + 2] >> 2) & 1)) * 8;
      for (const dx of [sx, sx - 256]) {
        for (let y = 0; y < 16; y++) {
          const ty = sy + y;
          if (ty < TOP || ty >= TOP + H) continue;
          const row = code * 256 + (flipY ? 15 - y : y) * 16;
          for (let x = 0; x < 16; x++) {
            const tx = dx + x;
            if (tx < 3 || tx > 254) continue;
            const p = pix[row + (flipX ? 15 - x : x)];
            if (p) out[(ty - TOP) * W + tx] = pal[color + p];
          }
        }
      }
    }
  }

  // The hardware's collision detection, in pixels: each pair of sprites (the
  // higher-numbered one is flagged, except that sprite 31 counts as first),
  // and each sprite with each enabled layer.
  collide() {
    const list = [];
    for (let i = 0; i < 32; i++) {
      if (i >= 0x10 && i <= 0x17) continue;
      const p = this.spriteXY(i);
      if (p.sy < 240) list.push({ i, ...p, ...this.spritePixels(p.o) });
    }
    const pen = (s, x, y) => s.pix[s.code * 256 + (s.flipY ? 15 - y : y) * 16 + (s.flipX ? 15 - x : x)];
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const s1 = list[a], s2 = list[b];
        const dx = ((s2.sx - s1.sx) << 24) >> 24, dy = ((s2.sy - s1.sy) << 24) >> 24;
        if (Math.abs(dx) >= 16 || Math.abs(dy) >= 16) continue;
        let hit = false;
        for (let y = Math.max(0, dy); y < Math.min(16, 16 + dy) && !hit; y++) {
          for (let x = Math.max(0, dx); x < Math.min(16, 16 + dx); x++) {
            if (pen(s1, x, y) && pen(s2, x - dx, y - dy)) { hit = true; break; }
          }
        }
        if (!hit) continue;
        const j = s2.i === 31 ? s1.i : s2.i;
        this.collision[Math.min(2, j >> 3)] |= 1 << (j & 7);
      }
    }
    const ve = this.videoEnable;
    for (const s of list) {
      let result = 0;
      for (let y = 0; y < 16; y++) {
        const ty = s.sy + y;
        if (ty > 255) break;
        for (let x = 0; x < 16; x++) {
          const tx = s.sx + x;
          if (tx > 255) break;
          if (!pen(s, x, y)) continue;
          for (let n = 0; n < 3; n++) if ((ve & (0x10 << n)) && this.layerPixel(n, tx, ty)) result |= 1 << n;
        }
      }
      this.collision[3] |= result;
    }
  }
}

// The priority PROM to a drawing order for each value of the priority
// register: four planes (0 sprites, 1-3 the layers), back to front.
function drawOrders(prom) {
  const orders = [];
  for (let i = 0; i < 32; i++) {
    const order = new Array(4);
    let mask = 0;
    for (let j = 3; j >= 0; j--) {
      let d = prom[0x10 * (i & 0x0F) + mask];
      if (i & 0x10) d >>= 2;
      d &= 3;
      mask |= 1 << d;
      order[j] = d;
    }
    orders.push(order);
  }
  return orders;
}

// ---------------------------------------------------------------- games

// IN0: left, right, down, up, button 1, button 2. IN2: coins, starts. IN3: coin 3 (high), tilt.
function commonInputs(s, ip) {
  ip[0] = 0xFF & ~((s.left ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.down ? 0x04 : 0) | (s.up ? 0x08 : 0) | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0));
  ip[1] = 0xFF;
  ip[2] = 0xFF & ~((s.coin ? 0x20 : 0) | (s.start1 ? 0x40 : 0) | (s.start2 ? 0x80 : 0));
  ip[3] = 0xEF;
  ip[4] = 0xFF;
}

export class ElevatorAction extends TaitoSJ {
  constructor(roms) { super(roms); this.controls = 'eight-way'; this.buttons = 2; this.button2 = 'Jump'; }
  setInputs(s) { commonInputs(s, this.ip); }
  // DIP A: bonus, lives, upright. B: 1 coin 1 credit. C: difficulty, display options.
  applySwitches(v) { this.ip[5] = 0x7F & (0x64 | v.lives | v.bonus); this.ip[6] = 0x00; this.ip[7] = 0xFC | v.difficulty; }
}
ElevatorAction.config = { rotate: false };
ElevatorAction.id = 'elevator';
ElevatorAction.title = 'Elevator Action';
ElevatorAction.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x18], ['4', 0x10], ['5', 0x08], ['6', 0x00]], default: 0x18 },
  { id: 'bonus', label: 'Bonus life', options: [['10,000', 0x03], ['15,000', 0x02], ['20,000', 0x01], ['25,000', 0x00]], default: 0x03 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easiest', 0x03], ['Easy', 0x02], ['Normal', 0x01], ['Hard', 0x00]], default: 0x01 },
];

export class JungleKing extends TaitoSJ {
  constructor(roms) { super(roms); this.controls = 'eight-way'; this.buttons = 1; }
  setInputs(s) { commonInputs(s, this.ip); }
  applySwitches(v) { this.ip[5] = 0x7F & (0x64 | v.lives | 0x03); this.ip[6] = 0x00; this.ip[7] = 0xFF; }
}
JungleKing.config = { rotate: false };
JungleKing.id = 'junglek';
JungleKing.title = 'Jungle King';
JungleKing.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x18], ['4', 0x10], ['5', 0x08], ['6', 0x00]], default: 0x18 },
];

// Front Line: on the cabinet, the left stick moves the soldier and the right
// (a rotary knob with the fire button) aims. Here he aims where he's moving,
// and keeps aiming that way when he stops; fire and grenade are buttons.
export class FrontLine extends TaitoSJ {
  constructor(roms) { super(roms); this.controls = 'eight-way'; this.buttons = 2; this.button2 = 'Grenade'; }
  // IN3: the movement stick (and coin 3, tilt). IN0: the aiming stick and the buttons.
  setInputs(s) {
    commonInputs(s, this.ip);
    const dir = (s.left ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.down ? 0x04 : 0) | (s.up ? 0x08 : 0);
    this.ip[3] = 0xEF & ~dir;
  }
  applySwitches(v) { this.ip[5] = 0x7F & (0x64 | v.lives | 0x03); this.ip[6] = 0x00; this.ip[7] = 0xFF; }
}
FrontLine.config = { rotate: true };
FrontLine.id = 'frontlin';
FrontLine.title = 'Front Line';
FrontLine.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x18], ['4', 0x10], ['5', 0x08], ['6', 0x00]], default: 0x18 },
];
