// Namco CUS30: the 8-voice waveform sound chip of Namco System 86 (and
// System 1). It lives in 1K of RAM shared by two CPUs: 0x000-0x0FF hold 16
// waveforms of 32 4-bit samples (two to a byte, high nibble first), and
// 0x100-0x13F the voice registers, 8 bytes per voice:
//   +0  volume (4 bits)
//   +1  waveform (high nibble), frequency bits 16-19 (low nibble)
//   +2  frequency bits 8-15
//   +3  frequency bits 0-7
//   +4  right volume (unused: mono here), and bit 7 = noise for the NEXT voice
// Each voice adds its frequency to a counter at 192 kHz; bits 18-22 pick the
// sample. A noise voice plays a 17-bit LFSR instead, clocked by the low byte
// of its frequency.
//
// The board owns the RAM (both CPUs read and write it directly); this reads
// the registers as it plays.

import { capture, apply } from './state.js';
import { RATE } from './mixer.js';

const INTERNAL = 192000, STEPS = INTERNAL / RATE;
const STATE = ['counter', 'noiseSeed', 'noiseState', 'noiseCounter', 'noiseHold'];

export class CUS30 {
  constructor(ram, gain = 1) {
    this.ram = ram;
    this.gain = gain;
    this.reset();
  }

  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.counter = new Uint32Array(8);
    this.noiseSeed = new Int32Array(8).fill(1);
    this.noiseState = new Uint8Array(8);
    this.noiseCounter = new Uint32Array(8);
    this.noiseHold = new Uint8Array(8);
    this.out = 0;
  }

  sample() {
    const ram = this.ram;
    let sum = 0;
    for (let v = 0; v < 8; v++) {
      const base = 0x100 + v * 8, vol = ram[base] & 15;
      if (!vol) continue;
      const noise = ram[0x100 + ((v + 7) & 7) * 8 + 4] & 0x80;
      if (noise) {
        const f = ram[base + 3];
        if (!f) continue;
        const level = 7 * (vol >> 1);
        let hold = this.noiseHold[v], c = this.noiseCounter[v], seed = this.noiseSeed[v], st = this.noiseState[v];
        for (let i = 0; i < STEPS; i++) {
          sum += st ? level : -level;
          if (hold) { hold--; continue; }
          hold = 4;
          c += f << 4;
          for (let n = c >> 12; n > 0; n--) {
            if ((seed + 1) & 2) st ^= 1;
            if (seed & 1) seed ^= 0x28000;
            seed >>= 1;
          }
          c &= 0xFFF;
        }
        this.noiseHold[v] = hold; this.noiseCounter[v] = c; this.noiseSeed[v] = seed; this.noiseState[v] = st;
      } else {
        const freq = ((ram[base + 1] & 15) << 16) | (ram[base + 2] << 8) | ram[base + 3];
        if (!freq) continue;
        const wave = (ram[base + 1] >> 4) * 16;
        let c = this.counter[v];
        for (let i = 0; i < STEPS; i++) {
          const pos = (c >>> 18) & 31, byte = ram[wave + (pos >> 1)];
          sum += (((pos & 1) ? byte & 15 : byte >> 4) - 8) * vol;
          c = (c + freq) >>> 0;
        }
        this.counter[v] = c;
      }
    }
    this.out = (sum / STEPS / (8 * 15 * 8)) * this.gain;
  }
}
