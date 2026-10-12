// TI TMS5220 speech synthesizer, in Speak External mode (the host feeds the
// LPC data through a 16-byte FIFO; Star Wars, Indiana Jones, Gauntlet).
//
// Speech comes in 25 ms frames of packed fields, read LSB first: a 4-bit
// energy (0 silence, 15 stop), a repeat bit, a 6-bit pitch (0 unvoiced), then
// ten reflection coefficients K1-K10 (5,5,4,4,4,4,4,3,3,3 bits; unvoiced
// frames carry only K1-K4). At 8 kHz the chip excites a 10-stage lattice
// filter with a chirp each pitch period (voiced) or noise (unvoiced), and
// moves its parameters toward each new frame in 8 interpolation steps.
//
// Commands (written when not speaking): 6x Speak External (start once 9
// bytes are queued), 7x Reset. Status: bit 7 talking, 6 buffer low (FIFO
// under half full), 5 buffer empty. Ready while the FIFO has room.

import { capture, apply } from './state.js';

// The chip's lookup tables (energy, pitch period, K1-K10, chirp). Ks are
// fractions times 32768.
const ENERGY = [0, 3, 5, 7, 10, 14, 20, 29, 40, 57, 81, 114, 161, 227, 321, 511];
const PITCH = [0, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
  39, 40, 41, 42, 43, 45, 47, 49, 51, 53, 54, 57, 59, 61, 63, 66, 69, 71, 73, 77, 79, 81, 85, 87, 92, 95, 99,
  102, 106, 110, 115, 119, 123, 128, 133, 138, 143, 149, 154, 160];
const s16 = (v) => (v << 16) >> 16;
const K = [
  [0x82C0, 0x8380, 0x83C0, 0x8440, 0x84C0, 0x8540, 0x8600, 0x8780, 0x8880, 0x8980, 0x8AC0, 0x8C00, 0x8D40, 0x8F00, 0x90C0, 0x92C0,
    0x9900, 0xA140, 0xAB80, 0xB840, 0xC740, 0xD8C0, 0xEBC0, 0x0000, 0x1440, 0x2740, 0x38C0, 0x47C0, 0x5480, 0x5EC0, 0x6700, 0x6D40],
  [0xAE00, 0xB480, 0xBB80, 0xC340, 0xCB80, 0xD440, 0xDDC0, 0xE780, 0xF180, 0xFBC0, 0x0600, 0x1040, 0x1A40, 0x2400, 0x2D40, 0x3600,
    0x3E40, 0x45C0, 0x4CC0, 0x5300, 0x5880, 0x5DC0, 0x6240, 0x6640, 0x69C0, 0x6CC0, 0x6F80, 0x71C0, 0x73C0, 0x7580, 0x7700, 0x7E80],
  [0x9200, 0x9F00, 0xAD00, 0xBA00, 0xC800, 0xD500, 0xE300, 0xF000, 0xFE00, 0x0B00, 0x1900, 0x2600, 0x3400, 0x4100, 0x4F00, 0x5C00],
  [0xAE00, 0xBC00, 0xCA00, 0xD800, 0xE600, 0xF400, 0x0100, 0x0F00, 0x1D00, 0x2B00, 0x3900, 0x4700, 0x5500, 0x6300, 0x7100, 0x7E00],
  [0xAE00, 0xBA00, 0xC500, 0xD100, 0xDD00, 0xE800, 0xF400, 0xFF00, 0x0B00, 0x1700, 0x2200, 0x2E00, 0x3900, 0x4500, 0x5100, 0x5C00],
  [0xC000, 0xCB00, 0xD600, 0xE100, 0xEC00, 0xF700, 0x0300, 0x0E00, 0x1900, 0x2400, 0x2F00, 0x3A00, 0x4500, 0x5000, 0x5B00, 0x6600],
  [0xB300, 0xBF00, 0xCB00, 0xD700, 0xE300, 0xEF00, 0xFB00, 0x0700, 0x1300, 0x1F00, 0x2B00, 0x3700, 0x4300, 0x4F00, 0x5A00, 0x6600],
  [0xC000, 0xD800, 0xF000, 0x0700, 0x1F00, 0x3700, 0x4F00, 0x6600],
  [0xC000, 0xD400, 0xE800, 0xFC00, 0x1000, 0x2500, 0x3900, 0x4D00],
  [0xCD00, 0xDF00, 0xF100, 0x0400, 0x1600, 0x2000, 0x3B00, 0x4D00],
].map((t) => t.map(s16));
const K_BITS = [5, 5, 4, 4, 4, 4, 4, 3, 3, 3];
const CHIRP = Int8Array.from([0x00, 0x2a, 0xd4, 0x32, 0xb2, 0x12, 0x25, 0x14, 0x02, 0xe1, 0xc5, 0x02, 0x5f, 0x5a, 0x05, 0x0f,
  0x26, 0xfc, 0xa5, 0xa5, 0xd6, 0xdd, 0xdc, 0xfc, 0x25, 0x2b, 0x22, 0x21, 0x0f, 0xff, 0xf8, 0xee, 0xed, 0xef, 0xf7, 0xf6,
  0xfa, 0x00, 0x03, 0x02, 0x01]);
const INTERP_SHIFT = [3, 3, 3, 2, 2, 1, 1, 0];       // per 25-sample step of a frame

const STATE = ['fifo', 'head', 'count', 'bit', 'external', 'talking', 'empty', 'stopping', 'step', 'sub', 'pitchCount',
  'energy', 'pitch', 'k', 'target', 'lastK', 'prevEnergy', 'u', 'x', 'rng', 'out'];

export class TMS5220 {
  constructor(gain = 1) { this.gain = gain; this.reset(); }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.fifo = new Uint8Array(16); this.head = 0; this.count = 0; this.bit = 0;
    this.external = false; this.talking = false; this.empty = false; this.stopping = false;
    this.step = 0; this.sub = 0; this.pitchCount = 0;
    this.energy = 0; this.pitch = 0; this.k = new Int32Array(10);
    this.target = { energy: 0, pitch: 0, k: new Int32Array(10) };
    this.lastK = new Int32Array(10);
    this.prevEnergy = 0;
    this.u = new Int32Array(11); this.x = new Int32Array(10);
    this.rng = 0x1FFF;
    this.out = 0;
  }

  // ---------------------------------------------------------------- host side

  write(v) {
    if (this.external) {
      if (this.count < 16) { this.fifo[(this.head + this.count) & 15] = v; this.count++; this.empty = false; }
      return;
    }
    switch (v & 0x70) {
      case 0x60: this.external = true; this.talking = false; this.empty = true; this.count = 0; this.bit = 0; break;
      case 0x70: this.reset(); break;
    }
  }
  status() { return (this.talking ? 0x80 : 0) | (this.count < 8 ? 0x40 : 0) | (this.empty ? 0x20 : 0); }
  ready() { return this.count < 15; }

  bitsLeft() { return this.count * 8 - this.bit; }
  take(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((this.fifo[this.head] >> this.bit) & 1);
      if (++this.bit === 8) { this.bit = 0; this.head = (this.head + 1) & 15; this.count--; }
    }
    return v;
  }

  // The next frame from the FIFO, or null if it hasn't all arrived.
  parseFrame() {
    if (this.bitsLeft() < 4) return null;
    const e = this.take(4);
    if (e === 0) return { energy: 0 };
    if (e === 15) return { stop: true };
    if (this.bitsLeft() < 7) return null;
    const repeat = this.take(1), p = this.take(6);
    const f = { energy: ENERGY[e], pitch: PITCH[p], k: Int32Array.from(this.lastK) };
    if (repeat) return f;
    const n = p ? 10 : 4;
    if (this.bitsLeft() < K_BITS.slice(0, n).reduce((a, b) => a + b, 0)) return null;
    for (let i = 0; i < 10; i++) f.k[i] = i < n ? K[i][this.take(K_BITS[i])] : 0;
    this.lastK.set(f.k);
    return f;
  }

  stop() {
    this.talking = false; this.external = false; this.stopping = false;
    this.count = 0; this.bit = 0; this.energy = 0; this.empty = true;
  }

  sample() {}             // the board clocks it at 8 kHz; `out` holds between clocks

  // ---------------------------------------------------------------- 8 kHz synthesis

  clock() {
    if (this.external && !this.talking && this.count >= 9) { this.talking = true; this.step = this.sub = 0; }
    if (!this.talking) { this.out = 0; return; }
    const t = this.target;
    if (this.sub === 0) {
      if (this.step === 0) {
        // A new frame: aim at it.
        if (this.stopping) { this.stop(); this.out = 0; return; }
        const f = this.parseFrame();
        if (!f) { this.stop(); this.out = 0; return; }
        if (f.stop) { this.stopping = true; t.energy = 0; }
        else if (!f.energy) t.energy = 0;
        else {
          t.energy = f.energy; t.k.set(f.k);
          // Voicing changes switch at once; within voiced speech the pitch glides.
          if (!f.pitch || !this.pitch) this.pitch = f.pitch;
          t.pitch = f.pitch;
          if (!f.pitch) for (let i = 4; i < 10; i++) this.k[i] = 0;
        }
      }
      const sh = INTERP_SHIFT[this.step];
      this.energy += (t.energy - this.energy) >> sh;
      if (this.pitch && t.pitch) this.pitch += (t.pitch - this.pitch) >> sh;
      for (let i = 0; i < 10; i++) this.k[i] += (t.k[i] - this.k[i]) >> sh;
    }
    // Excitation: silence, noise (unvoiced) or the chirp once per pitch period.
    let ex;
    if (!this.energy) ex = 0;
    else if (!this.pitch) ex = this.rng & 1 ? -64 : 64;
    else ex = this.pitchCount < CHIRP.length ? CHIRP[this.pitchCount] : 0;
    const fb = ((this.rng >> 12) ^ (this.rng >> 10) ^ (this.rng >> 9) ^ this.rng) & 1;
    this.rng = (this.rng >> 1) | (fb << 12);
    // The lattice filter.
    const u = this.u, x = this.x, k = this.k;
    u[10] = (ex * this.prevEnergy) >> 8;
    for (let i = 9; i >= 0; i--) {
      u[i] = u[i + 1] - Math.trunc((k[i] * x[i]) / 32768);
      if (i < 9) x[i + 1] = x[i] + Math.trunc((k[i] * u[i]) / 32768);
    }
    x[0] = u[0];
    this.prevEnergy = this.energy;
    let s = u[0];
    if (s > 2047) s = -2048 + (s - 2047); else if (s < -2048) s = 2047 - (s + 2048);
    s = Math.max(-512, Math.min(511, s));
    this.out = (s / 512) * this.gain;
    // Counters.
    this.pitchCount = this.pitch ? (this.pitchCount + 1) % this.pitch : 0;
    if (++this.sub === 25) { this.sub = 0; this.step = (this.step + 1) & 7; }
  }
}
