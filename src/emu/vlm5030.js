// Sanyo VLM5030 speech synthesizer (Konami: Yie Ar Kung-Fu, Track & Field,
// Hyper Sports, Jail Break). Like TI's speech chips it runs LPC speech through
// a 10-stage lattice filter, but it reads its own speech ROM: the host latches
// a phrase number, pulses ST, and the chip looks the phrase's start address up
// in a table at the bottom of the ROM.
//
// Data, read LSB first from the ROM:
//   xxxxxx11            end of phrase
//   xxxxSS01            2, 4, 6 or 8 silent frames
//   six bytes           a speech frame: a 0 bit, pitch (5), energy (5),
//                       K10-K5 (3 bits each), K4-K3 (4), K2 (5), K1 (6)
// A frame is four interpolation steps of 40 samples (at the normal speed) at
// clock / 440, about 8.1 kHz. Pitch 0 means unvoiced (noise).
//
// Pins: RST high then low latches the parameter byte (bit rate, speed,
// pitch shift); ST high then low starts the phrase in the data latch; BSY
// reads high while it talks.

import { capture, apply } from './state.js';
import { RATE } from './mixer.js';

const FR = 4;                                        // interpolation steps a frame
// The chip's lookup tables.
const ENERGY = [0, 2, 4, 6, 10, 12, 14, 18, 22, 26, 30, 34, 38, 44, 48, 54,
  62, 68, 76, 84, 94, 102, 114, 124, 136, 150, 164, 178, 196, 214, 232, 254];
const PITCH = [1, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 34, 36, 38, 40, 42, 44, 46,
  50, 54, 58, 62, 66, 70, 74, 78, 86, 94, 102, 110, 118, 126];
const K1 = [-24898, -25672, -26446, -27091, -27736, -28252, -28768, -29155, -29542, -29929, -30316, -30574, -30832, -30961, -31219, -31348,
  -31606, -31735, -31864, -31864, -31993, -32122, -32122, -32251, -32251, -32380, -32380, -32380, -32509, -32509, -32509, -32509,
  24898, 23995, 22963, 21931, 20770, 19480, 18061, 16642, 15093, 13416, 11610, 9804, 7998, 6063, 3999, 1935,
  0, -1935, -3999, -6063, -7998, -9804, -11610, -13416, -15093, -16642, -18061, -19480, -20770, -21931, -22963, -23995];
const K2 = [0, -3096, -6321, -9417, -12513, -15351, -18061, -20770, -23092, -25285, -27220, -28897, -30187, -31348, -32122, -32638,
  0, 32638, 32122, 31348, 30187, 28897, 27220, 25285, 23092, 20770, 18061, 15351, 12513, 9417, 6321, 3096];
const K3 = [0, -3999, -8127, -12255, -16384, -20383, -24511, -28639, 32638, 28639, 24511, 20383, 16254, 12255, 8127, 3999];
const K5 = [0, -8127, -16384, -24511, 32638, 24511, 16254, 8127];
// Samples per interpolation step for each speed setting (parameter bits 3-5).
const SPEED = [40, 30, 20, 20, 40, 60, 50, 50];

const IDLE = 0, SETUP = 1, WAIT = 2, RUN = 3, STOP = 4, END = 5;

const STATE = ['latch', 'st', 'rst', 'busy', 'phase', 'address', 'param', 'interpCount', 'sampleCount', 'pitchCount',
  'oldE', 'oldP', 'oldK', 'newE', 'newP', 'newK', 'tgtE', 'tgtP', 'tgtK', 'curE', 'curP', 'curK', 'x', 'rng', 'acc', 'out'];

export class VLM5030 {
  constructor(clock, rom, gain = 1) {
    this.rate = clock / 440;
    this.rom = rom;
    this.mask = rom.length - 1;
    this.gain = gain;
    this.u = new Int32Array(10);           // filter scratch
    this.reset();
  }

  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.setParam(this.param); }

  reset() {
    this.latch = 0; this.st = 0; this.rst = 0;
    this.rng = 1; this.acc = 0;
    this.clear();
    this.phase = IDLE;
  }

  clear() {
    this.busy = 0; this.phase = IDLE; this.address = 0;
    this.oldE = this.oldP = this.newE = this.newP = this.tgtE = this.tgtP = this.curE = this.curP = 0;
    this.oldK = new Int32Array(10); this.newK = new Int32Array(10); this.tgtK = new Int32Array(10); this.curK = new Int32Array(10);
    this.x = new Int32Array(10);
    this.interpCount = this.sampleCount = this.pitchCount = 0;
    this.out = 0;
    this.setParam(0);
  }

  // Bits 0-1: bit rate (how many interpolation steps a frame advances by), 3-5: speed, 6-7: pitch shift.
  setParam(p) {
    this.param = p;
    this.interpStep = p & 2 ? 4 : p & 1 ? 2 : 1;
    this.frameSize = SPEED[(p >> 3) & 7];
    this.pitchOffset = p & 0x80 ? -8 : p & 0x40 ? 8 : 0;
  }

  // ---------------------------------------------------------------- host side

  write(v) { this.latch = v; }

  setRst(pin) {
    pin = pin ? 1 : 0;
    if (pin === this.rst) return;
    this.rst = pin;
    if (pin) { if (this.busy) this.clear(); }
    else this.setParam(this.latch);
  }

  setSt(pin) {
    pin = pin ? 1 : 0;
    if (pin === this.st) return;
    this.st = pin;
    if (pin) {
      // Busy goes up at once; the phrase starts when ST drops.
      this.phase = SETUP; this.sampleCount = 1; this.busy = 1;
      return;
    }
    const table = (this.latch & 0xFE) | ((this.latch & 1) << 8);
    this.address = (this.rom[table & this.mask] << 8) | this.rom[(table + 1) & this.mask];
    this.sampleCount = this.frameSize;
    this.interpCount = FR;               // one frame of what came before, then the phrase
    this.phase = RUN;
  }

  // ---------------------------------------------------------------- synthesis

  bits(start, n) {
    const o = this.address + (start >> 3);
    const v = this.rom[o & this.mask] | (this.rom[(o + 1) & this.mask] << 8);
    return (v >> (start & 7)) & ((1 << n) - 1);
  }

  // Read the next frame into new*; returns its length in interpolation steps (0 at the end).
  nextFrame() {
    this.oldE = this.newE; this.oldP = this.newP; this.oldK.set(this.newK);
    const cmd = this.rom[this.address & this.mask];
    if (cmd & 1) {
      this.newE = this.newP = 0; this.newK.fill(0);
      this.address++;
      return cmd & 2 ? 0 : ((cmd >> 2) + 1) * 2 * FR;
    }
    this.newP = (PITCH[this.bits(1, 5)] + this.pitchOffset) & 0xFF;
    this.newE = ENERGY[this.bits(6, 5)];
    for (let i = 0; i < 6; i++) this.newK[9 - i] = K5[this.bits(11 + i * 3, 3)];
    this.newK[3] = K3[this.bits(29, 4)];
    this.newK[2] = K3[this.bits(33, 4)];
    this.newK[1] = K2[this.bits(37, 5)];
    this.newK[0] = K1[this.bits(42, 6)];
    this.address += 6;
    return FR;
  }

  // Start of an interpolation step: fetch a frame if one is due, then move a step toward it.
  interpolate() {
    if (this.interpCount === 0) {
      this.interpCount = this.nextFrame();
      if (this.interpCount === 0) { this.interpCount = FR; this.phase = STOP; }
      // A frame that follows silence starts at once rather than fading in.
      if (this.oldE === 0) { this.tgtE = 0; this.tgtP = this.oldP; this.tgtK.set(this.oldK); }
      else { this.tgtE = this.newE; this.tgtP = this.newP; this.tgtK.set(this.newK); }
    }
    this.interpCount -= this.interpStep;
    const f = FR - (this.interpCount % FR);
    this.curE = this.oldE + Math.trunc((this.tgtE - this.oldE) * f / FR);
    if (this.oldP > 1) this.curP = this.oldP + Math.trunc((this.tgtP - this.oldP) * f / FR);
    for (let i = 0; i < 10; i++) this.curK[i] = this.oldK[i] + Math.trunc((this.tgtK[i] - this.oldK[i]) * f / FR);
  }

  clock() {
    if (this.phase === RUN || this.phase === STOP) {
      if (this.sampleCount === 0) {
        if (this.phase === STOP) { this.phase = END; this.sampleCount = 1; this.out = 0; return; }
        this.sampleCount = this.frameSize;
        this.interpolate();
      }
      // Excitation: silence, noise (unvoiced) or one pulse a pitch period.
      let ex;
      if (this.oldE === 0) ex = 0;
      else if (this.oldP <= 1) {
        ex = this.rng & 1 ? this.curE : -this.curE;
        this.rng = (this.rng >> 1) | ((((this.rng >> 0) ^ (this.rng >> 1)) & 1) << 14);
      } else ex = this.pitchCount === 0 ? this.curE : 0;
      // The lattice filter.
      const k = this.curK, x = this.x;
      let u = ex;
      const us = this.u;
      for (let i = 9; i >= 0; i--) { u -= Math.trunc((k[i] * x[i]) / 32768); us[i] = u; }
      for (let i = 9; i >= 1; i--) x[i] = x[i - 1] + Math.trunc((k[i - 1] * us[i - 1]) / 32768);
      x[0] = us[0];
      const s = Math.max(-511, Math.min(511, us[0]));
      this.out = (s / 512) * this.gain;
      this.sampleCount--;
      if (++this.pitchCount >= this.curP) this.pitchCount = 0;
      return;
    }
    this.out = 0;
    if (this.phase === SETUP) { if (--this.sampleCount <= 0) { this.sampleCount = 0; this.phase = WAIT; } }
    else if (this.phase === END) { if (--this.sampleCount <= 0) { this.sampleCount = 0; this.busy = 0; this.phase = IDLE; } }
  }

  // Called RATE times a second; the chip runs at its own ~8 kHz and `out` holds between its samples.
  sample() {
    this.acc += this.rate / RATE;
    while (this.acc >= 1) { this.acc -= 1; this.clock(); }
  }
}
