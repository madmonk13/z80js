// Amstar Phoenix (1980): an Intel 8085 at 2.75 MHz (run on the Z80 core:
// Phoenix sticks to the 8080 instructions the two share), two 32x32 tile
// layers (a scrolling background and a foreground) in two banks of video RAM
// that double as the players' work RAM, a 256-color PROM palette with a bank
// bit, and analog sound: two tone effects, filtered noise, and a melody chip
// that plays its built-in tunes. No interrupts: the game polls vertical blank.
//
// The sound is modeled from the circuits' descriptions; the melodies are
// transcribed by hand, not taken from the melody chip.
//
// 256 lines of about 179 cycles (60 Hz); the picture is 248x208 on a
// vertical monitor.

import { Z80 } from './z80.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { RATE } from './mixer.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 248, H = 208;
const LINES = 256, CPU_CLOCK = 11000000 / 4, LINE_CYCLES = CPU_CLOCK / 60 / LINES;
const STATE = ['vram', 'page', 'palBank', 'scroll', 'cycleCarry', 'sampleCarry', 'line', 'in0', 'cpu', 'sound'];

// Notes as MIDI numbers with lengths in beats.
const FUR_ELISE = [[76, 1], [75, 1], [76, 1], [75, 1], [76, 1], [71, 1], [74, 1], [72, 1], [69, 2], [60, 1], [64, 1], [69, 1], [71, 2],
  [64, 1], [68, 1], [71, 1], [72, 2], [64, 1], [76, 1], [75, 1], [76, 1], [75, 1], [76, 1], [71, 1], [74, 1], [72, 1], [69, 2],
  [60, 1], [64, 1], [69, 1], [71, 2], [64, 1], [72, 1], [71, 1], [69, 3]];
const ROMANCE = [[71, 1], [71, 1], [71, 1], [71, 1], [69, 1], [67, 1], [67, 1], [66, 1], [64, 1], [64, 1], [67, 1], [71, 1],
  [76, 1], [76, 1], [76, 1], [76, 1], [74, 1], [72, 1], [72, 1], [71, 1], [69, 1], [69, 1], [71, 1], [72, 1],
  [71, 1], [72, 1], [71, 1], [71, 1], [72, 1], [71, 1], [71, 1], [69, 1], [67, 1], [67, 1], [66, 1], [64, 3]];
const TUNES = [null, ROMANCE, ROMANCE, FUR_ELISE];      // the game opens with tune 3; which of 1-2 is which is a guess
const BEAT = 0.21;                               // seconds per beat

class PhoenixSound {
  constructor() {
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }
  saveState() { return capture(this, ['a', 'b', 'e1cv', 'e1ph', 'e2ph', 'e2lfo', 'v24', 'v25', 'noise', 'nacc', 'nbit', 'lbit', 'lacc', 'tune', 'note', 'noteT', 'mph', 'menv', 'dcIn', 'dcOut']); }
  loadState(s) { apply(this, ['a', 'b', 'e1cv', 'e1ph', 'e2ph', 'e2lfo', 'v24', 'v25', 'noise', 'nacc', 'nbit', 'lbit', 'lacc', 'tune', 'note', 'noteT', 'mph', 'menv', 'dcIn', 'dcOut'], s); }
  reset() {
    this.a = 0xFF; this.b = 0xFF;
    this.e1cv = 0; this.e1ph = 0; this.e2ph = 0; this.e2lfo = 0;
    this.v24 = 0; this.v25 = 0; this.noise = 1; this.nacc = 0; this.nbit = 0; this.lbit = 0; this.lacc = 0;
    this.tune = 0; this.note = 0; this.noteT = 0; this.mph = 0; this.menv = 0;
    this.dcIn = this.dcOut = 0;
    this.writePos = this.readPos = 0;
  }
  writeA(v) { this.a = v; }
  writeB(v) {
    const tune = v >> 6;
    if (tune !== this.tune) { this.tune = tune; this.note = 0; this.noteT = 0; this.menv = tune ? 1 : 0; }
    this.b = v;
  }

  // A counter-divided tone: `data` (0-15) sets the divider; 15 is silent.
  divided(clock, data, phaseKey) {
    if ((data & 15) === 15) return 0;
    const f = clock / (2 * (16 - (data & 15)));
    this[phaseKey] = (this[phaseKey] + f / RATE) % 1;
    return this[phaseKey] < 0.5 ? 1 : -1;
  }

  sample() {
    const dt = 1 / RATE;
    // Effect 1 (B 0-3 data, 4 sweep, 5 filter): a 555 whose control voltage
    // charges while bit 4 is high, sweeping the pitch.
    this.e1cv += ((this.b & 0x10 ? 1 : 0) - this.e1cv) * (dt / 0.3);
    let s1 = this.divided(9000 * (1.4 - this.e1cv * 0.7), this.b, 'e1ph') * 0.25;
    if (this.b & 0x20) s1 *= 0.6;
    // Effect 2 (A 0-3 data, 4-5 rate): a tone warbled by a slow oscillator.
    const rates = [12, 3, 1.6, 1.1];
    this.e2lfo = (this.e2lfo + rates[(this.a >> 4) & 3] * dt) % 1;
    const warble = 1 + 0.25 * Math.sin(this.e2lfo * 2 * Math.PI);
    const s2 = this.divided(18000 * warble, this.a, 'e2ph') * ((this.a & 0x20) ? 0.2 : 0.1);
    // Noise: bit 6 high fades one envelope in over ~0.14 s (low cuts it
    // quickly); bit 7 high brings the other up quickly and low lets it decay
    // over ~0.32 s, and that one's noise is low-passed.
    this.v24 += ((this.a & 0x40 ? 1 : 0) - this.v24) * (dt / (this.a & 0x40 ? 0.136 : 0.009));
    this.v25 += ((this.a & 0x80 ? 1 : 0) - this.v25) * (dt / (this.a & 0x80 ? 0.009 : 0.32));
    const level = (this.v24 + this.v25) / 2;
    this.nacc += (588 + 6325 * level) * dt;
    while (this.nacc >= 1) {
      this.nacc -= 1;
      const bit = ((this.noise >> 16) ^ (this.noise >> 17)) & 1;
      this.noise = ((this.noise << 1) | (bit ^ 1)) & 0x3FFFF;
      this.nbit = this.noise & 1;
    }
    this.lacc += 400 * dt;
    if (this.lacc >= 1) { this.lacc -= 1; this.lbit = this.nbit; }
    const sn = (this.nbit ? 0 : this.v24) * 0.35 + (this.lbit ? 0 : this.v25) * 0.35;
    // Melody: the selected tune, note by note, each note decaying.
    let sm = 0;
    const tune = TUNES[this.tune];
    if (tune) {
      const [midi, beats] = tune[this.note];
      this.noteT += dt;
      if (this.noteT >= beats * BEAT) { this.noteT = 0; this.note = (this.note + 1) % tune.length; this.menv = 1; }
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      this.mph = (this.mph + f * dt) % 1;
      this.menv *= Math.exp(-dt / 0.5);
      sm = (this.mph < 0.5 ? 1 : -1) * this.menv * 0.18;
    }
    const s = s1 + s2 + sn + sm;
    const out = s - this.dcIn + 0.995 * this.dcOut;
    this.dcIn = s; this.dcOut = out;
    const mask = this.buffer.length - 1;
    this.buffer[this.writePos] = out;
    this.writePos = (this.writePos + 1) & mask;
    if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
  }

  available() { return (this.writePos - this.readPos) & (this.buffer.length - 1); }
  pull(out, outRate) {
    const buf = this.buffer, mask = buf.length - 1, step = RATE / outRate;
    if (this.available() > RATE * 0.075) this.readPos = (this.writePos - Math.floor(RATE * 0.035)) & mask;
    let pos = this.frac || 0, last = this.last || 0;
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) { out[i] = last *= 0.995; continue; }
      const s0 = buf[this.readPos], s1 = buf[(this.readPos + 1) & mask];
      last = out[i] = s0 + (s1 - s0) * pos;
      pos += step;
      while (pos >= 1 && this.available() > 1) { pos -= 1; this.readPos = (this.readPos + 1) & mask; }
    }
    this.frac = pos; this.last = last;
  }
}

export class Phoenix {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 16K, bg 4K, fg 4K, palLo 256, palHi 256 }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = 60;
    this.controls = 'two-way';
    this.buttons = 2;
    this.button2 = 'Shield';
    this.roms = roms;
    this.vram = new Uint8Array(0x2000);         // two 4K pages
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sound = new PhoenixSound();
    const chars = (rom) => decodeTiles(rom, { count: 256, width: 8, height: 8, planes: [256 * 64, 0], xs: run(7, 8, -1), ys: run(0, 8, 8), size: 64 });
    this.bgPix = chars(roms.bg);
    this.fgPix = chars(roms.fg);
    // Palette: each PROM gives one bit of red, blue and green.
    this.palette = Uint32Array.from({ length: 256 }, (_, i) => {
      const lo = roms.palLo[i], hi = roms.palHi[i], c = (bit) => 0x55 * ((lo >> bit) & 1) + 0xAA * ((hi >> bit) & 1);
      return rgba(c(0), c(2), c(1));
    });
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.in0 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.vram.fill(0);
    this.page = 0; this.palBank = 0; this.scroll = 0;
    this.cycleCarry = this.sampleCarry = 0;
    this.line = 0;
    this.cpu.reset();
    this.sound.reset();
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x4000) return this.roms.main[a];
    if (a < 0x5000) return this.vram[this.page * 0x1000 + (a & 0xFFF)];
    if (a >= 0x7000 && a < 0x7400) return this.in0;
    if (a >= 0x7800 && a < 0x7C00) return this.dsw | (this.line >= H ? 0 : 0x80);   // bit 7 low in vertical blank
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x4000 && a < 0x5000) { this.vram[this.page * 0x1000 + (a & 0xFFF)] = v; return; }
    if (a >= 0x5000 && a < 0x5400) { this.page = v & 1; this.palBank = (v >> 1) & 1; return; }
    if (a >= 0x5800 && a < 0x5C00) { this.scroll = v; return; }
    if (a >= 0x6000 && a < 0x6400) { this.sound.writeA(v); return; }
    if (a >= 0x6800 && a < 0x6C00) this.sound.writeB(v);
  }

  // ---------------------------------------------------------------- inputs

  // IN0 (active low): coin, starts, fire, right, left, shield.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x02 : 0) | (s.start2 ? 0x04 : 0) | (s.fire ? 0x10 : 0)
      | (s.right ? 0x20 : 0) | (s.left ? 0x40 : 0) | (s.fire2 ? 0x80 : 0));
  }
  // Lives, bonus, 1 coin 1 credit, unknowns off.
  applySwitches(v) { this.dsw = v.lives | v.bonus | 0x60; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const samplesPerLine = RATE / 60 / LINES;
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      if (line === H) this.render();
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += samplesPerLine;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  // Color for layer pen p of tile code c: color code from the top 3 bits of
  // the code and the palette bank; the PROM index interleaves pen and code.
  color(code, pen, fg) {
    const c = (code >> 5) | (this.palBank << 3);
    return this.palette[(c & 7) | (pen << 3) | ((c & 8) << 3) | (fg ? 0x20 : 0)];
  }

  render() {
    const out = this.native, base = this.page * 0x1000, vram = this.vram;
    for (let y = 0; y < H; y++) {
      const row = y >> 3, py = y & 7;
      for (let x = 0; x < W; x++) {
        // Foreground (codes at 000), see-through on pen 0 except in the first column.
        const fi = row * 32 + (x >> 3), fcode = vram[base + fi];
        const fpen = this.fgPix[fcode * 64 + py * 8 + (x & 7)];
        if (fpen || (x >> 3) === 0) { out[y * W + x] = this.color(fcode, fpen, true); continue; }
        // Background (codes at 800), scrolled horizontally.
        const bx = (x + this.scroll) & 0xFF, bi = row * 32 + (bx >> 3), bcode = vram[base + 0x800 + bi];
        out[y * W + x] = this.color(bcode, this.bgPix[bcode * 64 + py * 8 + (bx & 7)], false);
      }
    }
    rotate90(out, W, H, this.frame);
  }
}

Phoenix.id = 'phoenix';
Phoenix.title = 'Phoenix';
Phoenix.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x00], ['4', 0x01], ['5', 0x02], ['6', 0x03]], default: 0x00 },
  { id: 'bonus', label: 'Bonus', options: [['3K/30K', 0x00], ['4K/40K', 0x04], ['5K/50K', 0x08], ['6K/60K', 0x0C]], default: 0x00 },
];
