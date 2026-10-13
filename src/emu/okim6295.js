// OKI MSM6295: four voices playing 4-bit ADPCM samples from a 256K ROM.
// The first 1K of the ROM is a table of up to 128 phrases (start and end
// addresses, 3 bytes each, in 8-byte entries).
//
// Commands: a byte with bit 7 set picks a phrase; the next byte's top four
// bits pick the voice(s) to play it on and its low four the attenuation (3 dB
// a step). A byte with bit 7 clear stops the voices in bits 3-6. Reading
// gives a bit per voice that is playing. The sample rate is the clock / 132
// (pin 7 high) or / 165.
//
// Mixed by the board (see mixer.js): sample() is called RATE times a second.

import { capture, apply } from './state.js';
import { RATE } from './mixer.js';

const SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8];
// The decoder's step sizes (16 x 1.1^n) and per-nibble differences.
const DIFF = new Int16Array(49 * 16);
for (let step = 0; step <= 48; step++) {
  const sv = Math.floor(16 * Math.pow(1.1, step));
  for (let nib = 0; nib < 16; nib++) {
    const mag = (nib & 4 ? sv : 0) + (nib & 2 ? sv >> 1 : 0) + (nib & 1 ? sv >> 2 : 0) + (sv >> 3);
    DIFF[step * 16 + nib] = nib & 8 ? -mag : mag;
  }
}
const VOLUME = Float32Array.from({ length: 16 }, (_, i) => (i > 8 ? 0 : Math.pow(10, (-3 * i) / 20)));

const STATE = ['pending', 'playing', 'pos', 'end', 'signal', 'step', 'vol', 'pin7', 'acc', 'held', 'bank'];

export class OKIM6295 {
  constructor(clock, rom, gain = 1) {
    this.clock = clock;
    this.rom = rom;
    this.gain = gain;
    this.reset();
  }

  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.pending = -1;
    this.playing = new Uint8Array(4);
    this.pos = new Int32Array(4);              // in nibbles
    this.end = new Int32Array(4);
    this.signal = new Int16Array(4);
    this.step = new Uint8Array(4);
    this.vol = new Float32Array(4);
    this.pin7 = 1;
    this.bank = 0;                             // byte offset added to all addresses (boards with banked sample ROM)
    this.acc = 0;
    this.held = 0;
    this.out = 0;
  }

  rd(a) { return this.rom[(this.bank + a) % this.rom.length] | 0; }

  read() { return 0xF0 | this.playing[0] | (this.playing[1] << 1) | (this.playing[2] << 2) | (this.playing[3] << 3); }

  write(v) {
    if (this.pending >= 0) {
      const t = this.pending * 8;
      const start = ((this.rd(t) << 16) | (this.rd(t + 1) << 8) | this.rd(t + 2)) & 0x3FFFF;
      const stop = ((this.rd(t + 3) << 16) | (this.rd(t + 4) << 8) | this.rd(t + 5)) & 0x3FFFF;
      for (let i = 0; i < 4; i++) {
        if (!((v >> (4 + i)) & 1) || this.playing[i] || start >= stop) continue;
        this.playing[i] = 1;
        this.pos[i] = start * 2; this.end[i] = (stop + 1) * 2;
        this.signal[i] = -2; this.step[i] = 0;
        this.vol[i] = VOLUME[v & 15];
      }
      this.pending = -1;
      return;
    }
    if (v & 0x80) { this.pending = v & 0x7F; return; }
    for (let i = 0; i < 4; i++) if ((v >> (3 + i)) & 1) this.playing[i] = 0;
  }

  // One output sample of the chip's own rate.
  tick() {
    let s = 0;
    for (let i = 0; i < 4; i++) {
      if (!this.playing[i]) continue;
      const p = this.pos[i], b = this.rd(p >> 1), nib = p & 1 ? b & 15 : b >> 4;
      let sig = this.signal[i] + DIFF[this.step[i] * 16 + nib];
      sig = sig > 2047 ? 2047 : sig < -2048 ? -2048 : sig;
      this.signal[i] = sig;
      const st = this.step[i] + SHIFT[nib & 7];
      this.step[i] = st < 0 ? 0 : st > 48 ? 48 : st;
      s += sig * this.vol[i];
      if (++this.pos[i] >= this.end[i]) this.playing[i] = 0;
    }
    this.held = s / 2048;
  }

  sample() {
    this.acc += this.clock / (this.pin7 ? 132 : 165) / RATE;
    while (this.acc >= 1) { this.acc -= 1; this.tick(); }
    this.out = this.held * this.gain;
  }
}
