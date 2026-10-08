// Donkey Kong's sound: the 8035's 8-bit DAC (music and most effects), plus
// three analog circuits triggered by the main CPU. The DAC output fades while
// the 8035 holds its "discharge" line (P2 bit 7) low. The analog circuits are
// modeled by character, not component by component:
//   walk  - a short blip each step: a 555 oscillator near 430 Hz, quickly gated off
//   jump  - a rising "boing"
//   stomp - a low boom (Donkey Kong landing, falling girders)
// Output goes into a ring buffer at RATE, like the other sound sources.

import { capture, apply } from './state.js';

export const RATE = 48000;
const FADE = Math.exp(-1 / (0.25 * RATE));    // DAC envelope time constant: 0.25 s

const EFFECTS = {
  walk: { length: 0.07 },
  jump: { length: 0.32 },
  stomp: { length: 0.45 },
};

const DKONG_SOUND_STATE = ['dac', 'env', 'discharge', 'inputs', 'active', 'noise', 'phase', 'lp', 'walkPhase'];

export class DKongSound {
  // Save states: everything that changes while running (not ROM-derived data).
  saveState() { return capture(this, DKONG_SOUND_STATE); }
  loadState(s) { apply(this, DKONG_SOUND_STATE, s); }

  constructor() {
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }

  reset() {
    this.writePos = this.readPos = 0;
    this.dac = 0x80;
    this.env = 1;
    this.discharge = false;
    this.inputs = [0, 0, 0];
    this.active = {};             // effect -> samples played so far
    this.noise = 0x1FFFF;
    this.phase = 0;
    this.lp = 0;
  }

  // The main CPU's sound lines (7D00 walk, 7D01 jump, 7D02 stomp) start an
  // effect on a rising edge.
  trigger(n, v) {
    const bit = v & 1;
    if (bit && !this.inputs[n]) this.active[['walk', 'jump', 'stomp'][n]] = 0;
    this.inputs[n] = bit;
  }

  nextNoise() {
    const bit = ((this.noise >> 16) ^ (this.noise >> 13)) & 1;
    this.noise = ((this.noise << 1) | bit) & 0x1FFFF;
    return bit ? 1 : -1;
  }

  effects() {
    let s = 0;
    for (const name of Object.keys(this.active)) {
      const n = this.active[name], len = EFFECTS[name].length * RATE;
      if (n >= len) { delete this.active[name]; continue; }
      const t = n / RATE, left = 1 - n / len;
      if (name === 'walk') {
        // Square wave with a slight downward bend, fast exponential decay.
        this.walkPhase = ((this.walkPhase || 0) + (430 - 60 * (n / len)) / RATE) % 1;
        s += (this.walkPhase < 0.5 ? 0.32 : -0.32) * Math.exp(-t / 0.022);
      } else if (name === 'jump') {
        this.phase += (250 + 700 * (n / len)) / RATE;
        s += ((this.phase % 1) < 0.5 ? 0.25 : -0.25) * left;
      } else {
        // Low-passed noise for the boom.
        this.lp += (this.nextNoise() - this.lp) * 0.02;
        s += this.lp * 1.6 * left * left;
      }
      this.active[name] = n + 1;
    }
    return s;
  }

  // One output sample; the board calls this three times per scanline (16 kHz
  // lines x 3 = 48 kHz), after each third of the 8035's cycles for that line.
  sample() {
    if (this.discharge) this.env *= FADE; else this.env = 1;
    const s = ((this.dac - 0x80) / 128) * this.env * 0.55 + this.effects();
    const mask = this.buffer.length - 1;
    this.buffer[this.writePos] = s;
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
