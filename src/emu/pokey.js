// Atari POKEY (C012294): four audio channels, each a frequency divider whose
// output is shaped by polynomial counters ("distortion") and a 4-bit volume;
// plus a random-number register. Used by Centipede, Millipede, Missile
// Command and Atari's home computers.
//
// Registers (write): 0/2/4/6 AUDF1-4 divider, 1/3/5/7 AUDC1-4 (bits 7-5
// distortion, bit 4 volume-only, bits 3-0 volume), 8 AUDCTL, 9 STIMER, F SKCTL.
// Read: A RANDOM (the 17- or 9-bit polynomial counter), others idle.
//
// AUDCTL: 01 15 kHz base clock (else 64 kHz), 02/04 high-pass channel 2/1
// (by 4/3), 08 join 3+4, 10 join 1+2, 20 channel 3 at the full clock,
// 40 channel 1 at the full clock, 80 9-bit polynomial instead of 17-bit.

import { capture, apply } from './state.js';
import { RATE } from './mixer.js';

// Polynomial counter output sequences, one bit per clock.
function poly(bits, taps) {
  const len = (1 << bits) - 1, out = new Uint8Array(len);
  let r = 1;
  for (let i = 0; i < len; i++) {
    out[i] = r & 1;
    const fb = taps.reduce((x, t) => x ^ ((r >> t) & 1), 0);
    r = (r >> 1) | (fb << (bits - 1));
  }
  return out;
}
const POLY4 = poly(4, [0, 1]), POLY5 = poly(5, [0, 2]), POLY9 = poly(9, [0, 4]), POLY17 = poly(17, [0, 5]);

const STATE = ['audf', 'audc', 'audctl', 'count', 'out', 'hp', 'clock', 'acc', 'dcIn', 'dcOut'];

export class Pokey {
  constructor(clock, gain = 1) {
    this.baseClock = clock;
    this.gain = gain;
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.audf = new Uint8Array(4); this.audc = new Uint8Array(4); this.audctl = 0;
    this.count = new Float64Array(4);          // clocks until each divider's next pulse
    this.out = new Uint8Array(4); this.hp = new Uint8Array(2);
    this.clock = 0;                            // running clock count (indexes the polynomials)
    this.acc = 0; this.dcIn = this.dcOut = 0;
    this.writePos = this.readPos = 0;
  }

  write(r, v) {
    r &= 15;
    if (r < 8) { if (r & 1) this.audc[r >> 1] = v; else this.audf[r >> 1] = v; }
    else if (r === 8) this.audctl = v;
    else if (r === 9) for (let c = 0; c < 4; c++) this.count[c] = this.period(c);   // STIMER restarts the dividers
  }

  read(r) {
    if ((r & 15) === 10) {                       // RANDOM: 8 bits of the current polynomial
      const p = this.audctl & 0x80 ? POLY9 : POLY17;
      let v = 0;
      for (let i = 0; i < 8; i++) v |= p[(this.clock + i) % p.length] << i;
      return v;
    }
    return 0xFF;
  }

  // Clocks between pulses of channel c.
  period(c) {
    const ctl = this.audctl, base = ctl & 1 ? 114 : 28;
    if (c === 1 && (ctl & 0x10)) {               // 1+2 joined: 16-bit
      const f = this.audf[0] | (this.audf[1] << 8);
      return ctl & 0x40 ? f + 7 : (f + 1) * base;
    }
    if (c === 3 && (ctl & 0x08)) {               // 3+4 joined
      const f = this.audf[2] | (this.audf[3] << 8);
      return ctl & 0x20 ? f + 7 : (f + 1) * base;
    }
    if (c === 0 && (ctl & 0x40)) return this.audf[0] + 4;
    if (c === 2 && (ctl & 0x20)) return this.audf[2] + 4;
    return (this.audf[c] + 1) * base;
  }

  // A divider pulse on channel c: update its output per the distortion.
  pulse(c, at) {
    const ctl = this.audc[c];
    if (!(ctl & 0x80) && !POLY5[at % POLY5.length]) return;    // 5-bit polynomial gates the pulses
    if (ctl & 0x20) this.out[c] ^= 1;                            // pure tone
    else if (ctl & 0x40) this.out[c] = POLY4[at % POLY4.length];
    else { const p = this.audctl & 0x80 ? POLY9 : POLY17; this.out[c] = p[at % p.length]; }
    // High-pass: channels 3 and 4 clock flip-flops that channels 1 and 2 are XORed with.
    if (c === 2) this.hp[0] = this.out[0];
    if (c === 3) this.hp[1] = this.out[1];
  }

  sample() {
    const clocks = this.baseClock / RATE;
    const end = this.clock + clocks;
    for (let c = 0; c < 4; c++) {
      const p = this.period(c);
      let t = this.clock;
      while (t + this.count[c] <= end) {
        t += this.count[c];
        this.count[c] = p;
        this.pulse(c, Math.floor(t));
      }
      this.count[c] -= end - t;
    }
    this.clock = end;
    if (this.clock > 1e12) this.clock -= 1e12;

    let s = 0;
    for (let c = 0; c < 4; c++) {
      if ((c === 0 && (this.audctl & 0x10)) || (c === 2 && (this.audctl & 0x08))) continue;   // low half of a joined pair is silent
      const ctl = this.audc[c], vol = ctl & 15;
      if (!vol) continue;
      let bit = ctl & 0x10 ? 1 : this.out[c];
      if (c === 0 && (this.audctl & 0x04)) bit ^= this.hp[0];
      if (c === 1 && (this.audctl & 0x02)) bit ^= this.hp[1];
      s += bit * vol;
    }
    s = (s / 60) * this.gain;
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
