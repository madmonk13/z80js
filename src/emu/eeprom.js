// Serial EEPROM (93C46 family): the board shifts command, address and data
// bits in on clock rising edges while the chip is selected, and shifts read
// data out the same way. Each board describes its chip: address and data
// widths and the bit patterns of its commands ('0'/'1', 'x' any bit, and a
// leading '*1' / '*0' meaning any run of the other bit before it).
//
// `data` is the chip's contents (kept by the board as its nvram).

import { capture, apply } from './state.js';

const STATE = ['data', 'buffer', 'latch', 'cs', 'clock', 'sending', 'bits', 'count', 'address', 'locked'];

function match(buf, cmd, len) {
  if (!cmd || len <= 0) return false;
  let b = 0, c = 0;
  while (len > 0) {
    if (b >= buf.length || c >= cmd.length) return b >= buf.length && c >= cmd.length;
    const ch = cmd[c];
    if (ch === '0' || ch === '1') { if (buf[b] !== ch) return false; b++; len--; c++; }
    else if (ch === 'x' || ch === 'X') { b++; len--; c++; }
    else if (ch === '*') {
      const next = cmd[c + 1];
      if (buf[b] === next) c++; else { b++; len--; }
    } else return false;
  }
  return c >= cmd.length;
}

export class SerialEEPROM {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // cfg: { addressBits, dataBits, read, write, erase, lock, unlock }
  constructor(cfg) {
    this.cfg = cfg;
    this.data = new Uint8Array((1 << cfg.addressBits) * cfg.dataBits / 8).fill(0xFF);
    this.reset();
  }
  reset() {
    this.buffer = ''; this.latch = 0; this.cs = 1; this.clock = 1;
    this.sending = 0; this.bits = 0; this.count = 0; this.address = 0;
    this.locked = this.cfg.unlock ? 1 : 0;
  }

  writeBit(v) { this.latch = v ? 1 : 0; }
  // Select: the chip is active while its select line is low (as the boards wire it); going inactive resets the command.
  setReset(asserted) { this.cs = asserted ? 1 : 0; if (asserted) { this.buffer = ''; this.sending = 0; } }
  readBit() { return this.sending ? (this.bits >> this.cfg.dataBits) & 1 : 1; }

  setClock(high) {
    if (high && !this.clock && !this.cs) {
      if (this.sending) { this.bits = (this.bits << 1) | 1; this.count++; }
      else this.shiftIn(this.latch);
    }
    this.clock = high ? 1 : 0;
  }

  word(a) { return this.cfg.dataBits === 16 ? (this.data[2 * a] << 8) | this.data[2 * a + 1] : this.data[a]; }
  setWord(a, v) {
    if (this.locked) return;
    if (this.cfg.dataBits === 16) { this.data[2 * a] = v >> 8; this.data[2 * a + 1] = v & 0xFF; } else this.data[a] = v;
  }

  shiftIn(bit) {
    if (this.buffer.length >= 39) return;
    const b = (this.buffer += bit ? '1' : '0'), c = this.cfg, n = b.length, ab = c.addressBits, db = c.dataBits;
    const num = (s) => parseInt(s, 2);
    if (n > ab && match(b, c.read, n - ab)) {
      this.address = num(b.slice(n - ab)); this.bits = this.word(this.address); this.count = 0; this.sending = 1; this.buffer = '';
    } else if (n > ab && match(b, c.erase, n - ab)) {
      this.setWord(num(b.slice(n - ab)), 0); this.buffer = '';
    } else if (n > ab + db && match(b, c.write, n - ab - db)) {
      this.setWord(num(b.slice(n - db - ab, n - db)), num(b.slice(n - db))); this.buffer = '';
    } else if (match(b, c.lock, n)) { this.locked = 1; this.buffer = ''; }
    else if (match(b, c.unlock, n)) { this.locked = 0; this.buffer = ''; }
  }
}
