// Irem M72 family (1987-91): R-Type, Battle Chopper, Ninja Spirit, Image
// Fight, Legend of Hero Tonma, X Multiply, Dragon Breed, Air Duel, Gallop,
// R-Type II, Hammerin' Harry, Major Title.
// A NEC V30 at 8 MHz runs the game; a Z80 at 3.58 MHz plays music on a
// YM2151 and drum/voice samples through an 8-bit DAC (fed sample by sample
// from its NMI handler). R-Type's Z80 runs from RAM the main CPU loads.
//
// Video: two scrolling 64x64 maps of 8x8 tiles (4 bits per pixel) and 16x16
// sprites in blocks of up to 8x8 tiles, copied to a private buffer on
// request. Each tile picks one of three priority groups, which decide which
// of its pens draw under the sprites and which over them. Two palettes of
// 256 colors (sprites, tiles), 5 bits per gun. The main CPU gets a vertical
// blank interrupt and a programmable raster interrupt (R-Type uses it to
// stop the playfield scrolling under the status bar). 384x256 at 55 Hz.
//
// Most M72 games are protected by an 8751 microcontroller sharing RAM at
// B0000 (its program has never been read out). The game tests that RAM
// (which reads back inverted), then calls into it expecting the MCU's
// routine to leave a few identifying bytes in work and video RAM and jump to
// the game's entry point; the earlier games also get their sample start
// addresses from it. Here the board steps in when the CPU reaches B0000 and
// does what the routine is known to do (cfg.protection), and the sample
// addresses come from per-game tables.

import { V30 } from './v30.js';
import { Z80 } from './z80.js';
import { YM2151 } from './ym2151.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, rotate270, run } from './video.js';
import { capture, apply } from './state.js';

const W = 384, H = 256, LEFT = 64, TOP = 128;
const REFRESH = 55, LINES = 256;
const CPU_CLOCK = 8000000, Z80_CLOCK = 3579545;

const STATE = ['ram', 'spriteRam', 'spriteBuf', 'sprite2', 'pal1', 'pal2', 'vram1', 'vram2', 'rowScroll', 'soundRam', 'io',
  'prot', 'latch', 'irqVector', 'z80Held', 'videoOff', 'sampleAddr', 'rowScrollOn', 'nmiCarry', 'cycleCarry', 'zCarry', 'sampleCarry',
  'in0', 'in1', 'cpu', 'snd', 'ym'];

// A DAC fed by the sound CPU; holds the last value written.
class DAC {
  constructor() { this.reset(); }
  reset() { this.out = 0; this.level = 0; }
  sample() { this.out = this.level; }
  saveState() { return { level: this.level }; }
  loadState(s) { this.level = s.level; }
}

export class M72 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 256; i++) { this.setColor(0, i); this.setColor(1, i); } }

  // roms: { main (1MB space), sound (Z80, or null when it runs from RAM), sprites, tiles1, tiles2, sprites2, samples }
  constructor(roms) {
    const cfg = this.constructor.config;
    this.cfg = cfg;
    this.rotated = !!cfg.rotate;                 // vertical monitor (Image Fight, Air Duel)
    this.width = this.rotated ? H : W;
    this.height = this.rotated ? W : H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = cfg.buttons ?? 2;
    this.button2 = cfg.button2;
    this.roms = roms;

    this.ram = new Uint8Array(0x4000);
    this.spriteRam = new Uint8Array(0x400);
    this.spriteBuf = new Uint8Array(0x400);
    this.sprite2 = new Uint8Array(0x400);
    this.pal1 = new Uint16Array(0x600);
    this.pal2 = new Uint16Array(0x600);
    this.vram1 = new Uint8Array(0x4000);
    this.vram2 = new Uint8Array(cfg.layout === 'majtitle' ? 0x10000 : 0x4000);
    this.rowScroll = new Uint8Array(0x400);
    this.soundRam = new Uint8Array(roms.sound ? 0x1000 : 0x10000);
    this.prot = new Uint8Array(0x1000);
    this.io = new Uint8Array(0x100);
    this.palette = new Uint32Array(512).fill(0xFF000000);
    this.native = new Uint32Array(W * H);
    this.frame = this.rotated ? new Uint32Array(W * H) : this.native;
    this.pri = new Uint8Array(W);               // per pixel of the current line: 1 where a tile covers the sprites

    const tiles = (rom) => {
      const q = rom.length / 4 * 8;
      return decodeTiles(rom, { count: rom.length / 32, width: 8, height: 8, planes: [3 * q, 2 * q, q, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    };
    const sprites = (rom) => {
      const q = rom.length / 4 * 8;
      return decodeTiles(rom, { count: rom.length / 128, width: 16, height: 16, planes: [3 * q, 2 * q, q, 0], xs: [...run(0, 8), ...run(128, 8)], ys: run(0, 16, 8), size: 256 });
    };
    this.spritePix = sprites(roms.sprites);
    this.sprite2Pix = roms.sprites2 ? sprites(roms.sprites2) : null;
    this.tile1Pix = tiles(roms.tiles1);
    this.tile2Pix = roms.tiles2 ? tiles(roms.tiles2) : this.tile1Pix;

    this.cpu = new V30({ read8: (a) => this.read(a), write8: (a, v) => this.write(a, v), in8: (p) => this.input(p), out8: (p, v) => this.output(p, v) });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    if (cfg.protection) { this.cpu.trapAddr = 0xB0000; this.cpu.onTrap = () => this.mcuRoutine(); }
    this.snd = new Z80({ read: (a) => this.zRead(a), write: (a, v) => this.zWrite(a, v), input: (p) => this.zIn(p), output: (p, v) => this.zOut(p, v) });
    this.ym = new YM2151(Z80_CLOCK, 1);
    this.dacChip = new DAC();
    this.sound = new SoundMix([this.ym, this.dacChip], 1);
    this.in0 = 0xFFFF; this.in1 = 0xFF;
    this.applySwitches();
    this.reset();
  }

  reset() {
    for (const a of [this.prot, this.ram, this.spriteRam, this.spriteBuf, this.sprite2, this.pal1, this.pal2, this.vram1, this.vram2, this.rowScroll, this.soundRam, this.io]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.latch = 0; this.irqVector = 0xFF; this.z80Held = 0; this.videoOff = 0; this.sampleAddr = 0;
    this.rowScrollOn = 0;
    this.nmiCarry = this.cycleCarry = this.zCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- main CPU memory

  // The memory map differs by board; cfg.map lists [start, end, area] ranges.
  area(a) {
    for (const [s, e, name] of this.cfg.map) if (a >= s && a < e) return [name, a - s];
    return null;
  }

  read(a) {
    const hit = this.area(a);
    if (!hit) return this.roms.main[a];
    const [name, o] = hit;
    switch (name) {
      case 'ram': return this.ram[o];
      case 'sprites': return this.spriteRam[o];
      case 'sprites2': return this.sprite2[o];
      case 'pal1': case 'pal2': {
        const p = name === 'pal1' ? this.pal1 : this.pal2, w = (o >> 1) & ~0x100;   // A9 isn't connected
        return o & 1 ? 0xFF : (p[w] & 0x1F) | 0xE0;
      }
      case 'vram1': return this.vram1[o];
      case 'vram2': return this.vram2[o];
      case 'rowscroll': return this.rowScroll[o];
      case 'soundram': return this.soundRam[o];
      case 'prot': return this.prot[o];
    }
    return 0xFF;
  }

  // The MCU's start-up routine: leave its marks in RAM and jump to the game.
  // (Battle Chopper's marks include a far return at B0000 for the checks it
  // makes during play, which then simply run.)
  mcuRoutine() {
    if (this.prot[0] === 0xCB) return false;
    const p = this.cfg.protection;
    for (const [a, v] of p.pokes) {
      if (a >= 0xB0000 && a < 0xB1000) this.prot[a - 0xB0000] = v;
      else this.write(a, v);
    }
    this.cpu.sreg[1] = p.entry[0]; this.cpu.ip = p.entry[1];
    return true;
  }

  write(a, v) {
    const hit = this.area(a);
    if (!hit) return;
    const [name, o] = hit;
    switch (name) {
      case 'ram': this.ram[o] = v; return;
      case 'sprites': this.spriteRam[o] = v; return;
      case 'sprites2': this.sprite2[o] = v; return;
      case 'pal1': case 'pal2': {
        if (o & 1) return;                         // only D0-D4 are wired
        const bank = name === 'pal1' ? 0 : 1, p = bank ? this.pal2 : this.pal1, w = (o >> 1) & ~0x100;
        p[w] = v & 0x1F;
        this.setColor(bank, w & 0xFF);
        return;
      }
      case 'vram1': this.vram1[o] = v; return;
      case 'vram2': this.vram2[o] = v; return;
      case 'rowscroll': this.rowScroll[o] = v; return;
      case 'soundram': this.soundRam[o] = v; return;
      case 'prot': this.prot[o] = ~v & 0xFF; return;        // reads back inverted
      case 'irqline': this.io[0x06 + (o & 1)] = v; return;
      case 'dmaon': if (!(o & 1)) this.spriteBuf.set(this.spriteRam); return;
    }
  }

  setColor(bank, i) {
    const p = bank ? this.pal2 : this.pal1, c = (x) => (x << 3) | (x >> 2);
    this.palette[bank * 256 + i] = rgba(c(p[i]), c(p[i + 0x200]), c(p[i + 0x400]));
  }

  // ---------------------------------------------------------------- main CPU ports

  word(p) { return this.io[p] | (this.io[p + 1] << 8); }

  input(p) {
    switch (p & 0xFF) {
      case 0x00: return this.in0 & 0xFF;
      case 0x01: return this.in0 >> 8;
      case 0x02: return this.in1;
      case 0x03: return 0xFF;
      case 0x04: return this.dsw & 0xFF;
      case 0x05: return this.dsw >> 8;
    }
    return 0xFF;
  }

  output(p, v) {
    p &= 0xFF;
    this.io[p] = v;
    switch (p) {
      case 0x00:                                   // sound command (low byte)
        this.latch = v;
        this.irqVector &= 0xDF;                     // the main CPU's request: bit 5 low
        return;
      case 0x02:
        this.videoOff = v & 0x08;
        // On R-Type's board bit 4 holds the sound CPU in reset while its program is loaded.
        if (this.cfg.soundReset) {
          const held = (v & 0x10) ? 0 : 1;
          if (held && !this.z80Held) this.snd.reset();
          this.z80Held = held;
        }
        return;
      case 0x04: if (this.cfg.dmaPort) this.spriteBuf.set(this.spriteRam); return;
      case 0x8E: case 0x8F: if (p === 0x8F) this.rowScrollOn = v ? 1 : 0; return;   // Major Title: row scroll on
      case 0xC0: {                                 // the earlier games' sample triggers (start addresses from the MCU)
        const t = this.cfg.sampleTable;
        if (t && v < t.length) this.sampleAddr = t[v];
        return;
      }
    }
  }

  // ---------------------------------------------------------------- sound CPU

  zRead(a) {
    if (!this.roms.sound) return this.soundRam[a];
    if (a < 0xF000) return this.roms.sound[a];
    return this.soundRam[a - 0xF000];
  }
  zWrite(a, v) {
    if (!this.roms.sound) { this.soundRam[a] = v; return; }
    if (a >= 0xF000) this.soundRam[a - 0xF000] = v;
  }
  zIn(p) {
    p &= 0xFF;
    const r = this.cfg.soundPorts;
    if (p === 0x01) return this.ym.read();
    if (p === r.latch) return this.latch;
    if (p === 0x84) { const s = this.roms.samples; return s ? s[this.sampleAddr & (s.length - 1)] : 0; }
    return 0xFF;
  }
  zOut(p, v) {
    p &= 0xFF;
    const r = this.cfg.soundPorts;
    if (p === 0x00) { this.ym.select(v); return; }
    if (p === 0x01) { this.ym.write(v); return; }
    if (p === r.ack) { this.irqVector |= 0x20; return; }
    if (p === 0x82) {                              // the DAC, then on to the next sample byte
      this.dacChip.level = ((v - 0x80) / 128) * 0.6;
      const s = this.roms.samples;
      if (s) this.sampleAddr = (this.sampleAddr + 1) & (s.length - 1);
      return;
    }
    if (r.sampleAddr && (p === 0x80 || p === 0x81)) {
      // The start address, in units of 32 bytes.
      let a = this.sampleAddr >> 5;
      a = p === 0x81 ? (a & 0xFF) | (v << 8) : (a & 0xFF00) | v;
      this.sampleAddr = a << 5;
    }
  }

  // ---------------------------------------------------------------- inputs

  // IN0 (player 1 low byte): right, left, down, up, buttons 4..1 (button 1 is bit 7). IN1: starts, coins.
  setInputs(s) {
    this.in0 = 0xFF00 | (0xFF & ~((s.right ? 1 : 0) | (s.left ? 2 : 0) | (s.down ? 4 : 0) | (s.up ? 8 : 0)
      | (s.fire ? 0x80 : 0) | (s.fire2 ? 0x40 : 0) | (s.fire3 ? 0x20 : 0)));
    this.in1 = 0xFF & ~((s.start1 ? 1 : 0) | (s.start2 ? 2 : 0) | (s.coin ? 4 : 0));
  }
  applySwitches() { this.dsw = this.cfg.dsw; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const cyc = CPU_CLOCK / REFRESH / LINES, zc = Z80_CLOCK / REFRESH / LINES;
    const samples = 48000 / REFRESH / LINES, dt = 1 / REFRESH / LINES;
    const irqBase = this.cfg.irqBase;
    for (let line = 0; line < LINES; line++) {
      // Line 255 is vertical blank; the raster interrupt hits at the programmed line (counted from 128).
      if (line === 255) { this.cpu.irqVector = irqBase; this.cpu.irq = true; }
      else if (line === this.word(0x06) - 128) { this.cpu.irqVector = irqBase + 2; this.cpu.irq = true; }
      this.cycleCarry += cyc;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      // Sound: the YM2151 (bit 4) and the main CPU (bit 5) share the Z80's interrupt, as an RST in IM 0.
      this.irqVector = (this.irqVector & ~0x10) | (this.ym.irq ? 0 : 0x10);
      this.snd.irqVector = this.irqVector;
      this.snd.irq = this.irqVector !== 0xFF;
      if (this.cfg.sampleNmi || this.cfg.fakeNmi) {
        this.nmiCarry += 128 / LINES;
        if (this.nmiCarry >= 1) {
          this.nmiCarry -= 1;
          if (this.cfg.fakeNmi) {
            // Some of these games' sound programs leave sample playback to outside hardware:
            // play the next byte until the 00 that ends a sample.
            const smp = this.roms.samples;
            const b = smp ? smp[this.sampleAddr & (smp.length - 1)] : 0;
            if (b) { this.dacChip.level = ((b - 0x80) / 128) * 0.6; this.sampleAddr = (this.sampleAddr + 1) & (smp.length - 1); }
          } else if (!this.z80Held) this.snd.nmi();
        }
      }
      this.zCarry += zc;
      if (this.z80Held) this.zCarry = 0;
      else this.zCarry -= this.snd.run(Math.floor(this.zCarry));
      this.ym.timers(dt);
      this.drawLine(line);
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    if (this.rotated) rotate270(this.native, W, H, this.frame);
  }

  // ---------------------------------------------------------------- video

  // One tile layer's pixel at map coordinates: [pen, palette, group] or null when off the map.
  tileAt(layer, mx, my) {
    const cfg = this.cfg, two = cfg.tiles === 'rtype2';
    const wide = layer === 2 && cfg.layout === 'majtitle';
    const vram = layer === 1 ? this.vram1 : this.vram2;
    const tx = (mx >> 3) & (wide ? 127 : 63), ty = (my >> 3) & 63;
    const i = (wide ? ty * 256 + tx : ty * 64 + tx) * 4;
    const w0 = vram[i] | (vram[i + 1] << 8), w1 = vram[i + 2] | (vram[i + 3] << 8);
    let code, color, group, fx, fy;
    if (two) {
      code = w0; color = w1 & 0xFF;
      const attr = w1 >> 8;
      group = attr & 1 ? 2 : color & 0x80 ? 1 : 0;
      fx = color & 0x20; fy = color & 0x40;
    } else {
      const attr = w0 >> 8;
      code = (w0 & 0xFF) | ((attr & 0x3F) << 8); color = w1 & 0xFF;
      group = color & 0x80 ? 2 : color & 0x40 ? 1 : 0;
      fx = attr & 0x40; fy = attr & 0x80;
    }
    const pix = layer === 1 ? this.tile1Pix : this.tile2Pix;
    const count = pix.length / 64;
    code %= count;
    const px = fx ? 7 - (mx & 7) : mx & 7, py = fy ? 7 - (my & 7) : my & 7;
    this.tPen = pix[code * 64 + py * 8 + px];
    this.tCol = 256 + (color & 15) * 16;
    this.tGroup = group;
  }

  // Which pens of a group draw under the sprites (low) and which over them (high).
  // fg: group 0 all non-zero below; 1: pens 1-7 below, 8-15 above; 2: all non-zero above.
  // bg: the same, except pen 0 is opaque below in groups 0 and 1 (and alone below in group 2).
  split(layer, pen, group) {
    if (group === 0) return pen || layer === 2 ? 1 : 0;              // 1 = below, 2 = above, 0 = nothing
    if (group === 1) return pen >= 8 ? 2 : pen || layer === 2 ? 1 : 0;
    return pen ? 2 : layer === 2 ? 1 : 0;
  }

  drawLine(line) {
    const out = this.native, pal = this.palette, cfg = this.cfg, o = line * W;
    if (this.videoOff) { out.fill(0xFF000000, o, o + W); return; }
    const sy = line + TOP;
    const pri = this.pri;
    pri.fill(0);
    const xAdj = cfg.xAdjust || 0;
    const sx1 = this.word(0x82) + xAdj, sy1 = this.word(0x80);
    let sx2 = this.word(0x86) + xAdj + (cfg.bgAdjust || 0);
    const sy2 = this.word(0x84);
    if (cfg.layout === 'majtitle') sx2 = 256 + (this.rowScrollOn ? (this.rowScroll[sy * 2] | (this.rowScroll[sy * 2 + 1] << 8)) : this.word(0x86)) + xAdj;
    const bgSpan = cfg.layout === 'majtitle' ? 1023 : 511;
    const high = this.highBuf || (this.highBuf = new Uint32Array(W));
    const hasHigh = this.hasHigh || (this.hasHigh = new Uint8Array(W));
    hasHigh.fill(0);
    // Lower halves of bg then fg; remember upper halves to draw over the sprites.
    for (const layer of [2, 1]) {
      const scx = layer === 1 ? sx1 : sx2, scy = layer === 1 ? sy1 : sy2;
      const my = (sy + scy) & 511, span = layer === 1 ? 511 : bgSpan;
      for (let x = 0; x < W; x++) {
        this.tileAt(layer, (x + LEFT + scx) & span, my);
        const s = this.split(layer, this.tPen, this.tGroup);
        if (s === 1) out[o + x] = pal[this.tCol + this.tPen];
        else if (s === 2) { high[x] = pal[this.tCol + this.tPen]; hasHigh[x] = 1; if (layer === 2) out[o + x] = pal[this.tCol]; }
      }
    }
    // Sprites (Major Title's second sprite list first).
    if (this.sprite2Pix) this.drawSprites(this.sprite2, this.sprite2Pix, sy, o, true);
    this.drawSprites(this.spriteBuf, this.spritePix, sy, o, false);
    for (let x = 0; x < W; x++) if (hasHigh[x]) out[o + x] = high[x];
  }

  drawSprites(ram, pix, sy, o, single) {
    const out = this.native, pal = this.palette, count = pix.length / 256;
    const wd = (i) => ram[i * 2] | (ram[i * 2 + 1] << 8);
    for (let offs = 0; offs < 0x200;) {
      const attr = wd(offs + 2), code = wd(offs + 1);
      const w = single ? 1 : 1 << ((attr >> 14) & 3), h = 1 << ((attr >> 12) & 3);
      const sx = -256 + (wd(offs + 3) & 0x3FF), top = 512 - (wd(offs) & 0x1FF) - 16 * h;
      const fx = attr & 0x800, fy = attr & 0x400, col = (attr & 15) * 16;
      const rowInBlock = (sy - top) & 0x1FF;
      if (rowInBlock < 16 * h) {
        const ty = rowInBlock >> 4, py = rowInBlock & 15;
        for (let x = 0; x < w; x++) {
          let c = code + (fx ? 8 * (w - 1 - x) : 8 * x) + (fy ? h - 1 - ty : ty);
          c %= count;
          const src = c * 256 + (fy ? 15 - py : py) * 16;
          for (let i = 0; i < 16; i++) {
            const pen = pix[src + (fx ? 15 - i : i)];
            if (!pen) continue;
            const px = sx + 16 * x + i - LEFT;
            if (px >= 0 && px < W) out[o + px] = pal[col + pen];
          }
        }
      }
      offs += single ? 4 : w * 4;
    }
  }
}

// ---------------------------------------------------------------- the games

const MAP_RTYPE = [[0x40000, 0x44000, 'ram'], [0xC0000, 0xC0400, 'sprites'], [0xC8000, 0xC8C00, 'pal1'], [0xCC000, 0xCCC00, 'pal2'],
  [0xD0000, 0xD4000, 'vram1'], [0xD8000, 0xDC000, 'vram2'], [0xE0000, 0xF0000, 'soundram']];
const MAP_RTYPE2 = [[0xB0000, 0xB0002, 'irqline'], [0xBC000, 0xBC002, 'dmaon'], [0xC0000, 0xC0400, 'sprites'], [0xC8000, 0xC8C00, 'pal1'],
  [0xD0000, 0xD4000, 'vram1'], [0xD4000, 0xD8000, 'vram2'], [0xD8000, 0xD8C00, 'pal2'], [0xE0000, 0xE4000, 'ram']];
const MAP_HHARRY = [[0xA0000, 0xA4000, 'ram'], [0xC0000, 0xC0400, 'sprites'], [0xC8000, 0xC8C00, 'pal1'], [0xCC000, 0xCCC00, 'pal2'],
  [0xD0000, 0xD4000, 'vram1'], [0xD8000, 0xDC000, 'vram2']];
const MAP_MAJTITLE = [[0xA0000, 0xA0400, 'rowscroll'], [0xA4000, 0xA4C00, 'pal2'], [0xAC000, 0xB0000, 'vram1'], [0xB0000, 0xC0000, 'vram2'],
  [0xC0000, 0xC0400, 'sprites'], [0xC8000, 0xC8400, 'sprites2'], [0xCC000, 0xCCC00, 'pal1'], [0xD0000, 0xD4000, 'ram'],
  [0xE0000, 0xE0002, 'irqline'], [0xEC000, 0xEC002, 'dmaon']];

export class RType extends M72 {}
RType.id = 'rtype'; RType.title = 'R-Type'; RType.switches = [];
RType.config = { map: MAP_RTYPE, tiles: 'm72', irqBase: 0x20, soundReset: true, dmaPort: true, soundPorts: { latch: 0x02, ack: 0x06 },
  dsw: 0xFDFB, button2: 'Force' };

const ramAt = (base) => [[base, base + 0x4000, 'ram'], [0xB0000, 0xB1000, 'prot'], [0xC0000, 0xC0400, 'sprites'], [0xC8000, 0xC8C00, 'pal1'],
  [0xCC000, 0xCCC00, 'pal2'], [0xD0000, 0xD4000, 'vram1'], [0xD8000, 0xDC000, 'vram2'], [0xE0000, 0xF0000, 'soundram']];
// What each MCU routine leaves behind: [address, byte] (the shared RAM's bytes as they read back).
const marks = (name) => [...name].map((ch, i) => [0xA3838 + i * 2, ch.charCodeAt(0)]);
const IDS = [[0xB0900, 0x49], [0xB0A00, 0x49], [0xB0B00, 0x49]];
const m72 = (extra) => ({ tiles: 'm72', irqBase: 0x20, soundReset: true, dmaPort: true, fakeNmi: true, soundPorts: { latch: 0x02, ack: 0x06 }, ...extra });

export class BattleChopper extends M72 {}
BattleChopper.id = 'bchopper'; BattleChopper.title = 'Battle Chopper'; BattleChopper.switches = [];
BattleChopper.config = m72({ map: ramAt(0xA0000), dsw: 0xFDFB, button2: 'Arm',
  protection: { pokes: [...marks('SAMOTO'), ...IDS, [0xB0000, 0xCB], [0xD1670, 0x77]], entry: [0x0040, 0x0168] },
  sampleTable: [0x0000, 0x0010, 0x2510, 0x6510, 0x8510, 0x9310] });

export class NinjaSpirit extends M72 {}
NinjaSpirit.id = 'nspirit'; NinjaSpirit.title = 'Ninja Spirit'; NinjaSpirit.switches = [];
NinjaSpirit.config = m72({ map: ramAt(0xA0000), dsw: 0xF5FF, button2: 'Jump',
  protection: { pokes: [...marks('NINDOU'), ...IDS, [0xD1670, 0x57], [0xD1671, 0x00]], entry: [0x0040, 0x0000] },
  sampleTable: [0x0000, 0x0020, 0x2020, 0, 0x5720, 0, 0x7B60, 0x9B60, 0xC360] });

export class ImageFight extends M72 {}
ImageFight.id = 'imgfight'; ImageFight.title = 'Image Fight'; ImageFight.switches = [];
ImageFight.config = m72({ map: ramAt(0xA0000), dsw: 0xF5FF, rotate: true, button2: 'Speed',
  protection: { pokes: [...marks('PICKET'), ...IDS, [0xB0920, 0x49], [0xB0921, 0x4D], [0xB0922, 0x41], [0xB0923, 0x47], [0xD1CB0, 0x57]], entry: [0x0040, 0x0000] },
  sampleTable: [0x0000, 0x0020, 0x44E0, 0x98A0, 0xC820, 0xF7A0, 0x108C0] });

export class HeroTonma extends M72 {}
HeroTonma.id = 'loht'; HeroTonma.title = 'Legend of Hero Tonma'; HeroTonma.switches = [];
HeroTonma.config = m72({ map: ramAt(0xA0000), dsw: 0xFDFB, button2: 'Jump',
  protection: { pokes: [[0xA383C, 0x47], [0xA383D, 0x47], [0xA3842, 0x44], [0xA3843, 0x44], ...IDS, [0xD1670, 0x57]], entry: [0x0040, 0x015D] },
  sampleTable: [0x0000, 0x0020, 0, 0x2C40, 0x4320, 0x7120, 0xB200] });

export class XMultiply extends M72 {}
XMultiply.id = 'xmultipl'; XMultiply.title = 'X Multiply'; XMultiply.switches = [];
XMultiply.config = m72({ map: ramAt(0x80000), irqBase: 0x08, fakeNmi: false, sampleNmi: true, dsw: 0xFDFF, button2: 'Arms',
  protection: { pokes: [], entry: [0x0E00, 0x0230] }, sampleTable: [0x0000, 0x0020, 0x1A40] });

export class DragonBreed extends M72 {}
DragonBreed.id = 'dbreed'; DragonBreed.title = 'Dragon Breed'; DragonBreed.switches = [];
DragonBreed.config = m72({ map: ramAt(0x90000), irqBase: 0x08, fakeNmi: false, sampleNmi: true, dsw: 0xF5FF, button2: 'Dragon',
  protection: { pokes: [], entry: [0x0000, 0x006C] },
  sampleTable: [0x00000, 0x00020, 0x02C40, 0x08160, 0x0C8C0, 0x0FFE0, 0x13000, 0x15820, 0x15F40] });

export class AirDuel extends M72 {}
AirDuel.id = 'airduel'; AirDuel.title = 'Air Duel'; AirDuel.switches = [];
AirDuel.config = m72({ map: ramAt(0xA0000), dsw: 0xFFFF, rotate: true, button2: 'Bomb',
  protection: { pokes: [[0xD1CC0, 0x57]], entry: [0x0000, 0x0B69] },
  sampleTable: [0x00000, 0x00020, 0x03EC0, 0x05640, 0x06DC0, 0x083A0, 0x0C000, 0x0EB60,
    0x112E0, 0x13DC0, 0x16520, 0x16D60, 0x18AE0, 0x1A5A0, 0x1BF00, 0x1C340] });

export class Gallop extends M72 {}
Gallop.id = 'gallop'; Gallop.title = 'Gallop - Armed Police Unit'; Gallop.switches = [];
Gallop.config = m72({ map: ramAt(0xA0000), dsw: 0xF9FF, button2: 'Jump',
  sampleTable: [0x00000, 0x00020, 0x00040, 0x01360, 0x02580, 0x04F20, 0x06240, 0x076E0,
    0x08660, 0x092A0, 0x09BA0, 0x0A560, 0x0CEE0, 0x0DE20, 0x0E620, 0x0F1C0,
    0x10200, 0x10220, 0x10240, 0x11380, 0x12760, 0x12780, 0x127A0, 0x13C40,
    0x140A0, 0x16760, 0x17E40, 0x18EE0, 0x19F60, 0x1BBC0, 0x1CEE0] });

export class RType2 extends M72 {}
RType2.id = 'rtype2'; RType2.title = 'R-Type II'; RType2.switches = [];
RType2.config = { map: MAP_RTYPE2, tiles: 'rtype2', irqBase: 0x20, xAdjust: -4, sampleNmi: true,
  soundPorts: { latch: 0x80, ack: 0x83, sampleAddr: true }, dsw: 0xF7FF, button2: 'Force' };

export class HammerinHarry extends M72 {}
HammerinHarry.id = 'hharry'; HammerinHarry.title = "Hammerin' Harry"; HammerinHarry.switches = [];
HammerinHarry.config = { map: MAP_HHARRY, tiles: 'hharry', irqBase: 0x08, xAdjust: -4, bgAdjust: -2, sampleNmi: true, dmaPort: true,
  soundPorts: { latch: 0x80, ack: 0x83, sampleAddr: true }, dsw: 0xFDFF, button2: 'Jump' };

export class MajorTitle extends M72 {}
MajorTitle.id = 'majtitle'; MajorTitle.title = 'Major Title'; MajorTitle.switches = [];
MajorTitle.config = { map: MAP_MAJTITLE, tiles: 'rtype2', layout: 'majtitle', irqBase: 0x20, xAdjust: -4, sampleNmi: true,
  soundPorts: { latch: 0x80, ack: 0x83, sampleAddr: true }, dsw: 0xF7FF, buttons: 1 };
