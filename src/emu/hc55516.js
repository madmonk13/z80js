// Harris HC-55516 CVSD (continuously variable slope delta) speech decoder.
// Each clock takes one bit: 1 steps the output up, 0 down. Three equal bits
// in a row widen the step (the "slope" charges), mixed bits let it shrink,
// and the output slowly leaks toward zero. Sinistar's voice comes through one.
//
// The board sets the data bit (digit()) and toggles the clock (clock()).
// Mixed by the board: sample() leaves the output in `out`.

import { capture, apply } from './state.js';

const RATE_REF = 16000;                     // time constants are in seconds at this bit rate
const LEAK = Math.exp(-1 / (0.001 * RATE_REF));
const DECAY = Math.exp(-1 / (0.004 * RATE_REF));
const CHARGE = Math.exp(-1 / (0.004 * RATE_REF));
const STEP_MIN = 0.0416, STEP_MAX = 1.0954, GAIN = 10000;
const STATE = ['bit', 'lastClock', 'history', 'step', 'integrator', 'value', 'idle'];

export class HC55516 {
  constructor(gain = 1) { this.gain = gain; this.reset(); }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.bit = 0; this.lastClock = 0; this.history = 0;
    this.step = 0; this.integrator = 0; this.value = 0; this.idle = 0;
    this.out = 0;
  }

  digit(v) { this.bit = v & 1; }

  // Rising clock edges decode a bit.
  clock(v) {
    v &= 1;
    const rising = v && !this.lastClock;
    this.lastClock = v;
    if (!rising) return;
    this.idle = 0;
    this.history = ((this.history << 1) | this.bit) & 7;
    this.integrator += this.bit ? this.step : -this.step;
    this.integrator *= LEAK;
    if (this.history === 0 || this.history === 7) this.step = Math.min(STEP_MAX, STEP_MAX - (STEP_MAX - this.step) * CHARGE);
    else this.step = Math.max(STEP_MIN, this.step * DECAY);
    // Soft-limit into a 16-bit range, as the output stage does.
    const t = this.integrator * GAIN;
    this.value = t / (Math.abs(t) / 32768 + 1);
  }

  sample() {
    // Silence when the clock stops for a while.
    if (++this.idle > 48000 / 32) this.value = 0;
    this.out = (this.value / 32768) * this.gain;
  }
}
