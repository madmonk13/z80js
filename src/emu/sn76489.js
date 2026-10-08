// Texas Instruments SN76489 sound generator: three square-wave tone channels
// and a noise channel, each with a 4-bit attenuator (2 dB a step, 15 = off).
// Written one byte at a time: a byte with bit 7 set latches a register
// (bits 4-6) and sets its low 4 bits; a byte with bit 7 clear sets the high
// 6 bits of a latched tone period.
//
// Registers: 0/2/4 tone periods (10 bits), 1/3/5/7 attenuations, 6 noise
// control (bits 0-1 rate: clock/512, /1024, /2048 or tone 2's rate; bit 2
// white noise rather than periodic). Counters run at clock/16.
//
// Mixed by the board (see mixer.js): sample() is called RATE times a second
// and leaves the chip's output in `out`.

import { capture, apply } from './state.js';
import { RATE } from './mixer.js';

const LEVEL = Float32Array.from({ length: 16 }, (_, i) => (i === 15 ? 0 : Math.pow(10, (-2 * i) / 20)));
const STATE = ['regs', 'latched', 'count', 'output', 'noise', 'acc'];

export class SN76489 {
  constructor(clock) {
    this.clock = clock;
    this.reset();
  }

  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.regs = new Uint16Array(8);
    this.regs[1] = this.regs[3] = this.regs[5] = this.regs[7] = 0x0F;   // silent
    this.latched = 0;
    this.count = new Uint16Array(4);
    this.output = new Uint8Array(4);
    this.noise = 0x4000;
    this.acc = 0;
    this.out = 0;
  }

  write(v) {
    if (v & 0x80) {
      const r = (v >> 4) & 7;
      this.latched = r;
      this.regs[r] = (this.regs[r] & 0x3F0) | (v & 0x0F);
    } else if (!(this.latched & 1) && this.latched < 6) {
      this.regs[this.latched] = (this.regs[this.latched] & 0x0F) | ((v & 0x3F) << 4);
    } else {
      this.regs[this.latched] = v & 0x0F;
    }
    if (this.latched === 6) this.noise = 0x4000;   // a noise write restarts the shift register
  }

  noisePeriod() {
    const rate = this.regs[6] & 3;
    return rate === 3 ? (this.regs[4] || 1) * 2 : 32 << rate;
  }

  // Advance one clock/16 tick.
  tick() {
    for (let ch = 0; ch < 3; ch++) {
      if (++this.count[ch] >= (this.regs[ch * 2] || 1)) { this.count[ch] = 0; this.output[ch] ^= 1; }
    }
    if (++this.count[3] >= this.noisePeriod()) {
      this.count[3] = 0;
      // 15-bit shift register; white noise feeds back bits 0 and 1, periodic just bit 0.
      const fb = (this.regs[6] & 4) ? (this.noise ^ (this.noise >> 1)) & 1 : this.noise & 1;
      this.noise = (this.noise >> 1) | (fb << 14);
      this.output[3] = this.noise & 1;
    }
  }

  sample() {
    this.acc += this.clock / 16 / RATE;
    let s = 0, n = 0;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.tick();
      for (let ch = 0; ch < 4; ch++) if (this.output[ch]) s += LEVEL[this.regs[ch * 2 + 1]];
      n++;
    }
    this.out = n ? s / n / 4 : this.out;
  }
}
