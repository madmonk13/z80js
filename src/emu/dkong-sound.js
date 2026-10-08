// Sound for the Donkey Kong boards: the 8035's 8-bit DAC (music and most
// effects), plus effects the main CPU triggers directly. The DAC output fades
// while the 8035 holds its "discharge" line (P2 bit 7) low.
//
// The directly triggered effects come from analog circuits (Donkey Kong) or
// recorded samples (Donkey Kong Jr.), so they're modeled by character here,
// not reproduced exactly. Each is started on the rising edge of its line.
// Output goes into a ring buffer at RATE, like the other sound sources.

import { capture, apply } from './state.js';

export const RATE = 48000;
const FADE = Math.exp(-1 / (0.25 * RATE));    // DAC envelope time constant: 0.25 s

// name: length in seconds and a generator f(t, progress 0-1, voice) -> sample.
// `voice` holds per-play state (phase, noise filter).
const EFFECTS = {
  // Donkey Kong
  walk: { length: 0.07, gen: (t, p, v) => square(v, 430 - 60 * p) * 0.32 * Math.exp(-t / 0.022) },    // 555 near 430 Hz, gated
  jump: { length: 0.32, gen: (t, p, v) => square(v, 250 + 700 * p) * 0.25 * (1 - p) },
  stomp: { length: 0.45, gen: (t, p, v) => lowNoise(v, 0.02) * 1.6 * (1 - p) ** 2 },
  // Donkey Kong Jr.
  climb: { length: 0.06, gen: (t, p, v) => square(v, v.pitch) * 0.28 * Math.exp(-t / 0.02) },
  land: { length: 0.18, gen: (t, p, v) => (lowNoise(v, 0.05) * 1.2 + square(v, 120) * 0.2) * (1 - p) ** 2 },
  roar: { length: 0.9, gen: (t, p, v) => lowNoise(v, 0.03) * 1.4 * Math.sin(Math.PI * p) * (0.7 + 0.3 * Math.sin(t * 60)) },
  snapjaw: { length: 0.12, gen: (t, p, v) => (noise(v) * 0.25 + square(v, 900 - 500 * p) * 0.2) * (1 - p) },
  death: { length: 1.1, gen: (t, p, v) => square(v, 700 * (1 - p) + 120 + 60 * Math.sin(t * 40)) * 0.25 * (1 - p * 0.6) },
  drop: { length: 0.7, gen: (t, p, v) => square(v, 1400 - 1100 * p) * 0.22 * (1 - p * 0.5) },
};

function square(v, freq) {
  v.phase = (v.phase + freq / RATE) % 1;
  return v.phase < 0.5 ? 1 : -1;
}
function noise(v) {
  const bit = ((v.lfsr >> 16) ^ (v.lfsr >> 13)) & 1;
  v.lfsr = ((v.lfsr << 1) | bit) & 0x1FFFF;
  return bit ? 1 : -1;
}
function lowNoise(v, k) {
  v.lp += (noise(v) - v.lp) * k;
  return v.lp;
}

const STATE = ['dac', 'env', 'discharge', 'levels', 'active', 'climbs'];

export class DKongSound {
  constructor() {
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }

  // Save states: everything that changes while running.
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.writePos = this.readPos = 0;
    this.dac = 0x80;
    this.env = 1;
    this.discharge = false;
    this.levels = {};             // effect line -> last level written
    this.active = {};             // effect -> { n samples played, voice state }
    this.climbs = 0;
  }

  // Start effect `name` on a rising edge of its line.
  trigger(name, v) {
    const bit = v & 1;
    if (bit && !this.levels[name]) {
      const voice = { phase: 0, lfsr: 0x1ACE1 + this.climbs * 977, lp: 0 };
      if (name === 'climb') voice.pitch = [520, 600, 520, 600, 460, 520, 460][this.climbs++ % 7];   // a climbing step pattern
      this.active[name] = { n: 0, voice };
    }
    this.levels[name] = bit;
  }

  effects() {
    let s = 0;
    for (const name of Object.keys(this.active)) {
      const a = this.active[name], fx = EFFECTS[name], len = fx.length * RATE;
      if (a.n >= len) { delete this.active[name]; continue; }
      s += fx.gen(a.n / RATE, a.n / len, a.voice);
      a.n++;
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
