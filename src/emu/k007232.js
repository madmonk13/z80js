// Konami K007232: two channels of 7-bit PCM played from sample ROM (Ajax,
// TMNT, Aliens and most Konami boards of 1987-90). Each channel has a
// 17-bit start address (plus a bank the board sets), a 9-bit pitch, and
// runs until it reads a byte with bit 7 set (or loops back to its start
// when its loop bit is on). Volumes come from outside the chip: most
// boards wire its external port (register 0C) to a volume latch.
//
// Registers, per channel (B at +6): 0-1 pitch, 2-4 start address, 5 (write
// or read) key on. 0C external port, 0D loop flags.
//
// The chip steps through samples at clock / 128, advancing by
// 32 / (512 - pitch) bytes a step.

import { RATE } from './mixer.js';
import { capture, apply } from './state.js';

const STATE = ['regs', 'start', 'pos', 'play', 'bank', 'vol'];

export class K007232 {
  constructor(clock, rom, gain = 1) {
    this.clock = clock;
    this.rom = rom;
    this.gain = gain;
    this.onPort = null;            // (value) the board's handler for register 0C
    this.reset();
  }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.regs = new Uint8Array(16);
    this.start = new Int32Array(2);
    this.pos = new Float64Array(2);     // bytes past the start
    this.play = new Uint8Array(2);
    this.bank = new Int32Array(2);      // added to the start address (each bank is 128K)
    this.vol = new Float32Array([1, 1]);
    this.out = 0;
  }

  setBank(a, b) { this.bank[0] = a << 17; this.bank[1] = b << 17; }
  setVolume(ch, v) { this.vol[ch] = v; }   // 0-1

  keyOn(ch) {
    const r = this.regs, o = ch * 6;
    this.start[ch] = (((r[o + 4] & 1) << 16) | (r[o + 3] << 8) | r[o + 2]) + this.bank[ch];
    if (this.start[ch] < this.rom.length) { this.play[ch] = 1; this.pos[ch] = 0; }
  }

  write(r, v) {
    r &= 15;
    this.regs[r] = v;
    if (r === 0x0C) { if (this.onPort) this.onPort(v); return; }
    if (r === 0x05) this.keyOn(0);
    else if (r === 0x0B) this.keyOn(1);
  }
  read(r) {
    r &= 15;
    if (r === 0x05) this.keyOn(0);
    else if (r === 0x0B) this.keyOn(1);
    return 0;
  }

  sample() {
    let s = 0;
    const rom = this.rom, stepRate = this.clock / 128 / RATE;
    for (let ch = 0; ch < 2; ch++) {
      if (!this.play[ch]) continue;
      const o = ch * 6, pitch = ((this.regs[o + 1] & 1) << 8) | this.regs[o];
      const from = Math.floor(this.pos[ch]);
      this.pos[ch] += (32 / (512 - pitch)) * stepRate;
      const to = Math.floor(this.pos[ch]);
      // Check every byte passed over for the end marker.
      let ended = false;
      for (let a = from; a <= to; a++) {
        const addr = this.start[ch] + a;
        if (addr >= rom.length || rom[addr] & 0x80) { ended = true; break; }
      }
      if (ended) {
        if (this.regs[0x0D] & (1 << ch)) { this.keyOn(ch); this.pos[ch] = 0; }
        else { this.play[ch] = 0; continue; }
      }
      const b = rom[this.start[ch] + Math.floor(this.pos[ch])] ?? 0x40;
      s += ((b & 0x7F) - 0x40) / 64 * this.vol[ch];
    }
    this.out = s * 0.5 * this.gain;
  }
}
