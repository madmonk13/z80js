// Several sound chips on one board, mixed into one sample source. The board
// calls sample() RATE times a second; each chip's sample() leaves its output
// in `out`, and the sum (times `gain`, through a DC blocker, since these
// chips only ever output positive levels) goes into a ring buffer for the
// audio output.

export const RATE = 48000;

export class SoundMix {
  constructor(chips, gain = 1) {
    this.chips = chips;
    this.gain = gain;
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }

  saveState() { return { chips: this.chips.map((c) => c.saveState()), dc: [this.dcIn, this.dcOut] }; }
  loadState(s) {
    this.chips.forEach((c, i) => c.loadState(s.chips[i]));
    if (s.dc) [this.dcIn, this.dcOut] = s.dc;
  }

  reset() {
    for (const c of this.chips) c.reset();
    this.writePos = this.readPos = 0;
    this.dcIn = this.dcOut = 0;
  }

  sample() {
    let s = 0;
    for (const c of this.chips) { c.sample(); s += c.out; }
    s *= this.gain;
    const out = s - this.dcIn + 0.995 * this.dcOut;
    this.dcIn = s; this.dcOut = out;
    const mask = this.buffer.length - 1;
    this.buffer[this.writePos] = out;
    this.writePos = (this.writePos + 1) & mask;
    if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
  }

  available() { return (this.writePos - this.readPos) & (this.buffer.length - 1); }

  // Fallback path (ScriptProcessor): resample into `out` at `outRate`.
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
