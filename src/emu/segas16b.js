// Sega System 16B (1987-91): Shinobi. A 68000 at 10 MHz behind Sega's
// 315-5195 memory mapper (the game programs where each area appears), a Z80
// at 5 MHz with a YM2151 and a uPD7759 ADPCM speech chip fed by the Z80.
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

// The mapper's regions for the 171-5358 ROM board: [register, offset, length, mirror, kind].
// Later entries win where they overlap.
const REGIONS = [
  [0x1E, 0x00000, 0x04000, 0xFFC000, 'io'],
  [0x1C, 0x00000, 0x01000, 0xFFF000, 'palette'],
  [0x1A, 0x00000, 0x10000, 0xFE0000, 'tile'],
  [0x1A, 0x10000, 0x01000, 0xFEF000, 'text'],
  [0x18, 0x00000, 0x00800, 0xFFF800, 'sprite'],
  [0x16, 0x00000, 0x04000, 0xFFC000, 'work'],
  [0x14, 0x00000, 0x20000, 0xFE0000, 'rom'],
  [0x12, 0x00000, 0x20000, 0xFE0000, 'rom'],
  [0x10, 0x00000, 0x20000, 0xFE0000, 'rom'],
];
const KINDS = ['io', 'palette', 'tile', 'text', 'sprite', 'work', 'rom'];
// Sprite bank numbers on this ROM board (others don't exist: 255).
const SPRITE_BANKS = [0, 255, 255, 255, 255, 255, 255, 3, 255, 255, 255, 2, 255, 1, 0, 255];

const STATE = ['mapRegs', 'palRam', 'tileRam', 'textRam', 'spriteRam', 'workRam', 'soundRam', 'latch', 'soundBank', 'videoCtl',
  'latched', 'cycleCarry', 'zCarry', 'sampleCarry', 'svc', 'p1', 'cpu', 'snd', 'ym', 'upd'];

export class System16B {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.remap(); for (let i = 0; i < 2048; i++) this.setColor(i); }

  // roms: { main (68000, big-endian), tiles (3 planes), sprites (big-endian words), sound (Z80), samples: [ROMs by chip select] }
  constructor(roms) {
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
    this.blockMap = new Int8Array(0x2000);       // 2K blocks of the address space -> region index (-1: the mapper itself)
    this.remap();
    this.palette = new Uint32Array(2048 * 3).fill(0xFF000000);
    this.frame = new Uint32Array(W * H);
    this.index = new Uint16Array(W * H);         // palette index per pixel (for shadow/highlight)
    this.pri = new Uint8Array(W * H);

    const third = roms.tiles.length / 3 * 8;
    this.tilePix = decodeTiles(roms.tiles, { count: roms.tiles.length / 24, width: 8, height: 8, planes: [2 * third, third, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
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
    for (const a of [this.mapRegs, this.palRam, this.tileRam, this.textRam, this.spriteRam, this.workRam, this.soundRam, this.latched]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.latch = 0; this.soundBank = 0; this.videoCtl = 0;
    this.cycleCarry = this.zCarry = this.sampleCarry = 0;
    this.remap();
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- the memory mapper

  remap() {
    const map = this.blockMap, regs = this.mapRegs, rom = this.roms.main.length;
    this.ranges = REGIONS.map(([reg, offs, len, mirror, kind]) => {
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

  locate(a) {
    const i = this.blockMap[(a >> 11) & 0x1FFF];
    if (i < 0) return null;
    const r = this.ranges[i];
    return [r.kind, ((a & ~r.mirror) - r.start), (a & ~r.mirror)];
  }

  read16(a) {
    const hit = this.locate(a);
    if (!hit) return 0xFF00 | this.mapperRead(a >> 1);
    const [kind, o, abs] = hit;
    const word = (arr, i) => (arr[i] << 8) | arr[i + 1];
    switch (kind) {
      case 0: return this.io(o >> 1);
      case 1: return word(this.palRam, o & 0xFFE);
      case 2: return word(this.tileRam, o & 0xFFFE);
      case 3: return word(this.textRam, o & 0xFFE);
      case 4: return word(this.spriteRam, o & 0x7FE);
      case 5: return word(this.workRam, o & 0x3FFE);
      default: return word(this.roms.main, abs);
    }
  }
  read8(a) { const w = this.read16(a & ~1); return a & 1 ? w & 0xFF : w >> 8; }

  write16(a, v) { this.write(a & ~1, v, 3); }
  write8(a, v) { if (a & 1) this.write(a & ~1, v & 0xFF, 1); else this.write(a, (v & 0xFF) << 8, 2); }

  // mask: 1 low byte, 2 high byte, 3 both.
  write(a, v, mask) {
    const hit = this.locate(a);
    if (!hit) { if (mask & 1) this.mapperWrite(a >> 1, v & 0xFF); return; }
    const [kind, o] = hit;
    const put = (arr, i) => { if (mask & 2) arr[i] = v >> 8; if (mask & 1) arr[i + 1] = v & 0xFF; };
    switch (kind) {
      case 0: if ((o >> 1 & 0x1800) === 0 && (mask & 1)) this.videoCtl = v & 0xFF; return;   // display enable, flip
      case 1: put(this.palRam, o & 0xFFE); this.setColor((o & 0xFFE) >> 1); return;
      case 2: put(this.tileRam, o & 0xFFFE); return;
      case 3: put(this.textRam, o & 0xFFE); return;
      case 4: put(this.spriteRam, o & 0x7FE); return;
      case 5: put(this.workRam, o & 0x3FFE); return;
    }
  }

  // I/O: 1000 inputs (service, P1, -, P2), 2000 switches (game, coinage).
  io(w) {
    switch (w & 0x1800) {
      case 0x0800: return [this.svc, this.p1, 0xFF, 0xFF][w & 3];
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
      if (line === H) { this.render(); this.cpu.irq = 4; }      // vertical blank: IRQ 4
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
      const sx = (0xC0 - effx) & 0x3FF;
      for (let x = 0; x < W; x++) {
        let sy = effy;
        if (ys & 0x8000 && !(rs & 0x8000)) sy = this.tw(0xF16 + 0x40 * which + ((x + 8) >> 4) * 2);
        const vx = (x + sx) & 0x3FF, vy = (y + (sy & 0x1FF)) & 0x1FF;
        const page = (pages >> (4 * ((vx >> 9) | ((vy >> 8) << 1)))) & 15;
        const o = (page * 2048 + ((vy & 255) >> 3) * 64 + ((vx & 511) >> 3)) * 2;
        const data = (ram[o] << 8) | ram[o + 1];
        const code = (data & 0x1FFF) % count, color = (data >> 6) & 0x7F, cat = data >> 15;
        const p = pix[code * 64 + (vy & 7) * 8 + (vx & 7)];
        const i = y * W + x;
        if (opaque) { idx[i] = color * 8 + p; if (p) pri[i] = cat ? 2 : 1; }
        else if (p) { idx[i] = color * 8 + p; pri[i] = cat ? 4 : 2; }
      }
    }
  }

  drawText() {
    const idx = this.index, pri = this.pri, pix = this.tilePix, t = this.textRam;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const tx = (x + 192) & 511;
        const o = ((y >> 3) * 64 + (tx >> 3)) * 2;
        const data = (t[o] << 8) | t[o + 1];
        const p = pix[(data & 0x1FF) * 64 + (y & 7) * 8 + (tx & 7)];
        if (!p) continue;
        const i = y * W + x;
        idx[i] = ((data >> 9) & 7) * 8 + p;
        pri[i] = data & 0x8000 ? 8 : 4;
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
      let bank = SPRITE_BANKS[(a4 >> 8) & 15];
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
