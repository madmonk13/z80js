// Zilog Z80 CTC: four counter/timer channels that interrupt the Z80 in
// mode 2 through its daisy chain.
//
// Each channel is set up by writing to it: a control word (bit 0 set), then,
// if the word says so (bit 2), a time constant. Control word bits:
//   7 interrupt enable   6 counter mode (else timer)   5 prescaler 256 (else 16)
//   4 rising edge        3 timer waits for a trigger   2 time constant follows
//   1 software reset     0 1 = control word
// Writing a byte with bit 0 clear to channel 0 sets the vector base (bits 3-7);
// channel n interrupts with base + 2n.
//
// A timer counts down once every 16 or 256 system clocks; a counter once per
// active edge on its trigger input. Reaching zero reloads the time constant,
// pulses the channel's ZC/TO output and requests an interrupt if enabled.
// Lower-numbered channels have priority; one being serviced (between the
// acknowledge and its RETI) holds off the channels after it.

import { capture, apply } from './state.js';

const STATE = ['vector', 'mode', 'tconst', 'down', 'waiting', 'running', 'prescale', 'trg', 'pending', 'inService', 'loadNext'];

export class Z80CTC {
  // onZero(ch): ZC/TO output pulses (boards wire these to other triggers).
  constructor(onZero = () => {}) {
    this.onZero = onZero;
    this.reset();
  }

  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.vector = 0;
    this.mode = new Uint8Array(4).fill(0x03);       // reset, nothing loaded
    this.tconst = new Uint16Array(4).fill(0x100);
    this.down = new Uint16Array(4);
    this.waiting = new Uint8Array(4);               // timer waiting for its trigger to start
    this.running = new Uint8Array(4);               // timer counting
    this.prescale = new Uint16Array(4);             // system clocks until the next count
    this.trg = new Uint8Array(4);
    this.pending = new Uint8Array(4);
    this.inService = new Uint8Array(4);
    this.loadNext = new Uint8Array(4);              // next write is a time constant
  }

  write(ch, v) {
    if (this.loadNext[ch]) {
      this.loadNext[ch] = 0;
      this.tconst[ch] = v || 0x100;
      this.down[ch] = this.tconst[ch];
      this.mode[ch] &= ~0x02;
      if (!(this.mode[ch] & 0x40)) {                // timer: start now or on the trigger
        if (this.mode[ch] & 0x08) this.waiting[ch] = 1;
        else this.startTimer(ch);
      }
      return;
    }
    if (!(v & 1)) { if (ch === 0) this.vector = v & 0xF8; return; }
    this.mode[ch] = v;
    if (v & 0x04) this.loadNext[ch] = 1;
    if (v & 0x02) { this.running[ch] = 0; this.waiting[ch] = 0; }
  }

  startTimer(ch) {
    this.running[ch] = 1;
    this.waiting[ch] = 0;
    this.down[ch] = this.tconst[ch];
    this.prescale[ch] = this.mode[ch] & 0x20 ? 256 : 16;
  }

  read(ch) { return this.down[ch] & 0xFF; }

  // Advance the timers by `cycles` system clocks.
  clock(cycles) {
    for (let ch = 0; ch < 4; ch++) {
      if (!this.running[ch]) continue;
      let n = cycles;
      while (n >= this.prescale[ch]) {
        n -= this.prescale[ch];
        this.prescale[ch] = this.mode[ch] & 0x20 ? 256 : 16;
        if (--this.down[ch] === 0) this.zero(ch);
      }
      this.prescale[ch] -= n;
    }
  }

  // Trigger input `ch` goes to `level` (0/1).
  trigger(ch, level) {
    if (level === this.trg[ch]) return;
    this.trg[ch] = level;
    const rising = !!(this.mode[ch] & 0x10);
    if (rising !== !!level) return;
    if (this.waiting[ch] && !(this.mode[ch] & 0x40)) this.startTimer(ch);
    this.waiting[ch] = 0;
    if ((this.mode[ch] & 0x42) === 0x40 && --this.down[ch] === 0) this.zero(ch);   // counting, not held in reset
  }

  zero(ch) {
    this.down[ch] = this.tconst[ch];
    if (this.mode[ch] & 0x80) this.pending[ch] = 1;
    this.onZero(ch);
  }

  // The interrupt line: a pending channel ahead of any being serviced.
  irq() {
    for (let ch = 0; ch < 4; ch++) {
      if (this.inService[ch]) return false;
      if (this.pending[ch]) return true;
    }
    return false;
  }

  // The CPU takes the interrupt: returns the vector.
  ack() {
    for (let ch = 0; ch < 4; ch++) {
      if (this.pending[ch]) {
        this.pending[ch] = 0;
        this.inService[ch] = 1;
        return this.vector | (ch << 1);
      }
    }
    return this.vector;
  }

  // RETI ends the highest-priority interrupt being serviced.
  reti() {
    for (let ch = 0; ch < 4; ch++) if (this.inService[ch]) { this.inService[ch] = 0; return; }
  }
}
