// Sun Electronics Kangaroo (1982): a Z80 drawing into two 256x256 bitmaps
// that share one RAM, four bits a pixel each: plane A (the playfield, which
// scrolls) and plane B (the moving objects). Writes to bitmap RAM go to the
// planes and bit pairs picked by the bank select latch, and a DMA "blitter"
// copies pictures from the graphics ROMs (readable at C000) into them. Colors
// are one bit a gun; a mask register halves each gun's intensity per plane
// unless a pixel's fourth bit says full strength. A second Z80 plays an
// AY-3-8910. 256x240 on a vertical monitor at 60 Hz.
//
// The board's MB8841 microcontroller isn't emulated (as in MAME): its port
// reads as a counter, and an NMI at reset gets the game past its RAM check.

import { Z80 } from './z80.js';
import { AY8910 } from './ay8910.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba, rotate90 } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 240, TOP = 8, LINES = 262, REFRESH = 60;
const LINE_CYCLES = 2500000 / REFRESH / LINES, SAMPLES = RATE / REFRESH / LINES;
const STATE = ['ram', 'soundRam', 'pixels', 'blitter', 'scroll', 'bankSelect', 'videoCtl', 'colorMask', 'latch', 'secClock',
  'in0', 'in1', 'cycleCarry', 'soundCarry', 'sampleCarry', 'cpu', 'snd', 'sound'];

export class Kangaroo {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.setMask(this.colorMask); }

  // roms: { main 24K (0000-5FFF), sound 4K, gfx 16K (two 8K banks seen at C000) }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x400);              // E000-E3FF
    this.soundRam = new Uint8Array(0x400);         // 4000-43FF
    this.pixels = new Uint8Array(256 * 256);       // each byte: plane A in the low nibble, plane B in the high one
    this.blitter = new Uint8Array(6);
    this.scroll = new Uint8Array(2);               // E806 vertical, E807 horizontal (plane A)
    this.palette = new Uint32Array(24);            // 0-7 full intensity, 8-15 plane A masked, 16-23 plane B masked
    for (let i = 0; i < 8; i++) this.palette[i] = rgba(i & 4 ? 255 : 0, i & 2 ? 255 : 0, i & 1 ? 255 : 0);
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v), output: (p, v) => this.soundOut(p, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.ay = new AY8910(1250000, () => 0xFF, 1);
    this.sound = new SoundMix([this.ay], 1.2);
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.in0 = 0; this.in1 = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.soundRam, this.pixels, this.blitter, this.scroll]) a.fill(0);
    this.bankSelect = 0; this.videoCtl = 0; this.latch = 0; this.secClock = 0;
    this.setMask(0);
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
    this.cpu.nmi();                                // (the microcontroller's NMI at power-on)
  }

  // The mask register: bits 5-3 plane A's red, green, blue at full (else half) strength; bits 2-0 plane B's.
  setMask(v) {
    this.colorMask = v;
    for (let i = 0; i < 8; i++) {
      const g = (on, bit) => (on ? (v & bit ? 0xFF : 0x7F) : 0);
      this.palette[8 + i] = rgba(g(i & 4, 0x20), g(i & 2, 0x10), g(i & 1, 0x08));
      this.palette[16 + i] = rgba(g(i & 4, 0x04), g(i & 2, 0x02), g(i & 1, 0x01));
    }
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x6000) return this.roms.main[a];
    if (a >= 0xC000 && a < 0xE000) return this.roms.gfx[(this.bankSelect & 0x05 ? 0 : 0x2000) + (a - 0xC000)];
    if (a >= 0xE000 && a < 0xE400) return this.ram[a - 0xE000];
    switch (a) {
      case 0xE400: return this.dsw;
      case 0xEC00: return this.in0;
      case 0xED00: return this.in1;
      case 0xEE00: return 0;                       // player 2 (cocktail)
      case 0xEF00: this.secClock = (this.secClock + 1) & 0xFF; return this.secClock & 0x0F;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0xC000) { this.bitmapWrite(a - 0x8000, v); return; }
    if (a >= 0xE000 && a < 0xE400) { this.ram[a - 0xE000] = v; return; }
    if (a >= 0xE800 && a < 0xE806) { this.blitter[a - 0xE800] = v; if (a === 0xE805) this.blit(); return; }
    switch (a) {
      case 0xE806: this.scroll[0] = v; return;
      case 0xE807: this.scroll[1] = v; return;
      case 0xE808: this.bankSelect = v; return;
      case 0xE809: this.videoCtl = v; return;
      case 0xE80A: this.setMask(v); return;
      case 0xEC00: this.latch = v; return;
      // ED00 coin counters, EF00-EFFF the microcontroller.
    }
  }

  // A bitmap write: 4 pixels in a column, one bit of each from each nibble of the byte, into the
  // bit pairs the bank select picks (bit 0: plane A's Z/R, 1: A's G/B, 2: B's Z/R, 3: B's G/B).
  bitmapWrite(offset, v) {
    const px = this.pixels, b = this.bankSelect, o = (offset & 255) * 256 + (offset >> 8) * 4;
    for (let i = 0; i < 4; i++) {
      const lo = (v >> i) & 1, hi = (v >> (i + 4)) & 1;
      let p = px[o + i];
      if (b & 2) p = (p & 0xFC) | (hi << 1) | lo;
      if (b & 1) p = (p & 0xF3) | (hi << 3) | (lo << 2);
      if (b & 8) p = (p & 0xCF) | (hi << 5) | (lo << 4);
      if (b & 4) p = (p & 0x3F) | (hi << 7) | (lo << 6);
      px[o + i] = p;
    }
  }

  // The DMA: copy a (width x height) picture from ROM into bitmap RAM, once for each half of the planes.
  blit() {
    const bl = this.blitter, xb = bl[5], yb = bl[4], old = this.bankSelect;
    let sel = old;
    if (sel & 0x0C) sel |= 0x0C;
    if (sel & 0x03) sel |= 0x03;
    for (const part of [sel & 0x05, sel & 0x0A]) {
      this.bankSelect = part;
      let src = bl[0] | (bl[1] << 8), dest = bl[2] | (bl[3] << 8);
      for (let x = 0; x <= xb; x++) {
        for (let y = 0; y <= yb; y++) this.write(dest++ & 0xFFFF, this.read(src++ & 0xFFFF));
        dest = dest - (yb + 1) + 256;
      }
    }
    this.bankSelect = old;
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x1000) return this.roms.sound[a];
    if (a >= 0x4000 && a < 0x4400) return this.soundRam[a - 0x4000];
    if (a === 0x6000) return this.latch;
    return 0xFF;
  }
  soundWrite(a, v) { if (a >= 0x4000 && a < 0x4400) this.soundRam[a - 0x4000] = v; }
  // The AY-3-8910 sits at I/O 7000 (data) and 8000 (register select).
  soundOut(p, v) {
    const hi = (p >> 8) & 0xFF;
    if (hi === 0x70) this.ay.write(v);
    else if (hi === 0x80) this.ay.select(v);
  }

  // ---------------------------------------------------------------- inputs

  // Active high. IN0: start 1, start 2, coin (music on, upright). IN1: right, left, up, down, punch.
  setInputs(s) {
    this.in0 = (s.start1 ? 0x02 : 0) | (s.start2 ? 0x04 : 0) | (s.coin ? 0x08 : 0);
    this.in1 = (s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.up ? 0x04 : 0) | (s.down ? 0x08 : 0) | (s.fire ? 0x10 : 0);
  }

  // DSW: lives, difficulty, bonus life; 1 coin 1 credit.
  applySwitches(v) { this.dsw = v.lives | v.difficulty | v.bonus; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === TOP + H) { this.render(); this.cpu.irq = true; this.snd.irq = true; }
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.soundCarry += LINE_CYCLES;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += SAMPLES;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  // Plane A scrolls; bank select bit 0 puts plane B behind it (else B goes on top). A plane's
  // pixel 0 is see-through when it's the one on top. Each plane can be flipped (cocktail).
  render() {
    const out = this.native, px = this.pixels, pal = this.palette;
    const flipA = this.videoCtl & 0x20, flipB = this.videoCtl & 0x10, bOnTop = !(this.bankSelect & 0x01);
    const sx = this.scroll[1], sy = this.scroll[0];
    for (let y = 0; y < H; y++) {
      const yy = y + TOP;
      for (let x = 0; x < W; x++) {
        let ax = (x - sx) & 255, ay = (yy - sy) & 255;
        if (flipA) { ax = 255 - ax; ay = 255 - ay; }
        const bxy = flipB ? (255 - yy) * 256 + (255 - x) : yy * 256 + x;
        const a = px[ay * 256 + ax] & 15, b = px[bxy] >> 4;
        const ca = a & 8 ? a & 7 : 8 + a, cb = b & 8 ? b & 7 : 16 + b;
        out[y * W + x] = pal[bOnTop ? (b ? cb : ca) : (a ? ca : cb)];
      }
    }
    rotate90(out, W, H, this.frame);
  }
}

Kangaroo.id = 'kangaroo';
Kangaroo.title = 'Kangaroo';
Kangaroo.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x00], ['5', 0x01]], default: 0x00 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x00], ['Hard', 0x02]], default: 0x00 },
  { id: 'bonus', label: 'Bonus', options: [['None', 0x00], ['10K', 0x04], ['10K, 30K', 0x08], ['20K, 40K', 0x0C]], default: 0x08 },
];
