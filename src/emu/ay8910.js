// General Instrument AY-3-8910 programmable sound generator: three square-wave
// tone channels, one noise generator, a mixer, 4-bit logarithmic volumes or an
// envelope per channel, and two 8-bit I/O ports. Used across many arcade
// boards (Frogger, Scramble and their relatives) and home computers.
//
// Registers:
//   0-5   tone periods A, B, C (12 bits, fine/coarse)
//   6     noise period (5 bits)
//   7     mixer: bits 0-2 tone off, bits 3-5 noise off (per channel), 6-7 port directions
//   8-10  amplitude A, B, C (4 bits; bit 4 = use the envelope)
//   11-12 envelope period (16 bits), 13 envelope shape
//   14-15 I/O ports A, B
// The chip counts at clock/8: a tone's output flips every TP counts (so
// fT = clock / 16TP), the noise register shifts every 2NP counts, and the
// envelope steps every 2EP counts (a 16-step cycle lasts 256EP clocks).
//
// Output goes into a ring buffer at RATE: the board calls sample() 48,000
// times a second.

import { capture, apply } from './state.js';

export const RATE = 48000;

// Output level for each 4-bit volume, roughly 3 dB a step, following
// measurements of real chips (louder at the bottom than a pure 3 dB curve).
const LEVEL = Float32Array.from([0, 0.0105, 0.0152, 0.0221, 0.0321, 0.0468, 0.0644, 0.1069,
  0.1316, 0.2167, 0.2950, 0.3770, 0.4900, 0.6062, 0.7714, 1]);
const STATE = ['regs', 'addr', 'toneCount', 'toneOut', 'noiseCount', 'noise', 'envCount', 'envStep', 'envHold', 'envAttack', 'envAlt', 'envCont', 'envHoldBit', 'acc', 'enabled', 'dcIn', 'dcOut', 'filterK', 'lp', 'volume'];

export class AY8910 {
  // clock: input clock in Hz; portIn(n) -> byte for ports A (0) and B (1);
  // gain: the board's amplification (games often run the chip quietly).
  constructor(clock, portIn = () => 0xFF, gain = 1) {
    this.clock = clock;
    this.gain = gain;
    this.portIn = portIn;
    this.portOut = null;          // portOut(n, value): writes to the I/O ports, if the board uses them
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }

  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.regs = new Uint8Array(16);
    this.addr = 0;
    this.toneCount = new Uint16Array(3);
    this.toneOut = new Uint8Array(3);
    this.noiseCount = 0;
    this.noise = 1;
    this.envCount = 0; this.envStep = 0; this.envHold = false;
    this.envAttack = 0; this.envAlt = 0; this.envCont = 0; this.envHoldBit = 0;
    this.dcIn = 0; this.dcOut = 0;
    this.acc = 0;                 // fraction of a clock/16 tick carried between samples
    this.enabled = true;          // board-level mute
    this.filterK = [1, 1, 1];     // per-channel low-pass coefficient (1 = no filter)
    this.lp = [0, 0, 0];
    this.volume = [1, 1, 1];      // per-channel level set by the board (some boards gate the outputs)
    this.writePos = this.readPos = 0;
  }

  // Bus interface: latch a register number, then read or write it.
  select(n) { this.addr = n & 0x0F; }
  read() {
    if (this.addr === 14) return this.portIn(0);
    if (this.addr === 15) return this.portIn(1);
    return this.regs[this.addr];
  }
  write(v) {
    const r = this.addr;
    const MASK = [0xFF, 0x0F, 0xFF, 0x0F, 0xFF, 0x0F, 0x1F, 0xFF, 0x1F, 0x1F, 0x1F, 0xFF, 0xFF, 0x0F, 0xFF, 0xFF];
    this.regs[r] = v & MASK[r];
    if (r >= 14 && this.portOut) this.portOut(r - 14, v);
    if (r === 13) {
      // New envelope shape: restart it. Bits: continue, attack, alternate, hold.
      const s = this.regs[13];
      this.envCont = (s >> 3) & 1;
      this.envAttack = (s >> 2) & 1 ? 0x0F : 0;
      this.envAlt = (s >> 1) & 1;
      this.envHoldBit = s & 1;
      this.envStep = 0x0F;
      this.envHold = false;
      this.envCount = 0;
    }
  }

  // Some boards put a switchable RC low-pass on each channel's output: set
  // channel `ch`'s time constant in seconds (0 for none).
  setFilter(ch, tau) { this.filterK[ch] = tau > 0 ? 1 - Math.exp(-1 / (tau * RATE)) : 1; }

  tonePeriod(ch) { return (this.regs[ch * 2] | (this.regs[ch * 2 + 1] << 8)) || 1; }

  // Advance one clock/8 count.
  tick() {
    for (let ch = 0; ch < 3; ch++) {
      if (++this.toneCount[ch] >= this.tonePeriod(ch)) { this.toneCount[ch] = 0; this.toneOut[ch] ^= 1; }
    }
    // Noise steps at half the tone rate.
    if (++this.noiseCount >= (this.regs[6] || 1) * 2) {
      this.noiseCount = 0;
      const bit = (this.noise ^ (this.noise >> 3)) & 1;
      this.noise = (this.noise >> 1) | (bit << 16);
    }
    const envPeriod = (this.regs[11] | (this.regs[12] << 8)) || 1;
    if (++this.envCount >= envPeriod * 2) {
      this.envCount = 0;
      if (!this.envHold) {
        if (this.envStep > 0) this.envStep--;
        else if (!this.envCont) { this.envHold = true; this.envAttack = 0; this.envStep = 0; }
        else if (this.envHoldBit) { this.envHold = true; if (this.envAlt) this.envAttack ^= 0x0F; }
        else { if (this.envAlt) this.envAttack ^= 0x0F; this.envStep = 0x0F; }
      }
    }
  }

  envLevel() { return (this.envStep ^ this.envAttack) & 0x0F; }

  // The registers can't change during one sample, so read them once and run the
  // clock/8 counts (tick()'s work, inlined) with them in locals.
  sample() {
    this.acc += this.clock / 8 / RATE;
    let a = 0, b = 0, c = 0, n = 0;
    if (this.acc >= 1) {
      const regs = this.regs, tc = this.toneCount, to = this.toneOut, vol = this.volume;
      const p0 = (regs[0] | (regs[1] << 8)) || 1, p1 = (regs[2] | (regs[3] << 8)) || 1, p2 = (regs[4] | (regs[5] << 8)) || 1;
      const noisePer = (regs[6] || 1) * 2, envPer = ((regs[11] | (regs[12] << 8)) || 1) * 2;
      // A channel sounds when its enabled sources (tone and/or noise) are high; with both disabled it's held high.
      const mix = regs[7], t0 = !(mix & 1), t1 = !(mix & 2), t2 = !(mix & 4), n0 = !(mix & 8), n1 = !(mix & 16), n2 = !(mix & 32);
      const amp0 = regs[8], amp1 = regs[9], amp2 = regs[10], v0 = vol[0], v1 = vol[1], v2 = vol[2];
      while (this.acc >= 1) {
        this.acc -= 1;
        if (++tc[0] >= p0) { tc[0] = 0; to[0] ^= 1; }
        if (++tc[1] >= p1) { tc[1] = 0; to[1] ^= 1; }
        if (++tc[2] >= p2) { tc[2] = 0; to[2] ^= 1; }
        // Noise steps at half the tone rate.
        if (++this.noiseCount >= noisePer) {
          this.noiseCount = 0;
          const bit = (this.noise ^ (this.noise >> 3)) & 1;
          this.noise = (this.noise >> 1) | (bit << 16);
        }
        if (++this.envCount >= envPer) {
          this.envCount = 0;
          if (!this.envHold) {
            if (this.envStep > 0) this.envStep--;
            else if (!this.envCont) { this.envHold = true; this.envAttack = 0; this.envStep = 0; }
            else if (this.envHoldBit) { this.envHold = true; if (this.envAlt) this.envAttack ^= 0x0F; }
            else { if (this.envAlt) this.envAttack ^= 0x0F; this.envStep = 0x0F; }
          }
        }
        const noise = this.noise & 1, env = (this.envStep ^ this.envAttack) & 0x0F;
        if ((t0 ? to[0] : 1) & (n0 ? noise : 1)) a += LEVEL[amp0 & 0x10 ? env : amp0 & 0x0F] * v0;
        if ((t1 ? to[1] : 1) & (n1 ? noise : 1)) b += LEVEL[amp1 & 0x10 ? env : amp1 & 0x0F] * v1;
        if ((t2 ? to[2] : 1) & (n2 ? noise : 1)) c += LEVEL[amp2 & 0x10 ? env : amp2 & 0x0F] * v2;
        n++;
      }
    }
    // Each channel through its filter (if any), then the three mixed.
    const lp = this.lp, k = this.filterK;
    if (n) { lp[0] += (a / n - lp[0]) * k[0]; lp[1] += (b / n - lp[1]) * k[1]; lp[2] += (c / n - lp[2]) * k[2]; }
    // The chip's output never goes below zero; a DC blocker centers it.
    const raw = this.enabled ? ((lp[0] + lp[1] + lp[2]) / 3) * this.gain : 0;
    const out = raw - this.dcIn + 0.995 * this.dcOut;
    this.dcIn = raw; this.dcOut = out;
    this.out = out;
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

