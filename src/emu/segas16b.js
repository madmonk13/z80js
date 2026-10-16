// Sega System 16B (1987-91): Shinobi, Altered Beast, Golden Axe. A 68000 at
// 10 MHz behind Sega's 315-5195 memory mapper (the game programs where each
// area appears), a Z80 at 5 MHz with a YM2151 and a uPD7759 ADPCM speech chip
// fed by the Z80. The ROM board differs between games: it decides what sits
// in the mapper's last few areas (more ROM, tile bank latches, a multiplier
// and a compare/timer chip) and how the Z80's sample bank is decoded.
//
// Video: two scrolling tile layers built from 16 pages of 64x32 tiles (8x8,
// 3 bits per pixel; each layer shows a 2x2 arrangement of pages, with row and
// column scroll and an alternate page set per row), a fixed text layer, and
// 128 zoomable sprites drawn from 16-bit-wide sprite ROM data, in front of or
// behind the layers by a 2-bit priority. 2048 colors of 5 bits per gun, with
// sprite-driven shadow and highlight. 320x224 at 60 Hz.

import { M68000 } from './m68000.js';
import { Z80 } from './z80.js';
import { YM2151 } from './ym2151.js';
import { UPD7759 } from './upd7759.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 320, H = 224, LINES = 262, REFRESH = 60;
const CPU_CLOCK = 10000000, Z80_CLOCK = 5000000;
const SIZES = [0xFFFF, 0x1FFFF, 0x7FFFF, 0x1FFFFF];

// The mapper's regions per ROM board: [register, offset, length, mirror, kind].
// Later entries win where they overlap.
const COMMON = [
  [0x1E, 0x00000, 0x04000, 0xFFC000, 'io'],
  [0x1C, 0x00000, 0x01000, 0xFFF000, 'palette'],
  [0x1A, 0x00000, 0x10000, 0xFE0000, 'tile'],
  [0x1A, 0x10000, 0x01000, 0xFEF000, 'text'],
  [0x18, 0x00000, 0x00800, 0xFFF800, 'sprite'],
  [0x16, 0x00000, 0x04000, 0xFFC000, 'work'],
];
const BOARDS = {
  // 171-5358 (Shinobi): three 128K ROM areas.
  5358: [...COMMON,
    [0x14, 0x00000, 0x20000, 0xFE0000, 'rom'],
    [0x12, 0x00000, 0x20000, 0xFE0000, 'rom'],
    [0x10, 0x00000, 0x20000, 0xFE0000, 'rom']],
  // 171-5521 / 5704 (Altered Beast): two 512K ROM areas and the tile bank latches.
  5521: [...COMMON,
    [0x14, 0x00000, 0x10000, 0xFF0000, 'tilebank'],
    [0x12, 0x00000, 0x80000, 0xFC0000, 'rom'],
    [0x10, 0x00000, 0x80000, 0xFC0000, 'rom']],
  // 171-5797 (Golden Axe): one 512K ROM area, the multiplier / compare chip / tile banks, and a second compare chip.
  5797: [...COMMON,
    [0x14, 0x00000, 0x10000, 0xFF0000, 'timer1'],
    [0x12, 0x00000, 0x04000, 0xFFC000, 'math'],
    [0x10, 0x00000, 0x80000, 0xF80000, 'rom']],
};
BOARDS[5704] = BOARDS[5521];
const KINDS = ['io', 'palette', 'tile', 'text', 'sprite', 'work', 'rom', 'tilebank', 'math', 'timer1'];
// Sprite bank numbers on the 171-5358 board (others don't exist: 255); later boards number them straight.
const SPRITE_BANKS_5358 = [0, 255, 255, 255, 255, 255, 255, 3, 255, 255, 255, 2, 255, 1, 0, 255];
const SPRITE_BANKS = Array.from({ length: 16 }, (_, i) => i);

const STATE = ['mapRegs', 'palRam', 'tileRam', 'textRam', 'spriteRam', 'workRam', 'soundRam', 'latch', 'soundBank', 'videoCtl',
  'latched', 'cycleCarry', 'zCarry', 'sampleCarry', 'svc', 'p1', 'cpu', 'snd', 'ym', 'upd'];
// Extra state for the later ROM boards.
const STATE_X = ['tileBanks', 'mult', 'cmp', 'cmpBit', 'p2'];

// Store a word's selected bytes (mask: 1 low byte, 2 high byte) into big-endian byte RAM.
function put(arr, i, v, mask) { if (mask & 2) arr[i] = v >> 8; if (mask & 1) arr[i + 1] = v & 0xFF; }

export class System16B {
  saveState() { return capture(this, this.board === 5358 ? STATE : [...STATE, ...STATE_X]); }
  loadState(s) { apply(this, this.board === 5358 ? STATE : [...STATE, ...STATE_X], s); this.remap(); for (let i = 0; i < 2048; i++) this.setColor(i); }

  // roms: { main (68000, big-endian), tiles (3 planes), sprites (big-endian words), sound (Z80),
  //   samples: [ROMs by chip select] on the 5358 board, or one sample region on the others }
  // board: the ROM board number; mcuConfig: mapper registers 10-1F as an 8751 MCU leaves them (when it's simulated).
  constructor(roms, board = 5358, mcuConfig = null) {
    this.board = board;
    this.regions = BOARDS[board];
    this.spriteBanks = board === 5358 ? SPRITE_BANKS_5358 : SPRITE_BANKS;
    this.mcuConfig = mcuConfig;
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 3;
    this.button2 = 'Jump';
    this.button3 = 'Magic';
    this.roms = roms;

    this.mapRegs = new Uint8Array(0x20);
    this.palRam = new Uint8Array(0x1000);
    this.tileRam = new Uint8Array(0x10000);
    this.textRam = new Uint8Array(0x1000);
    this.spriteRam = new Uint8Array(0x800);
    this.workRam = new Uint8Array(0x4000);
    this.soundRam = new Uint8Array(0x800);
    this.latched = new Uint16Array(12);         // page selects, y scrolls, x scrolls (4 each), latched at the end of each frame
    this.tileBanks = new Uint8Array([0, 1]);      // 4096-tile banks for tile codes 0-FFF and 1000-1FFF
    this.mult = new Uint16Array(2);
    this.cmp = [new Uint16Array(16), new Uint16Array(16)];
    this.cmpBit = new Uint8Array(2);
    this.p2 = 0xFF;
    this.blockMap = new Int8Array(0x2000);       // 2K blocks of the address space -> region index (-1: the mapper itself)
    this.remap();
    this.palette = new Uint32Array(2048 * 3).fill(0xFF000000);
    this.frame = new Uint32Array(W * H);
    this.index = new Uint16Array(W * H);         // palette index per pixel (for shadow/highlight)
    this.pri = new Uint8Array(W * H);

    const third = roms.tiles.length / 3 * 8;
    this.tilePix = decodeTiles(roms.tiles, { count: roms.tiles.length / 24, width: 8, height: 8, planes: [2 * third, third, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    this.sampleSize = roms.sampleSize || 0;
    this.spriteWords = new Uint16Array(roms.sprites.length / 2);
    for (let i = 0; i < this.spriteWords.length; i++) this.spriteWords[i] = (roms.sprites[i * 2] << 8) | roms.sprites[i * 2 + 1];

    this.cpu = new M68000({
      read8: (a) => this.read8(a), read16: (a) => this.read16(a),
      write8: (a, v) => this.write8(a, v), write16: (a, v) => this.write16(a, v),
    });
    this.cpu.onIrqAck = () => { this.cpu.irq = 0; };
    this.snd = new Z80({ read: (a) => this.zRead(a), write: (a, v) => this.zWrite(a, v), input: (p) => this.zIn(p), output: (p, v) => this.zOut(p, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.ym = new YM2151(4000000, 0.9);
    this.upd = new UPD7759(640000, 0.8, () => this.snd.nmi());
    this.sound = new SoundMix([this.ym, this.upd], 1);
    this.svc = 0xFF; this.p1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.mapRegs, this.palRam, this.tileRam, this.textRam, this.spriteRam, this.workRam, this.soundRam, this.latched,
      this.mult, this.cmp[0], this.cmp[1], this.cmpBit]) a.fill(0);
    this.tileBanks[0] = 0; this.tileBanks[1] = 1;
    if (this.mcuConfig) this.mapRegs.set(this.mcuConfig, 0x10);
    this.palette.fill(0xFF000000);
    this.latch = 0; this.soundBank = 0; this.videoCtl = 0;
    this.cycleCarry = this.zCarry = this.sampleCarry = 0;
    this.remap();
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- the memory mapper

  remap() {
    const map = this.blockMap, regs = this.mapRegs, rom = this.roms.main.length;
    this.ranges = this.regions.map(([reg, offs, len, mirror, kind]) => {
      const size = SIZES[regs[reg] & 3];
      const base = (regs[reg + 1] << 16) & ~size;
      const start = base + (offs & size);
      let end = start + Math.min(len - 1, size);
      if (kind === 'rom') { if (start >= rom) return null; if (start + len > rom) end = rom - 1; }
      return { start, end, mirror: mirror & size, kind: KINDS.indexOf(kind) };
    });
    for (let b = 0; b < 0x2000; b++) {
      const a = b << 11;
      let hit = -1;
      for (let i = this.ranges.length - 1; i >= 0; i--) {
        const r = this.ranges[i];
        if (!r) continue;
        const m = a & ~r.mirror;
        if (m >= r.start && m <= r.end) { hit = i; break; }
      }
      map[b] = hit;
    }
  }

  mapperWrite(o, v) {
    o &= 0x1F;
    const old = this.mapRegs[o];
    this.mapRegs[o] = v;
    switch (o) {
      case 0x03: this.latch = v; this.snd.irq = true; return;     // sound command
      case 0x04: if ((v & 7) !== 7) this.cpu.irq = ~v & 7; return; // raise an interrupt (negative logic)
      case 0x05: {
        const r = this.mapRegs;
        if (v === 1) this.write16(((r[0x0A] << 17) | (r[0x0B] << 9) | (r[0x0C] << 1)) & 0xFFFFFF, (r[0] << 8) | r[1]);
        else if (v === 2) { const w = this.read16(((r[0x07] << 17) | (r[0x08] << 9) | (r[0x09] << 1)) & 0xFFFFFE); r[0] = w >> 8; r[1] = w & 0xFF; }
        return;
      }
    }
    if (o >= 0x10 && old !== v) this.remap();
  }
  mapperRead(o) {
    o &= 0x1F;
    if (o < 2) return this.mapRegs[o];
    if (o === 2) return (this.mapRegs[2] & 3) === 3 ? 0 : 0x0F;
    if (o === 3) return 0xFF;
    return 0xFF;
  }

  // ---------------------------------------------------------------- 68000 bus

  // Find what's mapped at a: false if nothing, else true with the region's kind, the offset
  // into it and the mirrored address left in lkKind / lkOff / lkAbs (no allocation per access).
  locate(a) {
    const i = this.blockMap[(a >> 11) & 0x1FFF];
    if (i < 0) return false;
    const r = this.ranges[i], abs = a & ~r.mirror;
    this.lkKind = r.kind; this.lkOff = abs - r.start; this.lkAbs = abs;
    return true;
  }

  read16(a) {
    if (!this.locate(a)) return 0xFF00 | this.mapperRead(a >> 1);
    const kind = this.lkKind, o = this.lkOff;
    let arr, i;
    switch (kind) {
      case 0: return this.io(o >> 1);
      case 1: arr = this.palRam; i = o & 0xFFE; break;
      case 2: arr = this.tileRam; i = o & 0xFFFE; break;
      case 3: arr = this.textRam; i = o & 0xFFE; break;
      case 4: arr = this.spriteRam; i = o & 0x7FE; break;
      case 5: arr = this.workRam; i = o & 0x3FFE; break;
      case 6: arr = this.roms.main; i = this.lkAbs; break;
      case 8: {                                   // 5797: multiplier, compare chip 0
        const w = (o >> 1) & 0x1FFF;
        if ((w & 0x1800) === 0) return this.multRead(w & 3);
        if ((w & 0x1800) === 0x800) return this.cmpRead(0, w & 7);
        return 0xFFFF;
      }
      case 9: return this.cmpRead(1, (o >> 1) & 7);
      default: return 0xFFFF;
    }
    return (arr[i] << 8) | arr[i + 1];
  }
  read8(a) { const w = this.read16(a & ~1); return a & 1 ? w & 0xFF : w >> 8; }

  write16(a, v) { this.write(a & ~1, v, 3); }
  write8(a, v) { if (a & 1) this.write(a & ~1, v & 0xFF, 1); else this.write(a, (v & 0xFF) << 8, 2); }

  // mask: 1 low byte, 2 high byte, 3 both.
  write(a, v, mask) {
    if (!this.locate(a)) { if (mask & 1) this.mapperWrite(a >> 1, v & 0xFF); return; }
    const kind = this.lkKind, o = this.lkOff;
    let arr, i;
    switch (kind) {
      case 0: if ((o >> 1 & 0x1800) === 0 && (mask & 1)) this.videoCtl = v & 0xFF; return;   // display enable, flip
      case 1: i = o & 0xFFE; put(this.palRam, i, v, mask); this.setColor(i >> 1); return;
      case 2: arr = this.tileRam; i = o & 0xFFFE; break;
      case 3: arr = this.textRam; i = o & 0xFFE; break;
      case 4: arr = this.spriteRam; i = o & 0x7FE; break;
      case 5: arr = this.workRam; i = o & 0x3FFE; break;
      case 7: if (mask & 1) this.setTileBank((o >> 1) & 1, v & 7); return;
      case 8: {
        const w = (o >> 1) & 0x1FFF;
        if ((w & 0x1800) === 0) this.multWrite(w & 3, v, mask);
        else if ((w & 0x1800) === 0x800) this.cmpWrite(0, w & 7, v, mask);
        else if ((w & 0x1800) === 0x1000 && (mask & 1)) this.setTileBank(w & 1, v & 7);
        return;
      }
      case 9: this.cmpWrite(1, (o >> 1) & 7, v, mask); return;
      default: return;
    }
    put(arr, i, v, mask);
  }

  // ---------------------------------------------------------------- ROM board chips

  setTileBank(which, bank) { this.tileBanks[which] = bank; }
  static merge(old, v, mask) { return ((mask & 2 ? v : old) & 0xFF00) | ((mask & 1 ? v : old) & 0xFF); }
  multRead(o) {
    const r = this.mult, p = ((r[0] << 16) >> 16) * ((r[1] << 16) >> 16);
    return [r[0], r[1], (p >> 16) & 0xFFFF, p & 0xFFFF][o];
  }
  multWrite(o, v, mask) { this.mult[o & 1] = System16B.merge(this.mult[o & 1], v, mask); }
  // The compare chip clamps a value between two bounds and keeps a history of in-range results.
  cmpUpdate(n, history) {
    const r = this.cmp[n], s = (x) => (x << 16) >> 16;
    const b1 = s(r[0]), b2 = s(r[1]), value = s(r[2]), min = Math.min(b1, b2), max = Math.max(b1, b2);
    if (value < min) { r[7] = min; r[3] = 0x8000; }
    else if (value > max) { r[7] = max; r[3] = 0x4000; }
    else { r[7] = value; r[3] = 0; }
    if (history) { if (r[3] === 0 && this.cmpBit[n] < 16) r[4] |= 1 << this.cmpBit[n]; this.cmpBit[n]++; }
  }
  cmpRead(n, o) {
    const r = this.cmp[n];
    switch (o) {
      case 0: case 1: case 2: case 3: case 4: case 7: return r[o];
      case 5: return r[1];
      case 6: return r[2];
    }
    return 0xFFFF;
  }
  cmpWrite(n, o, v, mask) {
    const r = this.cmp[n], m = (i) => { r[i] = System16B.merge(r[i], v, mask); };
    switch (o) {
      case 0: m(0); this.cmpUpdate(n, false); return;
      case 1: m(1); this.cmpUpdate(n, false); return;
      case 2: m(2); this.cmpUpdate(n, true); return;
      case 4: r[4] = 0; this.cmpBit[n] = 0; return;
      case 6: m(2); this.cmpUpdate(n, false); return;
    }
  }

  // I/O: 1000 inputs (service, P1, -, P2), 2000 switches (game, coinage).
  io(w) {
    switch (w & 0x1800) {
      case 0x0800: return [this.svc, this.p1, 0xFF, this.p2][w & 3];
      case 0x1000: return w & 1 ? 0xFF : this.dsw;
    }
    return 0xFFFF;
  }

  // xBGR BBBB GGGG RRRR: each gun's low bit sits up in bits 12-14.
  setColor(i) {
    const v = (this.palRam[i * 2] << 8) | this.palRam[i * 2 + 1];
    const r = ((v >> 12) & 1) | ((v << 1) & 0x1E), g = ((v >> 13) & 1) | ((v >> 3) & 0x1E), b = ((v >> 14) & 1) | ((v >> 7) & 0x1E);
    const n = (c) => Math.round(c * 255 / 31);
    this.palette[i] = rgba(n(r), n(g), n(b));
    this.palette[i + 2048] = rgba(Math.round(n(r) * 0.6), Math.round(n(g) * 0.6), Math.round(n(b) * 0.6));            // shadow
    this.palette[i + 4096] = rgba(Math.round(n(r) * 0.6 + 102), Math.round(n(g) * 0.6 + 102), Math.round(n(b) * 0.6 + 102));   // highlight
  }

  // ---------------------------------------------------------------- sound CPU

  zRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0xE000) return this.bankByte(a - 0x8000);
    if (a === 0xE800) return this.latch;
    if (a >= 0xF800) return this.soundRam[a - 0xF800];
    return 0xFF;
  }
  // The banked window: chip-select bits pick a sample ROM, bits 0-1 a 16K bank in it.
  bankByte(o) {
    const d = this.soundBank, s = this.roms.samples;
    if (this.board !== 5358) {
      // 5521: bit 3 picks the ROM, bits 0-2 a 16K bank; 5797 adds bit 4 (A17).
      let off = ((d & 8) >> 3) * (this.board === 5797 ? 0x40000 : 0x20000) + (d & 7) * 0x4000;
      if (this.board === 5797) off += ((d & 0x10) >> 4) * 0x20000;
      return s[(off % this.sampleSize) + o] ?? 0;
    }
    let chip = -1;
    if (!(d & 0x04)) chip = 0; else if (!(d & 0x08)) chip = 1; else if (!(d & 0x10)) chip = 2; else if (!(d & 0x20)) chip = 3;
    const rom = s[chip];
    if (!rom) return 0xFF;
    return rom[((d & 3) * 0x4000 + o) % rom.length];
  }
  zWrite(a, v) { if (a >= 0xF800) this.soundRam[a - 0xF800] = v; }
  zIn(p) {
    switch (p & 0xC0) {
      case 0x00: return p & 1 ? this.ym.read() : 0xFF;
      case 0x80: return this.upd.busy() ? 0 : 0x80;
      case 0xC0: return this.latch;
    }
    return 0xFF;
  }
  zOut(p, v) {
    switch (p & 0xC0) {
      case 0x00: if (p & 1) this.ym.write(v); else this.ym.select(v); return;
      case 0x40: this.soundBank = v; this.upd.start(v & 0x80); this.upd.resetLine(v & 0x40); return;
      case 0x80: this.upd.data(v); return;
    }
  }

  // ---------------------------------------------------------------- inputs

  // P1: button 3, 1, 2, -, down, up, right, left (active low). Service: coins, starts.
  setInputs(s) {
    this.p1 = 0xFF & ~((s.fire3 ? 1 : 0) | (s.fire ? 2 : 0) | (s.fire2 ? 4 : 0) | (s.down ? 0x10 : 0) | (s.up ? 0x20 : 0) | (s.right ? 0x40 : 0) | (s.left ? 0x80 : 0));
    this.svc = 0xFF & ~((s.coin ? 1 : 0) | (s.start1 ? 0x10 : 0) | (s.start2 ? 0x20 : 0));
  }
  // Upright, demo sounds on, bullet speed and language default.
  applySwitches(v) { this.dsw = 0xC0 | v.lives | v.difficulty; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const cyc = CPU_CLOCK / REFRESH / LINES, zc = Z80_CLOCK / REFRESH / LINES / 4, samples = 48000 / REFRESH / LINES / 4, dt = 1 / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === H) { this.render(); this.vblank(); }
      if (line === LINES - 1) this.latchScroll();
      this.cycleCarry += cyc;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      // The sound side runs in quarter lines so the Z80 answers the speech chip's data requests in time.
      for (let q = 0; q < 4; q++) {
        this.zCarry += zc;
        this.zCarry -= this.snd.run(Math.floor(this.zCarry));
        this.sampleCarry += samples;
        while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
      }
      this.ym.timers(dt);
    }
  }

  // Vertical blank: IRQ 4 (games with a protection MCU replace this with a simulation of its vblank work).
  vblank() { this.cpu.irq = 4; }

  tw(o) { return (this.textRam[o] << 8) | this.textRam[o + 1]; }
  latchScroll() {
    for (let i = 0; i < 4; i++) {
      this.latched[i] = this.tw(0xE80 + i * 2);
      this.latched[4 + i] = this.tw(0xE90 + i * 2);
      this.latched[8 + i] = this.tw(0xE98 + i * 2);
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, idx = this.index, pri = this.pri, pal = this.palette;
    if (!(this.videoCtl & 0x20)) { out.fill(0xFF000000); return; }
    pri.fill(0);
    // Background (opaque) then foreground, marking priorities; then the text layer.
    this.drawLayer(1, true);
    this.drawLayer(0, false);
    this.drawText();
    this.drawSprites();
    for (let i = 0; i < W * H; i++) out[i] = pal[idx[i]];
  }

  // A tile layer (0 foreground, 1 background) through its 2x2 page arrangement, row by row.
  drawLayer(which, opaque) {
    const idx = this.index, pri = this.pri, pix = this.tilePix, ram = this.tileRam, count = pix.length / 64;
    const xs = this.latched[8 + which], ys = this.latched[4 + which];
    for (let y = 0; y < H; y++) {
      const rs = this.tw(0xF80 + 0x40 * which + (y >> 3) * 2);
      let effx = xs & 0x8000 ? rs : xs, effy = ys, pages = this.latched[which];
      if (rs & 0x8000) { effx = this.latched[8 + which + 2]; effy = this.latched[4 + which + 2]; pages = this.latched[which + 2]; }
      const sx = (0xC0 - effx) & 0x3FF, colScroll = ys & 0x8000 && !(rs & 0x8000);
      // A run at a time: to the end of a tile, or of a 16-pixel column-scroll group.
      for (let x = 0; x < W;) {
        let sy = effy;
        if (colScroll) sy = this.tw(0xF16 + 0x40 * which + ((x + 8) >> 4) * 2);
        const vx = (x + sx) & 0x3FF, vy = (y + (sy & 0x1FF)) & 0x1FF;
        let n = Math.min(8 - (vx & 7), W - x);
        if (colScroll) n = Math.min(n, 16 - ((x + 8) & 15));
        const page = (pages >> (4 * ((vx >> 9) | ((vy >> 8) << 1)))) & 15;
        const o = (page * 2048 + ((vy & 255) >> 3) * 64 + ((vx & 511) >> 3)) * 2;
        const data = (ram[o] << 8) | ram[o + 1];
        const raw = data & 0x1FFF, code = (this.tileBanks[raw >> 12] * 0x1000 + (raw & 0xFFF)) % count, cb = ((data >> 6) & 0x7F) * 8, cat = data >> 15;
        const src = code * 64 + (vy & 7) * 8 + (vx & 7), i0 = y * W + x;
        if (opaque) {
          const pp = cat ? 2 : 1;
          for (let k = 0; k < n; k++) { const p = pix[src + k]; idx[i0 + k] = cb + p; if (p) pri[i0 + k] = pp; }
        } else {
          const pp = cat ? 4 : 2;
          for (let k = 0; k < n; k++) { const p = pix[src + k]; if (p) { idx[i0 + k] = cb + p; pri[i0 + k] = pp; } }
        }
        x += n;
      }
    }
  }

  drawText() {
    const idx = this.index, pri = this.pri, pix = this.tilePix, t = this.textRam, count = pix.length / 64;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W;) {
        const tx = (x + 192) & 511, n = Math.min(8 - (tx & 7), W - x);
        const o = ((y >> 3) * 64 + (tx >> 3)) * 2;
        const data = (t[o] << 8) | t[o + 1];
        const src = ((this.tileBanks[0] * 0x1000 + (data & 0x1FF)) % count) * 64 + (y & 7) * 8 + (tx & 7);
        const cb = ((data >> 9) & 7) * 8, pp = data & 0x8000 ? 8 : 4, i0 = y * W + x;
        for (let k = 0; k < n; k++) { const p = pix[src + k]; if (p) { idx[i0 + k] = cb + p; pri[i0 + k] = pp; } }
        x += n;
      }
    }
  }

  // Sprites, from the end of the list back to the start; zoom by skipping pixels and rows.
  drawSprites() {
    const sr = this.spriteRam, words = this.spriteWords, idx = this.index, pri = this.pri;
    const wd = (i) => (sr[i * 2] << 8) | sr[i * 2 + 1];
    const numBanks = words.length / 0x10000;
    let last = 0;
    while (last < 128 && !(wd(last * 8 + 2) & 0x8000)) last++;
    for (let n = last - 1; n >= 0; n--) {
      const d = n * 8;
      const bottom = wd(d) >> 8, top = wd(d) & 0xFF;
      const xpos = (wd(d + 1) & 0x1FF) - 0xB8;
      const a2 = wd(d + 2), hide = a2 & 0x4000, flip = a2 & 0x100, pitch = (a2 << 24) >> 24;
      let addr = wd(d + 3);
      const a4 = wd(d + 4);
      let bank = this.spriteBanks[(a4 >> 8) & 15];
      const sprpri = 1 << ((a4 >> 6) & 3), color = 0x400 + ((a4 & 0x3F) << 4);
      const zoom = wd(d + 5), vzoom = (zoom >> 5) & 0x1F, hzoom = zoom & 0x1F;
      if (hide || top >= bottom || bank === 255) continue;
      if (numBanks) bank %= numBanks;
      const base = 0x10000 * bank;
      let yacc = zoom & 0x3FF;
      for (let y = top; y < bottom; y++) {
        addr = (addr + pitch) & 0xFFFF;
        yacc += vzoom << 10;
        if (yacc & 0x8000) { addr = (addr + pitch) & 0xFFFF; yacc &= ~0x8000; }
        if (y >= H) continue;
        let xacc = 4 * hzoom, x = xpos, ptr = flip ? addr + 1 : addr - 1;
        const o = y * W;
        const plot = (p) => {
          if (x >= 0 && x < W && p !== 0 && p !== 15) {
            if (sprpri > pri[o + x]) {
              if (color === 0x400 + (0x3F << 4)) { const c = idx[o + x] & 2047; idx[o + x] = c + ((this.palRam[c * 2] & 0x80) ? 4096 : 2048); }
              else idx[o + x] = color | p;
            }
            pri[o + x] = 0xFF;
          }
        };
        for (let guard = 0; guard < 512; guard++) {
          ptr = flip ? ptr - 1 : ptr + 1;
          const pixels = words[base + (ptr & 0xFFFF)] ?? 0;
          let p = 0;
          for (let k = 0; k < 4; k++) {
            p = flip ? (pixels >> (4 * k)) & 15 : (pixels >> (12 - 4 * k)) & 15;
            xacc = (xacc & 0x3F) + hzoom;
            if (xacc < 0x40) { plot(p); x++; }
          }
          if (p === 15 || ((xpos - x) & 0x1FF) === 1) break;
        }
      }
    }
  }
}

export class Shinobi extends System16B {}
Shinobi.id = 'shinobi';
Shinobi.title = 'Shinobi';
Shinobi.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x08], ['3', 0x0C], ['5', 0x04], ['240 (cheat)', 0x00]], default: 0x0C },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x20], ['Normal', 0x30], ['Hard', 0x10], ['Hardest', 0x00]], default: 0x30 },
];

// Altered Beast (1988), 171-5521 ROM board: punch, kick, jump.
export class AlteredBeast extends System16B {
  constructor(roms) {
    super(roms, 5521);
    this.button2 = 'Kick';
    this.button3 = 'Jump';
  }
  // 1 credit to start and continue, demo sounds on.
  applySwitches(v) { this.dsw = 0x01 | v.lives | v.energy | v.difficulty; }
}
AlteredBeast.id = 'altbeast';
AlteredBeast.title = 'Altered Beast';
AlteredBeast.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x08], ['3', 0x0C], ['4', 0x04], ['240 (cheat)', 0x00]], default: 0x0C },
  { id: 'energy', label: 'Energy meter', options: [['2', 0x20], ['3', 0x30], ['4', 0x10], ['5', 0x00]], default: 0x30 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x80], ['Normal', 0xC0], ['Hard', 0x40], ['Hardest', 0x00]], default: 0xC0 },
];

// Golden Axe (1989) with an 8751 MCU: on the 171-5797 ROM board (317-123A) or
// the 171-5704 board (317-0112, Altered Beast's), as roms.board says. The
// MCU's dump is missing, so its jobs are done here: it sets up the mapper, and
// each vblank raises IRQ 4, refills a table the game clears, passes the sound
// command along and copies the joysticks into work RAM.
const GOLDNAXE_MAPPER = {
  5797: [0x02, 0x00, 0x00, 0x1F, 0x00, 0x1E, 0x00, 0xFF, 0x00, 0x20, 0x01, 0x10, 0x00, 0x14, 0x00, 0xC4],
  5704: [0x02, 0x00, 0x02, 0x08, 0x00, 0x1F, 0x00, 0xFF, 0x00, 0x20, 0x01, 0x10, 0x00, 0x14, 0x00, 0xC4],
};
export class GoldenAxe extends System16B {
  constructor(roms) {
    const board = roms.board ?? 5797;
    super(roms, board, GOLDNAXE_MAPPER[board]);
    this.button2 = 'Jump';
    this.button3 = 'Magic';
  }
  ww(o) { return (this.workRam[o] << 8) | this.workRam[o + 1]; }
  setW(o, v) { this.workRam[o] = v >> 8; this.workRam[o + 1] = v & 0xFF; }
  vblank() {
    this.cpu.irq = 4;
    if (!this.ww(0x2CD8) && !this.ww(0x2CDA) && !this.ww(0x2CDC) && !this.ww(0x2CDE)) {
      this.setW(0x2CD8, 0x048C); this.setW(0x2CDA, 0x159D); this.setW(0x2CDC, 0x26AE); this.setW(0x2CDE, 0x37BF);
    }
    const snd = this.ww(0x2CFC);
    if (snd & 0xFF00) { this.mapperWrite(0x03, snd >> 8); this.setW(0x2CFC, snd & 0xFF); }
    this.setW(0x2CD0, (this.p1 << 8) | this.p2);
    this.setW(0x2C96, this.svc << 8);
  }
  applySwitches(v) { this.dsw = 0xC1 | v.lives | v.energy; }
}
GoldenAxe.id = 'goldnaxe';
GoldenAxe.title = 'Golden Axe';
GoldenAxe.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x08], ['2', 0x0C], ['3', 0x04], ['5', 0x00]], default: 0x0C },
  { id: 'energy', label: 'Energy meter', options: [['2', 0x20], ['3', 0x30], ['4', 0x10], ['5', 0x00]], default: 0x30 },
];
