// Zilog Z80 core: the full documented instruction set plus the undocumented
// parts arcade code relies on (IXH/IXL/IYH/IYL, SLL, DDCB/FDCB register
// copies, flag bits 3 and 5). Cycle counts are in T-states.
//
// The host supplies memory and I/O callbacks:
//   read(addr) -> byte, write(addr, byte), in(port) -> byte, out(port, byte)
// and drives interrupts with `irq` (level, held until the host clears it) and
// nmi() (edge, latched until taken).

import { capture, apply } from './state.js';

const FC = 0x01, FN = 0x02, FP = 0x04, FX = 0x08, FH = 0x10, FY = 0x20, FZ = 0x40, FS = 0x80;

// Sign, zero and the undocumented 3/5 bits of a result; plus parity.
const SZ = new Uint8Array(256), SZP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SZ[i] = (i & (FS | FX | FY)) | (i === 0 ? FZ : 0);
  let p = i; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
  SZP[i] = SZ[i] | ((p & 1) ? 0 : FP);
}

// Base T-states for unprefixed opcodes (conditional jumps/calls/returns use the
// not-taken figure; the extra cycles are added when the branch is taken).
const CYC = [
  4, 10, 7, 6, 4, 4, 7, 4, 4, 11, 7, 6, 4, 4, 7, 4,
  8, 10, 7, 6, 4, 4, 7, 4, 12, 11, 7, 6, 4, 4, 7, 4,
  7, 10, 16, 6, 4, 4, 7, 4, 7, 11, 16, 6, 4, 4, 7, 4,
  7, 10, 13, 6, 11, 11, 10, 4, 7, 11, 13, 6, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  7, 7, 7, 7, 7, 7, 4, 7, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  4, 4, 4, 4, 4, 4, 7, 4, 4, 4, 4, 4, 4, 4, 7, 4,
  5, 10, 10, 10, 10, 11, 7, 11, 5, 10, 10, 0, 10, 17, 7, 11,
  5, 10, 10, 11, 10, 11, 7, 11, 5, 4, 10, 11, 10, 0, 7, 11,
  5, 10, 10, 19, 10, 11, 7, 11, 5, 4, 10, 4, 10, 0, 7, 11,
  5, 10, 10, 4, 10, 11, 7, 11, 5, 6, 10, 4, 10, 0, 7, 11,
];

const Z_STATE = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a_', 'f_', 'b_', 'c_', 'd_', 'e_', 'h_', 'l_', 'ix', 'iy', 'sp', 'pc', 'i', 'r', 'iff1', 'iff2', 'im', 'halted', 'eiDelay', 'irq', 'irqVector', 'nmiPending', 'cycles'];

export class Z80 {
  // Save states: everything that changes while running (not ROM-derived data).
  saveState() { return capture(this, Z_STATE); }
  loadState(s) { apply(this, Z_STATE, s); }

  // opRead (optional): reads opcode fetches separately from data, for boards
  // that patch or decrypt only the instruction stream.
  constructor({ read, write, input = () => 0xFF, output = () => {}, opRead = null }) {
    this.read = read;
    this.opRead = opRead;
    this.write = write;
    this.input = input;
    this.output = output;
    this.onIrqAck = null;     // called when an IRQ is taken (for 'hold until acknowledged' lines)
    this.onReti = null;       // called on RETI (Z80 peripherals watch for it to end an interrupt)
    this.reset();
  }

  reset() {
    this.a = 0xFF; this.f = 0xFF;
    this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    this.a_ = 0; this.f_ = 0; this.b_ = 0; this.c_ = 0; this.d_ = 0; this.e_ = 0; this.h_ = 0; this.l_ = 0;
    this.ix = 0xFFFF; this.iy = 0xFFFF;
    this.sp = 0xFFFF; this.pc = 0;
    this.i = 0; this.r = 0;
    this.iff1 = 0; this.iff2 = 0; this.im = 0;
    this.halted = false;
    this.eiDelay = false;     // interrupts stay off for one instruction after EI
    this.irq = false;         // level-sensitive maskable interrupt line
    this.irqVector = 0xFF;    // data bus value during an IM 0/2 acknowledge
    this.nmiPending = false;
    this.cycles = 0;          // T-states executed since construction
  }

  nmi() { this.nmiPending = true; }

  // Run at least `n` T-states; returns how many were actually run.
  run(n) {
    const start = this.cycles, end = start + n;
    while (this.cycles < end) this.step();
    return this.cycles - start;
  }

  step() {
    if (this.nmiPending) {
      this.nmiPending = false;
      this.wake();
      this.iff2 = this.iff1; this.iff1 = 0;
      this.push(this.pc); this.pc = 0x66;
      this.cycles += 11;
      return;
    }
    if (this.irq && this.iff1 && !this.eiDelay) {
      this.wake();
      this.iff1 = this.iff2 = 0;
      if (this.onIrqAck) this.onIrqAck();
      if (this.im === 2) {
        this.push(this.pc);
        const v = (this.i << 8) | this.irqVector;
        this.pc = this.read(v) | (this.read((v + 1) & 0xFFFF) << 8);
        this.cycles += 19;
      } else {
        // IM 0 executes the instruction on the bus; arcade boards put RST 38h
        // (0xFF) there, which is also what IM 1 does.
        this.push(this.pc);
        this.pc = this.im === 0 ? (this.irqVector & 0x38) : 0x38;
        this.cycles += 13;
      }
      return;
    }
    this.eiDelay = false;
    if (this.halted) { this.cycles += 4; this.incR(); return; }
    this.opPc = this.pc;      // where the current instruction starts (some protection checks key on it)
    const op = this.opRead ? this.opRead(this.pc) : this.read(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    this.incR();
    this.exec(op, 0);
  }

  wake() { if (this.halted) { this.halted = false; this.pc = (this.pc + 1) & 0xFFFF; } }
  incR() { this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F); }

  // ---------------------------------------------------------------- helpers

  fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  // An opcode byte after a prefix (an M1 cycle, like the first).
  fetchOp() { const v = this.opRead ? this.opRead(this.pc) : this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  fetchD() { const d = this.fetch(); return d < 128 ? d : d - 256; }
  read16(a) { return this.read(a) | (this.read((a + 1) & 0xFFFF) << 8); }
  write16(a, v) { this.write(a, v & 0xFF); this.write((a + 1) & 0xFFFF, v >> 8); }
  push(v) { this.sp = (this.sp - 2) & 0xFFFF; this.write16(this.sp, v); }
  pop() { const v = this.read16(this.sp); this.sp = (this.sp + 2) & 0xFFFF; return v; }

  get bc() { return (this.b << 8) | this.c; } set bc(v) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
  get de() { return (this.d << 8) | this.e; } set de(v) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }
  get hl() { return (this.h << 8) | this.l; } set hl(v) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }
  get af() { return (this.a << 8) | this.f; } set af(v) { this.a = (v >> 8) & 0xFF; this.f = v & 0xFF; }

  // HL, IX or IY depending on the prefix (x: 0 none, 1 DD, 2 FD).
  getXY(x) { return x === 0 ? this.hl : x === 1 ? this.ix : this.iy; }
  setXY(x, v) { v &= 0xFFFF; if (x === 0) this.hl = v; else if (x === 1) this.ix = v; else this.iy = v; }

  // 8-bit register by its 3-bit code; with a prefix, H and L become the halves
  // of IX/IY (only when the instruction has no (HL) operand: callers pass x=0).
  getR(r, x) {
    switch (r) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return x === 0 ? this.h : x === 1 ? this.ix >> 8 : this.iy >> 8;
      case 5: return x === 0 ? this.l : x === 1 ? this.ix & 0xFF : this.iy & 0xFF;
      case 7: return this.a;
    }
    return 0;
  }
  setR(r, x, v) {
    switch (r) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: if (x === 0) this.h = v; else if (x === 1) this.ix = (this.ix & 0xFF) | (v << 8); else this.iy = (this.iy & 0xFF) | (v << 8); break;
      case 5: if (x === 0) this.l = v; else if (x === 1) this.ix = (this.ix & 0xFF00) | v; else this.iy = (this.iy & 0xFF00) | v; break;
      case 7: this.a = v; break;
    }
  }

  // Address of the (HL) / (IX+d) / (IY+d) operand; fetches d when prefixed.
  memAddr(x) { return x === 0 ? this.hl : (this.getXY(x) + this.fetchD()) & 0xFFFF; }

  cond(cc) {
    const f = this.f;
    switch (cc) {
      case 0: return !(f & FZ); case 1: return !!(f & FZ);
      case 2: return !(f & FC); case 3: return !!(f & FC);
      case 4: return !(f & FP); case 5: return !!(f & FP);
      case 6: return !(f & FS); default: return !!(f & FS);
    }
  }

  // ---------------------------------------------------------------- ALU

  add8(v, c) {
    const a = this.a, r = a + v + c;
    this.f = SZ[r & 0xFF] | ((r >> 8) & FC) | ((a ^ v ^ r) & FH) | (((a ^ ~v) & (a ^ r) & 0x80) ? FP : 0);
    this.a = r & 0xFF;
  }
  sub8(v, c, store = true) {
    const a = this.a, r = a - v - c, rr = r & 0x1FF;
    this.f = (SZ[r & 0xFF] & ~(store ? 0 : FX | FY)) | FN | (rr & 0x100 ? FC : 0) | ((a ^ v ^ rr) & FH) |
      (((a ^ v) & (a ^ rr) & 0x80) ? FP : 0) | (store ? 0 : v & (FX | FY));
    if (store) this.a = r & 0xFF;
  }
  alu(op, v) {
    switch (op) {
      case 0: this.add8(v, 0); break;
      case 1: this.add8(v, this.f & FC); break;
      case 2: this.sub8(v, 0); break;
      case 3: this.sub8(v, this.f & FC); break;
      case 4: this.a &= v; this.f = SZP[this.a] | FH; break;
      case 5: this.a ^= v; this.f = SZP[this.a]; break;
      case 6: this.a |= v; this.f = SZP[this.a]; break;
      case 7: this.sub8(v, 0, false); break;
    }
  }
  inc8(v) {
    const r = (v + 1) & 0xFF;
    this.f = (this.f & FC) | SZ[r] | ((v & 0xF) === 0xF ? FH : 0) | (v === 0x7F ? FP : 0);
    return r;
  }
  dec8(v) {
    const r = (v - 1) & 0xFF;
    this.f = (this.f & FC) | FN | SZ[r] | ((v & 0xF) === 0 ? FH : 0) | (v === 0x80 ? FP : 0);
    return r;
  }
  add16(a, b) {
    const r = a + b;
    this.f = (this.f & (FS | FZ | FP)) | ((r >> 16) & FC) | (((a ^ b ^ r) >> 8) & FH) | ((r >> 8) & (FX | FY));
    return r & 0xFFFF;
  }
  adc16(v) {
    const hl = this.hl, r = hl + v + (this.f & FC);
    this.f = ((r >> 8) & (FS | FX | FY)) | ((r & 0xFFFF) ? 0 : FZ) | ((r >> 16) & FC) |
      (((hl ^ v ^ r) >> 8) & FH) | (((hl ^ ~v) & (hl ^ r) & 0x8000) ? FP : 0);
    this.hl = r & 0xFFFF;
  }
  sbc16(v) {
    const hl = this.hl, r = (hl - v - (this.f & FC)) & 0x1FFFF;
    this.f = FN | ((r >> 8) & (FS | FX | FY)) | ((r & 0xFFFF) ? 0 : FZ) | (r & 0x10000 ? FC : 0) |
      (((hl ^ v ^ r) >> 8) & FH) | (((hl ^ v) & (hl ^ r) & 0x8000) ? FP : 0);
    this.hl = r & 0xFFFF;
  }
  // CB-prefix rotates and shifts.
  rot(op, v) {
    let r, c;
    switch (op) {
      case 0: c = v >> 7; r = ((v << 1) | c) & 0xFF; break;                 // RLC
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break;                    // RRC
      case 2: c = v >> 7; r = ((v << 1) | (this.f & FC)) & 0xFF; break;     // RL
      case 3: c = v & 1; r = (v >> 1) | ((this.f & FC) << 7); break;        // RR
      case 4: c = v >> 7; r = (v << 1) & 0xFF; break;                       // SLA
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;                  // SRA
      case 6: c = v >> 7; r = ((v << 1) | 1) & 0xFF; break;                 // SLL (undocumented)
      default: c = v & 1; r = v >> 1; break;                                // SRL
    }
    this.f = SZP[r] | c;
    return r;
  }
  bit(n, v, xy) {
    const r = v & (1 << n);
    this.f = (this.f & FC) | FH | (r ? 0 : FZ | FP) | (n === 7 && r ? FS : 0) | (xy & (FX | FY));
  }
  daa() {
    let a = this.a, corr = 0, c = this.f & FC;
    const h = this.f & FH, n = this.f & FN;
    if (h || (a & 0x0F) > 9) corr |= 0x06;
    if (c || a > 0x99) { corr |= 0x60; c = FC; }
    const r = (n ? a - corr : a + corr) & 0xFF;
    const hf = n ? (h && (a & 0x0F) < 6 ? FH : 0) : ((a & 0x0F) > 9 ? FH : 0);
    this.a = r;
    this.f = SZP[r] | c | n | hf;
  }

  // ---------------------------------------------------------------- execute

  exec(op, x) {
    this.cycles += CYC[op] + (x ? 4 : 0);
    switch (op) {
      case 0x00: return;                                                         // NOP
      case 0x08: { const a = this.a, f = this.f; this.a = this.a_; this.f = this.f_; this.a_ = a; this.f_ = f; return; }
      case 0x10: { this.b = (this.b - 1) & 0xFF; const d = this.fetchD(); if (this.b) { this.pc = (this.pc + d) & 0xFFFF; this.cycles += 5; } return; }
      case 0x18: { const d = this.fetchD(); this.pc = (this.pc + d) & 0xFFFF; return; }
      case 0x20: case 0x28: case 0x30: case 0x38: {
        const d = this.fetchD();
        if (this.cond((op >> 3) & 3)) { this.pc = (this.pc + d) & 0xFFFF; this.cycles += 5; }
        return;
      }
      case 0x01: this.bc = this.fetch16(); return;
      case 0x11: this.de = this.fetch16(); return;
      case 0x21: this.setXY(x, this.fetch16()); return;
      case 0x31: this.sp = this.fetch16(); return;
      case 0x09: this.setXY(x, this.add16(this.getXY(x), this.bc)); return;
      case 0x19: this.setXY(x, this.add16(this.getXY(x), this.de)); return;
      case 0x29: { const v = this.getXY(x); this.setXY(x, this.add16(v, v)); return; }
      case 0x39: this.setXY(x, this.add16(this.getXY(x), this.sp)); return;
      case 0x02: this.write(this.bc, this.a); return;
      case 0x12: this.write(this.de, this.a); return;
      case 0x0A: this.a = this.read(this.bc); return;
      case 0x1A: this.a = this.read(this.de); return;
      case 0x22: this.write16(this.fetch16(), this.getXY(x)); return;
      case 0x2A: this.setXY(x, this.read16(this.fetch16())); return;
      case 0x32: this.write(this.fetch16(), this.a); return;
      case 0x3A: this.a = this.read(this.fetch16()); return;
      case 0x03: this.bc = (this.bc + 1) & 0xFFFF; return;
      case 0x13: this.de = (this.de + 1) & 0xFFFF; return;
      case 0x23: this.setXY(x, this.getXY(x) + 1); return;
      case 0x33: this.sp = (this.sp + 1) & 0xFFFF; return;
      case 0x0B: this.bc = (this.bc - 1) & 0xFFFF; return;
      case 0x1B: this.de = (this.de - 1) & 0xFFFF; return;
      case 0x2B: this.setXY(x, this.getXY(x) - 1); return;
      case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; return;
      case 0x34: { const a = this.memAddr(x); if (x) this.cycles += 8; this.write(a, this.inc8(this.read(a))); return; }
      case 0x35: { const a = this.memAddr(x); if (x) this.cycles += 8; this.write(a, this.dec8(this.read(a))); return; }
      case 0x36: { const a = this.memAddr(x); if (x) this.cycles += 5; this.write(a, this.fetch()); return; }
      case 0x07: { const c = this.a >> 7; this.a = ((this.a << 1) | c) & 0xFF; this.f = (this.f & (FS | FZ | FP)) | (this.a & (FX | FY)) | c; return; }
      case 0x0F: { const c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = (this.f & (FS | FZ | FP)) | (this.a & (FX | FY)) | c; return; }
      case 0x17: { const c = this.a >> 7; this.a = ((this.a << 1) | (this.f & FC)) & 0xFF; this.f = (this.f & (FS | FZ | FP)) | (this.a & (FX | FY)) | c; return; }
      case 0x1F: { const c = this.a & 1; this.a = (this.a >> 1) | ((this.f & FC) << 7); this.f = (this.f & (FS | FZ | FP)) | (this.a & (FX | FY)) | c; return; }
      case 0x27: this.daa(); return;
      case 0x2F: this.a ^= 0xFF; this.f = (this.f & (FS | FZ | FP | FC)) | FH | FN | (this.a & (FX | FY)); return;
      case 0x37: this.f = (this.f & (FS | FZ | FP)) | FC | (this.a & (FX | FY)); return;
      case 0x3F: this.f = (this.f & (FS | FZ | FP)) | ((this.f & FC) ? FH : FC) | (this.a & (FX | FY)); return;
      case 0x76: this.halted = true; this.pc = (this.pc - 1) & 0xFFFF; return;   // HALT: sit on the opcode
      case 0xC3: this.pc = this.fetch16(); return;
      case 0xC9: this.pc = this.pop(); return;
      case 0xCD: { const a = this.fetch16(); this.push(this.pc); this.pc = a; return; }
      case 0xCB: return this.execCB(x);
      case 0xDD: this.incR(); return this.exec(this.fetchOp(), 1);
      case 0xFD: this.incR(); return this.exec(this.fetchOp(), 2);
      case 0xED: this.incR(); return this.execED(this.fetchOp());
      case 0xD3: this.output((this.a << 8) | this.fetch(), this.a); return;
      case 0xDB: this.a = this.input((this.a << 8) | this.fetch()); return;
      case 0xD9: {
        let t;
        t = this.b; this.b = this.b_; this.b_ = t; t = this.c; this.c = this.c_; this.c_ = t;
        t = this.d; this.d = this.d_; this.d_ = t; t = this.e; this.e = this.e_; this.e_ = t;
        t = this.h; this.h = this.h_; this.h_ = t; t = this.l; this.l = this.l_; this.l_ = t;
        return;
      }
      case 0xE3: { const v = this.read16(this.sp); this.write16(this.sp, this.getXY(x)); this.setXY(x, v); return; }
      case 0xE9: this.pc = this.getXY(x); return;
      case 0xEB: { const v = this.de; this.de = this.hl; this.hl = v; return; }
      case 0xF3: this.iff1 = this.iff2 = 0; return;
      case 0xFB: this.iff1 = this.iff2 = 1; this.eiDelay = true; return;
      case 0xF9: this.sp = this.getXY(x); return;
      case 0xC6: case 0xCE: case 0xD6: case 0xDE: case 0xE6: case 0xEE: case 0xF6: case 0xFE:
        this.alu((op >> 3) & 7, this.fetch()); return;
    }

    const hi = op >> 6, y = (op >> 3) & 7, z = op & 7;
    if (hi === 1) {                                           // LD r, r'
      if (z === 6) { const a = this.memAddr(x); if (x) this.cycles += 8; this.setR(y, 0, this.read(a)); }
      else if (y === 6) { const a = this.memAddr(x); if (x) this.cycles += 8; this.write(a, this.getR(z, 0)); }
      else this.setR(y, x, this.getR(z, x));
      return;
    }
    if (hi === 2) {                                           // ALU A, r
      if (z === 6) { const a = this.memAddr(x); if (x) this.cycles += 8; this.alu(y, this.read(a)); }
      else this.alu(y, this.getR(z, x));
      return;
    }
    if (hi === 0) {
      if (z === 4) { this.setR(y, x, this.inc8(this.getR(y, x))); return; }          // INC r
      if (z === 5) { this.setR(y, x, this.dec8(this.getR(y, x))); return; }          // DEC r
      if (z === 6) { this.setR(y, x, this.fetch()); return; }                        // LD r, n
    }
    if (hi === 3) {
      switch (z) {
        case 0: if (this.cond(y)) { this.pc = this.pop(); this.cycles += 6; } return;   // RET cc
        case 1: {                                                                       // POP
          const v = this.pop();
          if (y === 0) this.bc = v; else if (y === 2) this.de = v; else if (y === 4) this.setXY(x, v); else this.af = v;
          return;
        }
        case 2: { const a = this.fetch16(); if (this.cond(y)) this.pc = a; return; }    // JP cc
        case 4: { const a = this.fetch16(); if (this.cond(y)) { this.push(this.pc); this.pc = a; this.cycles += 7; } return; }
        case 5: this.push(y === 0 ? this.bc : y === 2 ? this.de : y === 4 ? this.getXY(x) : this.af); return;  // PUSH
        case 7: this.push(this.pc); this.pc = y << 3; return;                           // RST
      }
    }
  }

  execCB(x) {
    // With a prefix the displacement comes before the opcode: DD CB d op.
    let addr;
    if (x) addr = (this.getXY(x) + this.fetchD()) & 0xFFFF;
    const op = x ? this.fetch() : this.fetchOp();
    if (!x) { this.incR(); this.cycles += 4; }
    const y = (op >> 3) & 7, z = op & 7, kind = op >> 6;
    if (x || z === 6) {
      if (!x) addr = this.hl;
      const v = this.read(addr);
      if (kind === 1) { this.bit(y, v, addr >> 8); this.cycles += x ? 16 : 8; return; }
      const r = kind === 0 ? this.rot(y, v) : kind === 2 ? v & ~(1 << y) : v | (1 << y);
      this.write(addr, r);
      if (x && z !== 6) this.setR(z, 0, r);                   // undocumented register copy
      this.cycles += x ? 19 : 11;
      return;
    }
    const v = this.getR(z, 0);
    this.cycles += 4;
    if (kind === 0) this.setR(z, 0, this.rot(y, v));
    else if (kind === 1) this.bit(y, v, v);
    else if (kind === 2) this.setR(z, 0, v & ~(1 << y));
    else this.setR(z, 0, v | (1 << y));
  }

  execED(op) {
    const y = (op >> 3) & 7, z = op & 7;
    if (op >= 0x40 && op < 0x80) {
      switch (z) {
        case 0: { const v = this.input(this.bc); if (y !== 6) this.setR(y, 0, v); this.f = (this.f & FC) | SZP[v]; this.cycles += 12; return; }
        case 1: this.output(this.bc, y === 6 ? 0 : this.getR(y, 0)); this.cycles += 12; return;
        case 2: {
          const v = [this.bc, this.de, this.hl, this.sp][y >> 1];
          if (y & 1) this.adc16(v); else this.sbc16(v);
          this.cycles += 15; return;
        }
        case 3: {
          const a = this.fetch16();
          if (y & 1) { const v = this.read16(a); if (y === 1) this.bc = v; else if (y === 3) this.de = v; else if (y === 5) this.hl = v; else this.sp = v; }
          else this.write16(a, [this.bc, this.de, this.hl, this.sp][y >> 1]);
          this.cycles += 20; return;
        }
        case 4: { const a = this.a; this.a = 0; this.sub8(a, 0); this.cycles += 8; return; }       // NEG
        case 5:                                                                                  // RETN / RETI
          this.iff1 = this.iff2; this.pc = this.pop(); this.cycles += 14;
          if (y === 1 && this.onReti) this.onReti();
          return;
        case 6: this.im = [0, 0, 1, 2, 0, 0, 1, 2][y]; this.cycles += 8; return;
        case 7:
          switch (y) {
            case 0: this.i = this.a; this.cycles += 9; return;
            case 1: this.r = this.a; this.cycles += 9; return;
            case 2: this.a = this.i; this.f = (this.f & FC) | SZ[this.a] | (this.iff2 ? FP : 0); this.cycles += 9; return;
            case 3: this.a = this.r; this.f = (this.f & FC) | SZ[this.a] | (this.iff2 ? FP : 0); this.cycles += 9; return;
            case 4: {                                                                              // RRD
              const m = this.read(this.hl);
              this.write(this.hl, ((this.a << 4) | (m >> 4)) & 0xFF);
              this.a = (this.a & 0xF0) | (m & 0x0F);
              this.f = (this.f & FC) | SZP[this.a]; this.cycles += 18; return;
            }
            case 5: {                                                                              // RLD
              const m = this.read(this.hl);
              this.write(this.hl, ((m << 4) | (this.a & 0x0F)) & 0xFF);
              this.a = (this.a & 0xF0) | (m >> 4);
              this.f = (this.f & FC) | SZP[this.a]; this.cycles += 18; return;
            }
            default: this.cycles += 8; return;
          }
      }
    }
    if (op >= 0xA0 && op <= 0xBB && z <= 3 && y >= 4) {
      const dec = y & 1, repeat = y >= 6, step = dec ? -1 : 1;
      switch (z) {
        case 0: {                                                     // LDI/LDD/LDIR/LDDR
          const v = this.read(this.hl);
          this.write(this.de, v);
          this.hl = (this.hl + step) & 0xFFFF; this.de = (this.de + step) & 0xFFFF; this.bc = (this.bc - 1) & 0xFFFF;
          const n = (v + this.a) & 0xFF;
          this.f = (this.f & (FS | FZ | FC)) | (this.bc ? FP : 0) | (n & FX) | ((n << 4) & FY);
          if (repeat && this.bc) { this.pc = (this.pc - 2) & 0xFFFF; this.cycles += 21; } else this.cycles += 16;
          return;
        }
        case 1: {                                                     // CPI/CPD/CPIR/CPDR
          const v = this.read(this.hl), r = (this.a - v) & 0xFF;
          this.hl = (this.hl + step) & 0xFFFF; this.bc = (this.bc - 1) & 0xFFFF;
          const hf = (this.a ^ v ^ r) & FH, n = (r - (hf ? 1 : 0)) & 0xFF;
          this.f = (this.f & FC) | FN | (SZ[r] & (FS | FZ)) | hf | (this.bc ? FP : 0) | (n & FX) | ((n << 4) & FY);
          if (repeat && this.bc && r) { this.pc = (this.pc - 2) & 0xFFFF; this.cycles += 21; } else this.cycles += 16;
          return;
        }
        case 2: {                                                     // INI/IND/INIR/INDR
          const v = this.input(this.bc);
          this.write(this.hl, v);
          this.hl = (this.hl + step) & 0xFFFF; this.b = (this.b - 1) & 0xFF;
          this.f = (SZ[this.b] & ~FP) | FN | (this.b ? 0 : 0);
          if (repeat && this.b) { this.pc = (this.pc - 2) & 0xFFFF; this.cycles += 21; } else this.cycles += 16;
          return;
        }
        case 3: {                                                     // OUTI/OUTD/OTIR/OTDR
          const v = this.read(this.hl);
          this.b = (this.b - 1) & 0xFF;
          this.output(this.bc, v);
          this.hl = (this.hl + step) & 0xFFFF;
          this.f = SZ[this.b] | FN;
          if (repeat && this.b) { this.pc = (this.pc - 2) & 0xFFFF; this.cycles += 21; } else this.cycles += 16;
          return;
        }
      }
    }
    this.cycles += 8;                                                 // undefined ED opcodes act as NOPs
  }
}
