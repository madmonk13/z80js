// The sound half of Bally's Astrocade "I/O" custom chip: three square-wave
// tones and noise, all counting off one master oscillator, which can be
// wobbled by a vibrato or by the noise. Clocked at 1.79 MHz.
//
// Registers:
//   0  master oscillator period (the counter reloads with its complement)
//   1-3  tone A, B, C periods, in master oscillator ticks
//   4  vibrato speed (bits 6-7) and depth (bits 0-5)
//   5  noise AM (bit 5), master modulation from noise instead of vibrato
//      (bit 4), tone C volume (bits 0-3)
//   6  tone B volume (bits 4-7), tone A volume (bits 0-3)
//   7  noise volume (bits 4-7 for output; all 8 bits mask noise modulation)
//
// Mixed by the board (see mixer.js): sample() is called RATE times a second
// and leaves the chip's output in `out`.

import { capture, apply } from './state.js';
import { RATE } from './mixer.js';

// The noise register's top 8 bits, reversed, modulate the master oscillator.
const REVERSE = Uint8Array.from({ length: 256 }, (_, i) => {
  let r = 0;
  for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 0x80 >> b;
  return r;
});

const STATE = ['reg', 'master', 'vibrato', 'noiseClock', 'noise', 'count', 'state', 'acc'];

export class AstrocadeSound {
  constructor(clock, gain = 1) {
    this.clock = clock;
    this.gain = gain;
    this.reset();
  }

  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.reg = new Uint8Array(8);
    this.master = 0; this.vibrato = 0; this.noiseClock = 0; this.noise = 0;
    this.count = new Uint8Array(3);
    this.state = new Uint8Array(3);
    this.acc = 0;
    this.out = 0;
  }

  write(r, v) { this.reg[r & 7] = v; }

  level() {
    const reg = this.reg, st = this.state;
    let s = 0;
    if (st[0]) s += reg[6] & 15;
    if (st[1]) s += reg[6] >> 4;
    if (st[2]) s += reg[5] & 15;
    if ((reg[5] & 0x20) && (this.noise & 0x4000)) s += reg[7] >> 4;
    return s;
  }

  // Run n chip clocks, returning the summed output level over them.
  run(n) {
    const reg = this.reg;
    let total = 0;
    while (n > 0) {
      // Nothing changes until the master counter wraps or the noise clocks.
      const k = Math.min(n, 256 - this.master, 64 - this.noiseClock);
      total += this.level() * k;
      n -= k;
      this.noiseClock += k;
      if (this.noiseClock >= 64) {
        // A 15-bit LFSR: shift in the inverted XOR of the top two bits.
        this.noise = ((this.noise << 1) | (~((this.noise >> 14) ^ (this.noise >> 13)) & 1)) & 0xFFFF;
        this.noiseClock -= 64;
        this.vibrato = (this.vibrato + 1) & 0xFFFF;
      }
      this.master += k;
      if (this.master >= 256) {
        let m = ~reg[0] & 0xFF;
        if (!(reg[5] & 0x10)) {
          // Vibrato: the speed picks a bit of the slow counter; while it's low the depth adds on.
          if (!((this.vibrato >> (reg[4] >> 6)) & 0x200)) m += reg[4] & 0x3F;
        } else m += REVERSE[(this.noise >> 7) & 0xFF] & reg[7];
        this.master = m & 0xFF;
        for (let i = 0; i < 3; i++) {
          this.count[i] = (this.count[i] + 1) & 0xFF;
          if (this.count[i] === 0) { this.state[i] ^= 1; this.count[i] = ~reg[1 + i] & 0xFF; }
        }
      }
    }
    return total;
  }

  sample() {
    this.acc += this.clock / RATE;
    const n = Math.floor(this.acc);
    this.acc -= n;
    this.out = n ? (this.run(n) / n / 60) * this.gain : this.out;
  }
}
