// Konami K053260: four channels of 8-bit PCM, or 4-bit packed delta PCM,
// from up to 16MB of sample ROM (Parodius, The Simpsons, TMNT2...). Each
// channel has a 12-bit pitch (it steps through its sample at
// clock / (4096 - pitch) bytes a second), a 16-bit length, a start address
// plus a bank byte, a volume and a 3-bit pan. Registers 0-7 are mailboxes
// between the main and sound CPUs (0-1 written by the main CPU, 2-3 by the
// sound CPU).
//
// Registers: 08-27 channels (8 each: pitch lo/hi, length lo/hi, start lo/hi,
// bank, volume), 28 key on/off, 29 playing status (read), 2A loop and packed
// flags, 2C-2D pans, 2E ROM read (through channel 0's address), 2F control
// (bit 0 ROM read, bit 1 sound on).

import { RATE } from './mixer.js';
import { capture, apply } from './state.js';

const STATE = ['regs', 'rate', 'size', 'start', 'bank', 'volume', 'pan', 'play', 'loop', 'ppcm', 'pos', 'ppcmData', 'mode'];
// Packed PCM: each nibble is a step added to the decaying previous value.
const STEPS = [0, 1, 2, 4, 8, 16, 32, 64, -128, -64, -32, -16, -8, -4, -2, -1];

export class K053260 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor(clock, rom, gain = 1) {
    this.clock = clock;
    this.rom = rom;
    this.gain = gain;
    this.reset();
  }
  reset() {
    this.regs = new Uint8Array(0x30);
    this.rate = new Uint16Array(4); this.size = new Uint16Array(4); this.start = new Uint16Array(4); this.bank = new Uint8Array(4);
    this.volume = new Uint8Array(4); this.pan = new Uint8Array(4);
    this.play = new Uint8Array(4); this.loop = new Uint8Array(4); this.ppcm = new Uint8Array(4);
    this.pos = new Float64Array(4);          // samples (bytes, or nibbles for packed PCM) played
    this.ppcmData = new Int16Array(4);
    this.mode = 0;
    this.out = 0;
  }

  base(ch) { return (this.bank[ch] << 16) + this.start[ch]; }

  write(r, v) {
    if (r > 0x2F) return;
    if (r === 0x28) {                        // key on (0 to 1) / off
      const t = this.regs[r] ^ v;
      for (let ch = 0; ch < 4; ch++) {
        if (!(t & (1 << ch))) continue;
        if (v & (1 << ch)) {
          this.play[ch] = 1; this.pos[ch] = 0; this.ppcmData[ch] = 0;
          if (this.base(ch) >= this.rom.length) this.play[ch] = 0;
        } else this.play[ch] = 0;
      }
      this.regs[r] = v;
      return;
    }
    this.regs[r] = v;
    if (r < 8) return;
    if (r < 0x28) {
      const ch = (r - 8) >> 3;
      switch ((r - 8) & 7) {
        case 0: this.rate[ch] = (this.rate[ch] & 0x0F00) | v; break;
        case 1: this.rate[ch] = (this.rate[ch] & 0x00FF) | ((v & 0x0F) << 8); break;
        case 2: this.size[ch] = (this.size[ch] & 0xFF00) | v; break;
        case 3: this.size[ch] = (this.size[ch] & 0x00FF) | (v << 8); break;
        case 4: this.start[ch] = (this.start[ch] & 0xFF00) | v; break;
        case 5: this.start[ch] = (this.start[ch] & 0x00FF) | (v << 8); break;
        case 6: this.bank[ch] = v; break;
        case 7: this.volume[ch] = ((v & 0x7F) << 1) | (v & 1); break;
      }
      return;
    }
    switch (r) {
      case 0x2A: for (let ch = 0; ch < 4; ch++) { this.loop[ch] = (v >> ch) & 1; this.ppcm[ch] = (v >> (ch + 4)) & 1; } break;
      case 0x2C: this.pan[0] = v & 7; this.pan[1] = (v >> 3) & 7; break;
      case 0x2D: this.pan[2] = v & 7; this.pan[3] = (v >> 3) & 7; break;
      case 0x2F: this.mode = v & 7; break;
    }
  }

  read(r) {
    if (r === 0x29) return this.play[0] | (this.play[1] << 1) | (this.play[2] << 2) | (this.play[3] << 3);
    if (r === 0x2E && (this.mode & 1)) {     // read the ROM through channel 0, advancing it (a 16-bit count that wraps)
      const n = Math.floor(this.pos[0]) & 0xFFFF;
      this.pos[0] = (n + 1) & 0xFFFF;
      return this.rom[this.base(0) + n] ?? 0;
    }
    return this.regs[r] ?? 0;
  }

  sample() {
    let sum = 0;
    if (this.mode & 2) {
      for (let ch = 0; ch < 4; ch++) {
        if (!this.play[ch]) continue;
        const packed = this.ppcm[ch], len = this.size[ch];
        let p = this.pos[ch];
        if ((packed ? p / 2 : p) >= len) {
          this.ppcmData[ch] = 0;
          if (this.loop[ch]) p = 0; else { this.play[ch] = 0; continue; }
        }
        const step = this.clock / (0x1000 - this.rate[ch]) / RATE;
        let d;
        if (packed) {
          // A new nibble each time the position crosses a whole step (low nibble first).
          const before = Math.floor(p), after = Math.floor(p + step);
          for (let n = p === 0 ? before : before + 1; n <= after; n++) {
            const byte = this.rom[this.base(ch) + (n >> 1)] ?? 0, nib = n & 1 ? byte >> 4 : byte & 15;
            this.ppcmData[ch] = Math.max(-128, Math.min(127, ((this.ppcmData[ch] * 62) >> 6) + STEPS[nib]));
          }
          d = this.ppcmData[ch];
        } else {
          const byte = this.rom[this.base(ch) + Math.floor(p)] ?? 0;
          d = (byte << 24) >> 24;
        }
        this.pos[ch] = p + step;
        sum += d * this.volume[ch] * 4;          // (left + right pans always total 8)
      }
    }
    this.out = (sum / 4 / 32768) * this.gain;
  }
}
