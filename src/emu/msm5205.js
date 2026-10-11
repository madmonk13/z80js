// OKI MSM5205 ADPCM speech/sample decoder. Each clock it takes a 4-bit (or
// 3-bit) code and steps a 12-bit output up or down by an amount that adapts
// to the signal: the step size comes from a table of 49 values growing by
// 10% each, and big codes move up the table, small ones down.
//
// The board feeds it codes (data()) and clocks it (clock()); reset() holds it
// silent. Mixed by the board: sample() leaves the output in `out`.

import { capture, apply } from './state.js';

const STEPS = Int32Array.from({ length: 49 }, (_, i) => Math.floor(16 * Math.pow(1.1, i)));
const INDEX_SHIFT = [-1, -1, -1, -1, 2, 4, 6, 8];
const STATE = ['signal', 'index', 'code', 'held', 'bits', 'out'];

export class MSM5205 {
  constructor(gain = 1) { this.gain = gain; this.reset(); }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.signal = 0; this.index = 0; this.code = 0;
    this.held = true;       // the reset pin
    this.bits = 4;
    this.out = 0;
  }

  data(v) { this.code = v & 15; }
  hold(on) { this.held = !!on; if (this.held) { this.signal = 0; this.index = 0; } }

  // One sample clock: decode the latched code.
  clock() {
    if (this.held) { this.signal = 0; this.index = 0; return; }
    const n = this.bits === 3 ? (this.code << 1) & 15 : this.code;
    const step = STEPS[this.index];
    let diff = step >> 3;
    if (n & 4) diff += step;
    if (n & 2) diff += step >> 1;
    if (n & 1) diff += step >> 2;
    this.signal += n & 8 ? -diff : diff;
    if (this.signal > 2047) this.signal = 2047; else if (this.signal < -2048) this.signal = -2048;
    this.index = Math.min(48, Math.max(0, this.index + INDEX_SHIFT[n & 7]));
  }

  sample() { this.out = (this.signal / 2048) * this.gain; }
}
