// NEC uPD7759 ADPCM speech chip, in slave mode (Sega System 16B, Taito): the
// host CPU supplies every byte when the chip asks (its DRQ line, usually wired
// to the CPU's NMI). After /START the chip asks for: the last sample number,
// a dummy byte, the sample's address (high, low; ignored in slave mode), a
// dummy, then a stream of block headers and data: silence blocks, blocks of
// 256 or n 4-bit ADPCM nibbles at a rate from the header, and repeat loops.
//
// In master mode (TMNT) the chip reads a sample ROM itself instead: byte 0
// the last sample number, a signature, then a table of word addresses from
// offset 5; each sample starts with a dummy byte, then its blocks. The port
// value written before /START picks the sample.
//
// Mixed by the board (see mixer.js): sample() is called RATE times a second.

import { capture, apply } from './state.js';
import { RATE } from './mixer.js';

// The decoder's step table (per state, per nibble) and state changes.
const STEP = [
  [0, 0, 1, 2, 3, 5, 7, 10, 0, 0, -1, -2, -3, -5, -7, -10], [0, 1, 2, 3, 4, 6, 8, 13, 0, -1, -2, -3, -4, -6, -8, -13],
  [0, 1, 2, 4, 5, 7, 10, 15, 0, -1, -2, -4, -5, -7, -10, -15], [0, 1, 3, 4, 6, 9, 13, 19, 0, -1, -3, -4, -6, -9, -13, -19],
  [0, 2, 3, 5, 8, 11, 15, 23, 0, -2, -3, -5, -8, -11, -15, -23], [0, 2, 4, 7, 10, 14, 19, 29, 0, -2, -4, -7, -10, -14, -19, -29],
  [0, 3, 5, 8, 12, 16, 22, 33, 0, -3, -5, -8, -12, -16, -22, -33], [1, 4, 7, 10, 15, 20, 29, 43, -1, -4, -7, -10, -15, -20, -29, -43],
  [1, 4, 8, 13, 18, 25, 35, 53, -1, -4, -8, -13, -18, -25, -35, -53], [1, 6, 10, 16, 22, 31, 43, 64, -1, -6, -10, -16, -22, -31, -43, -64],
  [2, 7, 12, 19, 27, 37, 51, 76, -2, -7, -12, -19, -27, -37, -51, -76], [2, 9, 16, 24, 34, 46, 64, 96, -2, -9, -16, -24, -34, -46, -64, -96],
  [3, 11, 19, 29, 41, 57, 79, 117, -3, -11, -19, -29, -41, -57, -79, -117], [4, 13, 24, 36, 50, 69, 96, 143, -4, -13, -24, -36, -50, -69, -96, -143],
  [4, 16, 29, 44, 62, 85, 118, 175, -4, -16, -29, -44, -62, -85, -118, -175], [6, 20, 36, 54, 76, 104, 144, 214, -6, -20, -36, -54, -76, -104, -144, -214],
];
const STATE_CHANGE = [-1, -1, 0, 0, 1, 2, 2, 3, -1, -1, 0, 0, 1, 2, 2, 3];

const IDLE = 0, DROP_DRQ = 1, START = 2, FIRST_REQ = 3, LAST_SAMPLE = 4, DUMMY1 = 5, ADDR_MSB = 6, ADDR_LSB = 7,
  DUMMY2 = 8, BLOCK_HEADER = 9, NIBBLE_COUNT = 10, NIBBLE_MSN = 11, NIBBLE_LSN = 12;

const STATE = ['state', 'clocksLeft', 'postState', 'postClocks', 'drq', 'fifo', 'resetPin', 'startPin', 'reqSample', 'lastSample',
  'header', 'rate', 'nibbles', 'repeatCount', 'firstHeader', 'adpcmState', 'adpcmData', 'value', 'acc', 'out', 'romOffset', 'addrHi'];

export class UPD7759 {
  constructor(clock, gain, onDrq, rom = null) {
    this.clock = clock;
    this.gain = gain;
    this.onDrq = onDrq;
    this.rom = rom;                 // master mode when set
    this.reset();
    this.resetPin = 1; this.startPin = 1;
  }

  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.state = IDLE; this.clocksLeft = 0; this.postState = IDLE; this.postClocks = 0;
    this.drq = 0; this.fifo = 0;
    this.reqSample = 0; this.lastSample = 0; this.header = 0; this.rate = 0; this.nibbles = 0;
    this.repeatCount = 0; this.firstHeader = 0; this.adpcmState = 0; this.adpcmData = 0; this.value = 0;
    this.acc = 0; this.out = 0; this.romOffset = 0; this.addrHi = 0;
  }

  busy() { return this.state !== IDLE; }
  data(v) { this.fifo = v; }
  resetLine(v) { const was = this.resetPin; this.resetPin = v ? 1 : 0; if (was && !this.resetPin) this.reset(); }
  start(v) {
    const was = this.startPin;
    this.startPin = v ? 1 : 0;
    if (this.state === IDLE && !was && this.startPin && this.resetPin) { this.state = START; this.clocksLeft = 0; }
  }

  adpcm(n) {
    this.value += STEP[this.adpcmState][n];
    this.adpcmState = Math.max(0, Math.min(15, this.adpcmState + STATE_CHANGE[n]));
  }

  // One step of the state machine (each waits clocksLeft chip clocks before the next).
  advance() {
    switch (this.state) {
      case IDLE: this.clocksLeft = 4; return;
      case DROP_DRQ: this.drq = 0; this.clocksLeft = this.postClocks; this.state = this.postState; return;
      case START: this.reqSample = this.rom ? this.fifo : 0x10; this.clocksLeft = 70; this.state = FIRST_REQ; return;   // (slave mode: no sample number)
      case FIRST_REQ: this.drq = 1; this.clocksLeft = 44; this.state = LAST_SAMPLE; break;
      case LAST_SAMPLE:
        this.lastSample = this.fifo; this.drq = 1; this.clocksLeft = 28;
        this.state = this.reqSample > this.lastSample ? IDLE : DUMMY1;
        break;
      case DUMMY1: this.drq = 1; this.clocksLeft = 32; this.state = ADDR_MSB; break;
      case ADDR_MSB: this.addrHi = this.fifo; this.drq = 1; this.clocksLeft = 44; this.state = ADDR_LSB; break;
      case ADDR_LSB: this.romOffset = ((this.addrHi << 8) | this.fifo) * 2; this.drq = 1; this.clocksLeft = 36; this.state = DUMMY2; break;
      case DUMMY2: this.firstHeader = 0; this.drq = 1; this.clocksLeft = 36; this.state = BLOCK_HEADER; break;
      case BLOCK_HEADER:
        if (this.repeatCount) this.repeatCount--;
        this.header = this.fifo; this.drq = 1;
        switch (this.header & 0xC0) {
          case 0x00:                                 // silence
            this.clocksLeft = 1024 * ((this.header & 0x3F) + 1);
            this.state = this.header === 0 && this.firstHeader ? IDLE : BLOCK_HEADER;
            this.value = 0; this.adpcmState = 0;
            break;
          case 0x40: this.rate = (this.header & 0x3F) + 1; this.nibbles = 256; this.clocksLeft = 36; this.state = NIBBLE_MSN; break;
          case 0x80: this.rate = (this.header & 0x3F) + 1; this.clocksLeft = 36; this.state = NIBBLE_COUNT; break;
          default: this.repeatCount = (this.header & 7) + 1; this.clocksLeft = 36; this.state = BLOCK_HEADER;
        }
        if (this.header) this.firstHeader = 1;
        break;
      case NIBBLE_COUNT: this.nibbles = this.fifo + 1; this.drq = 1; this.clocksLeft = 36; this.state = NIBBLE_MSN; break;
      case NIBBLE_MSN:
        this.adpcmData = this.fifo; this.adpcm(this.adpcmData >> 4); this.drq = 1;
        this.clocksLeft = this.rate * 4;
        this.state = --this.nibbles === 0 ? BLOCK_HEADER : NIBBLE_LSN;
        break;
      case NIBBLE_LSN:
        this.adpcm(this.adpcmData & 15);
        this.clocksLeft = this.rate * 4;
        this.state = --this.nibbles === 0 ? BLOCK_HEADER : NIBBLE_MSN;
        return;
    }
    // A data request goes out now and drops 21 clocks later.
    if (this.drq) {
      this.postState = this.state; this.postClocks = this.clocksLeft - 21;
      this.state = DROP_DRQ; this.clocksLeft = 21;
      if (this.rom) this.fifo = this.romByte(this.postState); else this.onDrq();
    }
  }

  // Master mode: the byte the next state reads.
  romByte(next) {
    const r = this.rom, mask = r.length - 1;
    switch (next) {
      case LAST_SAMPLE: return r[0];
      case ADDR_MSB: return r[(5 + 2 * this.reqSample) & mask];
      case ADDR_LSB: return r[(6 + 2 * this.reqSample) & mask];
      case DUMMY1: return 0;
      default: return r[this.romOffset++ & mask];
    }
  }

  sample() {
    if (this.state !== IDLE) {
      this.acc += this.clock / RATE;
      while (this.acc >= 1 && this.state !== IDLE) {
        const n = Math.min(Math.floor(this.acc), Math.max(1, this.clocksLeft));
        this.acc -= n;
        this.clocksLeft -= n;
        if (this.clocksLeft <= 0) this.advance();
      }
      if (this.state === IDLE) this.acc = 0;
    }
    this.out = this.state === IDLE ? 0 : (this.value / 256) * this.gain;
  }
}
