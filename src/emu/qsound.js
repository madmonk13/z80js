// Capcom QSound (CPS-2 and late CPS-1 boards), modeled the way MAME's
// sample-player approximation does it: 16 channels of signed 8-bit samples
// from the sample ROM, each with a 16-bit start/end/loop within a 64K bank,
// a pitch (16.16 steps at the chip's 4 MHz / 166 rate), a volume and a pan.
// The Z80 writes a 16-bit value (high byte, then low) and then a register
// number; the "QSpace" 3D positioning is reduced to stereo panning, and the
// output here is mono.
//
// Registers 00-7F: channel (n >> 3), field (n & 7): 0 bank (applies to the
// next channel), 1 start, 2 pitch (0 keys off), 3 unused, 4 loop length back
// from the end, 5 end, 6 volume (0 keys off, otherwise keys on); 80-8F pan.

import { RATE } from './mixer.js';
import { capture, apply } from './state.js';

const NATIVE = 4000000 / 166, CHANNELS = 16;
const PAN = Array.from({ length: 33 }, (_, i) => Math.floor((256 / Math.sqrt(32)) * Math.sqrt(i)));
const STATE = ['bank', 'address', 'pitch', 'loop', 'end', 'vol', 'key', 'lvol', 'rvol', 'last', 'offset', 'data', 'phase', 'level'];

export class QSound {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // rom: the sample ROM (signed 8-bit samples)
  constructor(rom, gain = 1) {
    this.rom = rom;
    this.gain = gain;
    this.reset();
  }

  reset() {
    for (const k of ['bank', 'address', 'pitch', 'loop', 'end', 'vol', 'key', 'lvol', 'rvol', 'last', 'offset']) this[k] = new Int32Array(CHANNELS);
    this.data = 0; this.phase = 0; this.level = 0; this.out = 0;
  }

  dataHigh(v) { this.data = (this.data & 0xFF) | (v << 8); }
  dataLow(v) { this.data = (this.data & 0xFF00) | v; }
  status() { return 0x80; }                       // always ready

  command(n) {
    const v = this.data;
    if (n >= 0x80) {
      if (n < 0x90) {                                // pan: 0x110 left, 0x120 centre, 0x130 right
        const ch = n - 0x80, p = Math.min(32, (v - 0x10) & 0x3F);
        this.rvol[ch] = PAN[p]; this.lvol[ch] = PAN[32 - p];
      }
      return;
    }
    const ch = n >> 3;
    switch (n & 7) {
      case 0: this.bank[(ch + 1) & 15] = (v & 0x7F) << 16; break;
      case 1: this.address[ch] = v; break;
      case 2: this.pitch[ch] = v * 16; if (!v) this.key[ch] = 0; break;
      case 4: this.loop[ch] = v; break;
      case 5: this.end[ch] = v; break;
      case 6:
        if (!v) this.key[ch] = 0;
        else if (!this.key[ch]) { this.key[ch] = 1; this.offset[ch] = 0; this.last[ch] = 0; }
        this.vol[ch] = v;
        break;
    }
  }

  // One step at the chip's own rate.
  step() {
    const rom = this.rom, len = rom.length;
    let sum = 0;
    for (let ch = 0; ch < CHANNELS; ch++) {
      if (!this.key[ch]) continue;
      const count = this.offset[ch] >>> 16;
      this.offset[ch] &= 0xFFFF;
      if (count) {
        this.address[ch] += count;
        if (this.address[ch] >= this.end[ch]) {
          if (!this.loop[ch]) { this.key[ch] = 0; continue; }
          this.address[ch] = (this.end[ch] - this.loop[ch]) & 0xFFFF;
        }
        const b = rom[(this.bank[ch] + this.address[ch]) % len];
        this.last[ch] = b > 127 ? b - 256 : b;
      }
      const vol = this.vol[ch];
      sum += this.last[ch] * (((this.lvol[ch] * vol) >> 8) + ((this.rvol[ch] * vol) >> 8)) / 2;
      this.offset[ch] += this.pitch[ch];
    }
    this.level = sum;
  }

  sample() {
    this.phase += NATIVE / RATE;
    while (this.phase >= 1) { this.phase -= 1; this.step(); }
    this.out = this.level / (64 * 32768) * 2.5 * this.gain;
  }
}
