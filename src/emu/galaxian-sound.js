// Galaxian's sound board is analog circuitry, not a sound chip. This models
// its parts closely enough to sound right, not component by component:
//   - tone: a 16-step waveform clocked at 1.536 MHz / (256 - pitch) per step
//     (pitch FF = silent), with four volume shapes (the marching melody)
//   - background: three hum oscillators near 139, 190 and 267 Hz whose pitch is
//     swept by a slow ramp (the swarm drone), each switched on separately
//   - hit: noise that sounds while enabled and dies away after
//   - shot: a short noise burst sweeping down in pitch, on each rising edge
// Output goes into a ring buffer at RATE, like the other sound sources.

import { capture, apply } from './state.js';

export const RATE = 48000;
const LINE_RATE = 264 * 60.606;
const SAMPLES_PER_LINE = RATE / LINE_RATE;
const TONE_CLOCK = 1536000;
const HUM = [139, 190, 267];

// Four volume shapes for the 16-step tone (the volume bits pick resistor
// combinations on the real board); here, a sawtooth at four levels.
const TOOTH = Array.from({ length: 4 }, (_, v) => Float32Array.from({ length: 16 }, (_, i) => ((i / 15) * 2 - 1) * (0.25 + v * 0.25)));

const GALAXIAN_SOUND_STATE = ['pitch', 'vol', 'tonePhase', 'hum', 'humPhase', 'sweep', 'lfoBits', 'noiseOn', 'noiseLevel', 'noise', 'shot', 'lastShoot', 'shotValue', 'carry'];

export class GalaxianSound {
  // Save states: everything that changes while running (not ROM-derived data).
  saveState() { return capture(this, GALAXIAN_SOUND_STATE); }
  loadState(s) { apply(this, GALAXIAN_SOUND_STATE, s); }

  constructor() {
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }

  reset() {
    this.writePos = this.readPos = 0;
    this.carry = 0;
    this.pitch = 0xFF;
    this.vol = 0;
    this.tonePhase = 0;
    this.hum = [false, false, false];
    this.humPhase = [0, 0, 0];
    this.sweep = 1;               // LFO ramp: hum pitch factor
    this.lfoBits = 0;
    this.noiseOn = false;
    this.noiseLevel = 0;
    this.noise = 0x1FFFF;
    this.shot = 0;                // samples left in the current shot
    this.lastShoot = 0;
  }

  write(reg, v) {
    const bit = v & 1;
    switch (reg) {
      case 'pitch': this.pitch = v; break;
      case 'vol0': this.vol = (this.vol & 2) | bit; break;
      case 'vol1': this.vol = (this.vol & 1) | (bit << 1); break;
      case 'hum0': case 'hum1': case 'hum2': this.hum[+reg[3]] = !!bit; break;
      case 'noise': this.noiseOn = !!bit; if (bit) this.noiseLevel = 1; break;
      case 'shoot': if (bit && !this.lastShoot) this.shot = Math.floor(RATE * 0.32); this.lastShoot = bit; break;
      default:
        // lfo0-lfo3: four bits setting how fast the hum sweeps.
        if (reg.startsWith('lfo')) this.lfoBits = (this.lfoBits & ~(1 << +reg[3])) | (bit << +reg[3]);
    }
  }

  nextNoise() {
    const bit = ((this.noise >> 16) ^ (this.noise >> 13)) & 1;
    this.noise = ((this.noise << 1) | bit) & 0x1FFFF;
    return bit ? 1 : -1;
  }

  line() {
    this.carry += SAMPLES_PER_LINE;
    let n = this.carry | 0;
    this.carry -= n;
    const buf = this.buffer, mask = buf.length - 1;
    // Hum sweep: the ramp runs between +-1/3 of the base pitch; faster with
    // more LFO bits set.
    this.sweep -= (0.00002 + this.lfoBits * 0.00002) * n;
    if (this.sweep < 2 / 3) this.sweep = 4 / 3;
    const toneStep = this.pitch === 0xFF ? 0 : TONE_CLOCK / (256 - this.pitch) / RATE;
    while (n-- > 0) {
      let s = 0;
      if (toneStep) {
        this.tonePhase = (this.tonePhase + toneStep) % 16;
        s += TOOTH[this.vol][this.tonePhase | 0] * 0.35;
      }
      for (let i = 0; i < 3; i++) {
        this.humPhase[i] = (this.humPhase[i] + (HUM[i] * this.sweep) / RATE) % 1;
        if (this.hum[i]) s += (this.humPhase[i] < 0.5 ? 0.06 : -0.06);
      }
      if (this.noiseLevel > 0.002) {
        s += this.nextNoise() * 0.3 * this.noiseLevel;
        if (!this.noiseOn) this.noiseLevel *= 0.99993;
      }
      if (this.shot > 0) {
        // Noise sampled at a falling rate gives the "pew".
        const t = 1 - this.shot / (RATE * 0.32);
        if (Math.random() < 0.5 - t * 0.45) this.shotValue = this.nextNoise();
        s += (this.shotValue || 0) * 0.3 * (1 - t);
        this.shot--;
      }
      buf[this.writePos] = s;
      this.writePos = (this.writePos + 1) & mask;
      if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
    }
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
