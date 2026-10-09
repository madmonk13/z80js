// Motorola 6809 CPU: accumulators A and B (together D), index registers X and
// Y, stack pointers U and S, the direct page register DP and the condition
// codes E F H I N Z V C. Covers the documented instruction set (pages 1-3),
// all addressing modes including indexed/indirect, and NMI, FIRQ and IRQ.
// Cycle counts follow the datasheet closely enough for arcade timing.

import { capture, apply } from './state.js';

const C = 0x01, V = 0x02, Z = 0x04, N = 0x08, I = 0x10, H = 0x20, F = 0x40, E = 0x80;
const STATE = ['a', 'b', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc', 'cycles', 'irq', 'firq', 'nmiPending', 'nmiArmed', 'waiting', 'cwai'];

export class M6809 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor({ read, write }) {
    this.read = read;
    this.write = write;
    this.cycles = 0;
    this.reset();
  }

  reset() {
    this.a = this.b = 0; this.x = this.y = this.u = this.s = 0; this.dp = 0;
    this.cc = I | F;
    this.irq = false; this.firq = false;
    this.nmiPending = false; this.nmiArmed = false;   // NMI is ignored until S has been loaded
    this.waiting = false; this.cwai = false;
    this.pc = this.read16(0xFFFE);
  }

  nmi() { if (this.nmiArmed) this.nmiPending = true; }

  get d() { return (this.a << 8) | this.b; }
  set d(v) { this.a = (v >> 8) & 0xFF; this.b = v & 0xFF; }

  read16(a) { return (this.read(a & 0xFFFF) << 8) | this.read((a + 1) & 0xFFFF); }
  write16(a, v) { this.write(a & 0xFFFF, (v >> 8) & 0xFF); this.write((a + 1) & 0xFFFF, v & 0xFF); }
  fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const v = this.read16(this.pc); this.pc = (this.pc + 2) & 0xFFFF; return v; }

  pushS(v) { this.s = (this.s - 1) & 0xFFFF; this.write(this.s, v & 0xFF); }
  pushS16(v) { this.pushS(v); this.pushS(v >> 8); }
  pullS() { const v = this.read(this.s); this.s = (this.s + 1) & 0xFFFF; return v; }
  pullS16() { return (this.pullS() << 8) | this.pullS(); }
  pushU(v) { this.u = (this.u - 1) & 0xFFFF; this.write(this.u, v & 0xFF); }
  pullU() { const v = this.read(this.u); this.u = (this.u + 1) & 0xFFFF; return v; }

  run(n) {
    const start = this.cycles, end = start + n;
    while (this.cycles < end) this.step();
    return this.cycles - start;
  }

  // Push the whole machine state (E set) for NMI, IRQ, SWI and CWAI.
  pushAll() {
    this.pushS16(this.pc); this.pushS16(this.u); this.pushS16(this.y); this.pushS16(this.x);
    this.pushS(this.dp); this.pushS(this.b); this.pushS(this.a); this.pushS(this.cc);
  }

  interrupt() {
    if (this.nmiPending) {
      this.nmiPending = false;
      if (!this.cwai) { this.cc |= E; this.pushAll(); }
      this.cc |= I | F;
      this.pc = this.read16(0xFFFC);
      this.waiting = this.cwai = false;
      this.cycles += 19;
      return true;
    }
    if (this.firq && !(this.cc & F)) {
      if (!this.cwai) { this.cc &= ~E; this.pushS16(this.pc); this.pushS(this.cc); }
      this.cc |= I | F;
      this.pc = this.read16(0xFFF6);
      this.waiting = this.cwai = false;
      this.cycles += 10;
      return true;
    }
    if (this.irq && !(this.cc & I)) {
      if (!this.cwai) { this.cc |= E; this.pushAll(); }
      this.cc |= I;
      this.pc = this.read16(0xFFF8);
      this.waiting = this.cwai = false;
      this.cycles += 19;
      return true;
    }
    return false;
  }

  step() {
    if (this.nmiPending || this.irq || this.firq) {
      if (this.interrupt()) return;
      if (this.waiting && (this.irq || this.firq)) this.waiting = false;   // SYNC ends on any interrupt line
    }
    if (this.waiting) { this.cycles += 4; return; }
    this.exec(this.fetch());
  }

  // ---------------------------------------------------------------- flags

  nz8(v) { this.cc = (this.cc & ~(N | Z)) | (v & 0x80 ? N : 0) | ((v & 0xFF) ? 0 : Z); }
  nz16(v) { this.cc = (this.cc & ~(N | Z)) | (v & 0x8000 ? N : 0) | ((v & 0xFFFF) ? 0 : Z); }

  add8(a, b, carry = 0) {
    const r = a + b + carry;
    this.cc = (this.cc & ~(H | N | Z | V | C)) | ((a ^ b ^ r) & 0x10 ? H : 0) | (r & 0x80 ? N : 0)
      | ((r & 0xFF) ? 0 : Z) | ((~(a ^ b) & (a ^ r) & 0x80) ? V : 0) | (r & 0x100 ? C : 0);
    return r & 0xFF;
  }
  sub8(a, b, carry = 0) {
    const r = a - b - carry;
    this.cc = (this.cc & ~(N | Z | V | C)) | (r & 0x80 ? N : 0) | ((r & 0xFF) ? 0 : Z)
      | (((a ^ b) & (a ^ r) & 0x80) ? V : 0) | (r & 0x100 ? C : 0);
    return r & 0xFF;
  }
  add16(a, b) {
    const r = a + b;
    this.cc = (this.cc & ~(N | Z | V | C)) | (r & 0x8000 ? N : 0) | ((r & 0xFFFF) ? 0 : Z)
      | ((~(a ^ b) & (a ^ r) & 0x8000) ? V : 0) | (r & 0x10000 ? C : 0);
    return r & 0xFFFF;
  }
  sub16(a, b) {
    const r = a - b;
    this.cc = (this.cc & ~(N | Z | V | C)) | (r & 0x8000 ? N : 0) | ((r & 0xFFFF) ? 0 : Z)
      | (((a ^ b) & (a ^ r) & 0x8000) ? V : 0) | (r & 0x10000 ? C : 0);
    return r & 0xFFFF;
  }
  logic8(v) { this.cc &= ~V; this.nz8(v); return v & 0xFF; }

  // ---------------------------------------------------------------- addressing

  direct() { return (this.dp << 8) | this.fetch(); }
  extended() { return this.fetch16(); }

  indexReg(n) { return [this.x, this.y, this.u, this.s][n]; }
  setIndexReg(n, v) {
    v &= 0xFFFF;
    if (n === 0) this.x = v; else if (n === 1) this.y = v; else if (n === 2) this.u = v; else this.s = v;
  }

  // Indexed addressing: returns the effective address (and adds cycles).
  indexed() {
    const post = this.fetch(), r = (post >> 5) & 3;
    let ea;
    if (!(post & 0x80)) {                     // 5-bit offset
      const off = post & 0x10 ? (post & 0x1F) - 32 : post & 0x1F;
      this.cycles += 1;
      return (this.indexReg(r) + off) & 0xFFFF;
    }
    switch (post & 0x0F) {
      case 0x0: ea = this.indexReg(r); this.setIndexReg(r, ea + 1); this.cycles += 2; break;     // ,R+
      case 0x1: ea = this.indexReg(r); this.setIndexReg(r, ea + 2); this.cycles += 3; break;     // ,R++
      case 0x2: this.setIndexReg(r, this.indexReg(r) - 1); ea = this.indexReg(r); this.cycles += 2; break;   // ,-R
      case 0x3: this.setIndexReg(r, this.indexReg(r) - 2); ea = this.indexReg(r); this.cycles += 3; break;   // ,--R
      case 0x4: ea = this.indexReg(r); break;                                                    // ,R
      case 0x5: ea = this.indexReg(r) + ((this.b ^ 0x80) - 0x80); this.cycles += 1; break;       // B,R
      case 0x6: ea = this.indexReg(r) + ((this.a ^ 0x80) - 0x80); this.cycles += 1; break;       // A,R
      case 0x8: { const o = this.fetch(); ea = this.indexReg(r) + ((o ^ 0x80) - 0x80); this.cycles += 1; break; }   // n8,R
      case 0x9: ea = this.indexReg(r) + ((this.fetch16() ^ 0x8000) - 0x8000); this.cycles += 4; break;              // n16,R
      case 0xB: ea = this.indexReg(r) + ((this.d ^ 0x8000) - 0x8000); this.cycles += 4; break;   // D,R
      case 0xC: { const o = this.fetch(); ea = this.pc + ((o ^ 0x80) - 0x80); this.cycles += 1; break; }   // n8,PC
      case 0xD: { const o = this.fetch16(); ea = this.pc + ((o ^ 0x8000) - 0x8000); this.cycles += 5; break; }   // n16,PC
      case 0xF: ea = this.fetch16(); this.cycles += 2; break;                                    // [n16]
      default: ea = this.indexReg(r);
    }
    ea &= 0xFFFF;
    if (post & 0x10) { ea = this.read16(ea); this.cycles += 3; }   // indirect
    return ea;
  }

  // Effective address for an opcode's mode nibble: 0x9x/0xDx direct,
  // 0xAx/0xEx indexed, 0xBx/0xFx extended (and the 0x0x/0x6x/0x7x group).
  ea(mode) {
    if (mode === 1) { this.cycles += 4; return this.direct(); }
    if (mode === 2) { this.cycles += 4; return this.indexed(); }
    this.cycles += 5; return this.extended();
  }

  // ---------------------------------------------------------------- execution

  // The 0x00-0x0F / 0x40-0x7F read-modify-write group.
  rmw(op, v) {
    switch (op) {
      case 0x0: { const r = (-v) & 0xFF; this.cc = (this.cc & ~(N | Z | V | C)) | (r & 0x80 ? N : 0) | (r ? C : 0) | (r ? 0 : Z) | (v === 0x80 ? V : 0); return r; }   // NEG
      case 0x3: { const r = (~v) & 0xFF; this.cc = (this.cc & ~(V)) | C; this.nz8(r); return r; }                     // COM
      case 0x4: { const r = v >> 1; this.cc = (this.cc & ~(N | Z | C)) | (v & 1 ? C : 0) | (r ? 0 : Z); return r; }   // LSR
      case 0x6: { const r = (v >> 1) | (this.cc & C ? 0x80 : 0); this.cc = (this.cc & ~C) | (v & 1 ? C : 0); this.nz8(r); return r; }   // ROR
      case 0x7: { const r = (v >> 1) | (v & 0x80); this.cc = (this.cc & ~C) | (v & 1 ? C : 0); this.nz8(r); return r; }   // ASR
      case 0x8: { const r = (v << 1) & 0xFF; this.cc = (this.cc & ~(V | C)) | (v & 0x80 ? C : 0) | (((v ^ (v << 1)) & 0x80) ? V : 0); this.nz8(r); return r; }   // ASL
      case 0x9: { const r = ((v << 1) | (this.cc & C)) & 0xFF; this.cc = (this.cc & ~(V | C)) | (v & 0x80 ? C : 0) | (((v ^ (v << 1)) & 0x80) ? V : 0); this.nz8(r); return r; }   // ROL
      case 0xA: { const r = (v - 1) & 0xFF; this.cc = (this.cc & ~V) | (v === 0x80 ? V : 0); this.nz8(r); return r; }   // DEC
      case 0xC: { const r = (v + 1) & 0xFF; this.cc = (this.cc & ~V) | (v === 0x7F ? V : 0); this.nz8(r); return r; }   // INC
      case 0xD: this.cc &= ~V; this.nz8(v); return null;                                          // TST
      case 0xF: this.cc = (this.cc & ~(N | V | C)) | Z; return 0;                                  // CLR
    }
    return null;                                                                                   // illegal: no change
  }

  branch(cond, long) {
    const off = long ? ((this.fetch16() ^ 0x8000) - 0x8000) : ((this.fetch() ^ 0x80) - 0x80);
    if (cond) { this.pc = (this.pc + off) & 0xFFFF; if (long) this.cycles += 1; }
    this.cycles += long ? 5 : 3;
  }

  cond(n) {
    const cc = this.cc, c = cc & C, z = cc & Z, nn = !!(cc & N), v = !!(cc & V);
    switch (n) {
      case 0x0: return true; case 0x1: return false;
      case 0x2: return !c && !z; case 0x3: return !!(c || z);
      case 0x4: return !c; case 0x5: return !!c;
      case 0x6: return !z; case 0x7: return !!z;
      case 0x8: return !v; case 0x9: return v;
      case 0xA: return !nn; case 0xB: return nn;
      case 0xC: return nn === v; case 0xD: return nn !== v;
      case 0xE: return !z && nn === v; default: return !!z || nn !== v;
    }
  }

  // Register numbers for TFR/EXG.
  getReg(n) {
    switch (n) {
      case 0: return this.d; case 1: return this.x; case 2: return this.y; case 3: return this.u;
      case 4: return this.s; case 5: return this.pc; case 8: return this.a; case 9: return this.b;
      case 10: return this.cc; case 11: return this.dp; default: return 0xFF;
    }
  }
  setReg(n, v) {
    switch (n) {
      case 0: this.d = v & 0xFFFF; break; case 1: this.x = v & 0xFFFF; break; case 2: this.y = v & 0xFFFF; break;
      case 3: this.u = v & 0xFFFF; break; case 4: this.s = v & 0xFFFF; this.nmiArmed = true; break;
      case 5: this.pc = v & 0xFFFF; break;
      case 8: this.a = v & 0xFF; break; case 9: this.b = v & 0xFF; break;
      case 10: this.cc = v & 0xFF; break; case 11: this.dp = v & 0xFF; break;
    }
  }

  pshs(mask, user) {
    const push = user ? (v) => this.pushU(v) : (v) => this.pushS(v);
    const push16 = (v) => { push(v); push(v >> 8); };
    if (mask & 0x80) { push16(this.pc); this.cycles += 2; }
    if (mask & 0x40) { push16(user ? this.s : this.u); this.cycles += 2; }
    if (mask & 0x20) { push16(this.y); this.cycles += 2; }
    if (mask & 0x10) { push16(this.x); this.cycles += 2; }
    if (mask & 0x08) { push(this.dp); this.cycles += 1; }
    if (mask & 0x04) { push(this.b); this.cycles += 1; }
    if (mask & 0x02) { push(this.a); this.cycles += 1; }
    if (mask & 0x01) { push(this.cc); this.cycles += 1; }
  }
  puls(mask, user) {
    const pull = user ? () => this.pullU() : () => this.pullS();
    const pull16 = () => (pull() << 8) | pull();
    if (mask & 0x01) { this.cc = pull(); this.cycles += 1; }
    if (mask & 0x02) { this.a = pull(); this.cycles += 1; }
    if (mask & 0x04) { this.b = pull(); this.cycles += 1; }
    if (mask & 0x08) { this.dp = pull(); this.cycles += 1; }
    if (mask & 0x10) { this.x = pull16(); this.cycles += 2; }
    if (mask & 0x20) { this.y = pull16(); this.cycles += 2; }
    if (mask & 0x40) { if (user) { this.s = pull16(); this.nmiArmed = true; } else this.u = pull16(); this.cycles += 2; }
    if (mask & 0x80) { this.pc = pull16(); this.cycles += 2; }
  }

  exec(op) {
    const hi = op >> 4, lo = op & 0x0F;

    // Read-modify-write group: 0x0x direct, 0x4x A, 0x5x B, 0x6x indexed, 0x7x extended.
    if (hi === 0x0 || (hi >= 0x4 && hi <= 0x7)) {
      if (lo === 0xE) {                                         // JMP
        if (hi === 0x4 || hi === 0x5) { this.cycles += 2; return; }
        this.pc = hi === 0x0 ? this.direct() : hi === 0x6 ? this.indexed() : this.extended();
        this.cycles += hi === 0x7 ? 4 : 3;
        return;
      }
      if (hi === 0x4 || hi === 0x5) {
        const r = this.rmw(lo, hi === 0x4 ? this.a : this.b);
        if (r !== null) { if (hi === 0x4) this.a = r; else this.b = r; }
        this.cycles += 2;
        return;
      }
      const ea = hi === 0x0 ? this.direct() : hi === 0x6 ? this.indexed() : this.extended();
      const r = this.rmw(lo, this.read(ea));
      if (r !== null) this.write(ea, r);
      this.cycles += hi === 0x7 ? 7 : 6;
      return;
    }

    switch (op) {
      case 0x10: return this.page2(this.fetch());
      case 0x11: return this.page3(this.fetch());
      case 0x12: this.cycles += 2; return;                              // NOP
      case 0x13: this.waiting = true; this.cycles += 4; return;         // SYNC
      case 0x16: { const o = this.fetch16(); this.pc = (this.pc + o) & 0xFFFF; this.cycles += 5; return; }   // LBRA
      case 0x17: { const o = this.fetch16(); this.pushS16(this.pc); this.pc = (this.pc + o) & 0xFFFF; this.cycles += 9; return; }   // LBSR
      case 0x19: {                                                       // DAA
        let corr = 0, c = this.cc & C;
        const lsn = this.a & 0x0F, msn = this.a >> 4;
        if ((this.cc & H) || lsn > 9) corr |= 0x06;
        if (c || msn > 9 || (msn > 8 && lsn > 9)) { corr |= 0x60; c = C; }
        const r = this.a + corr;
        this.a = r & 0xFF;
        this.cc = (this.cc & ~(C | V)) | c | (r & 0x100 ? C : 0);
        this.nz8(this.a);
        this.cycles += 2; return;
      }
      case 0x1A: this.cc |= this.fetch(); this.cycles += 3; return;      // ORCC
      case 0x1C: this.cc &= this.fetch(); this.cycles += 3; return;      // ANDCC
      case 0x1D: this.a = this.b & 0x80 ? 0xFF : 0; this.nz16(this.d); this.cycles += 2; return;   // SEX
      case 0x1E: {                                                       // EXG
        const p = this.fetch(), r1 = p >> 4, r2 = p & 15, v1 = this.getReg(r1), v2 = this.getReg(r2);
        this.setReg(r1, v2); this.setReg(r2, v1); this.cycles += 8; return;
      }
      case 0x1F: { const p = this.fetch(); this.setReg(p & 15, this.getReg(p >> 4)); this.cycles += 6; return; }   // TFR
      case 0x30: this.x = this.indexed(); this.cc = (this.cc & ~Z) | (this.x ? 0 : Z); this.cycles += 4; return;   // LEAX
      case 0x31: this.y = this.indexed(); this.cc = (this.cc & ~Z) | (this.y ? 0 : Z); this.cycles += 4; return;   // LEAY
      case 0x32: this.s = this.indexed(); this.nmiArmed = true; this.cycles += 4; return;   // LEAS
      case 0x33: this.u = this.indexed(); this.cycles += 4; return;     // LEAU
      case 0x34: this.pshs(this.fetch(), false); this.cycles += 5; return;   // PSHS
      case 0x35: this.puls(this.fetch(), false); this.cycles += 5; return;   // PULS
      case 0x36: this.pshs(this.fetch(), true); this.cycles += 5; return;    // PSHU
      case 0x37: this.puls(this.fetch(), true); this.cycles += 5; return;    // PULU
      case 0x39: this.pc = this.pullS16(); this.cycles += 5; return;    // RTS
      case 0x3A: this.x = (this.x + this.b) & 0xFFFF; this.cycles += 3; return;   // ABX
      case 0x3B: {                                                       // RTI
        this.cc = this.pullS();
        if (this.cc & E) {
          this.a = this.pullS(); this.b = this.pullS(); this.dp = this.pullS();
          this.x = this.pullS16(); this.y = this.pullS16(); this.u = this.pullS16();
          this.cycles += 9;
        }
        this.pc = this.pullS16(); this.cycles += 6; return;
      }
      case 0x3C: this.cc &= this.fetch(); this.cc |= E; this.pushAll(); this.cwai = true; this.waiting = true; this.cycles += 20; return;   // CWAI
      case 0x3D: { const r = this.a * this.b; this.d = r; this.cc = (this.cc & ~(Z | C)) | (r ? 0 : Z) | (r & 0x80 ? C : 0); this.cycles += 11; return; }   // MUL
      case 0x3F: this.cc |= E; this.pushAll(); this.cc |= I | F; this.pc = this.read16(0xFFFA); this.cycles += 19; return;   // SWI
      case 0x8D: { const o = this.fetch(); this.pushS16(this.pc); this.pc = (this.pc + ((o ^ 0x80) - 0x80)) & 0xFFFF; this.cycles += 7; return; }   // BSR
    }

    if (hi === 0x2) { this.branch(this.cond(lo), false); return; }     // Bcc

    // 0x80-0xFF: accumulator A (0x8x-0xBx) / B (0xCx-0xFx) operations.
    if (op >= 0x80) {
      const useB = op >= 0xC0, mode = (op >> 4) & 3;              // 0 immediate, 1 direct, 2 indexed, 3 extended
      const acc = useB ? this.b : this.a;
      const set = (v) => { if (useB) this.b = v; else this.a = v; };
      const operand8 = () => (mode === 0 ? (this.cycles += 2, this.fetch()) : this.read(this.ea(mode)));
      const operand16 = () => (mode === 0 ? (this.cycles += 3, this.fetch16()) : (this.cycles += 1, this.read16(this.ea(mode))));
      switch (lo) {
        case 0x0: set(this.sub8(acc, operand8())); return;                        // SUB
        case 0x1: this.sub8(acc, operand8()); return;                              // CMP
        case 0x2: set(this.sub8(acc, operand8(), this.cc & C)); return;           // SBC
        case 0x3: {                                                                 // SUBD / ADDD
          const v = operand16();
          this.d = useB ? this.add16(this.d, v) : this.sub16(this.d, v);
          this.cycles += 1; return;
        }
        case 0x4: set(this.logic8(acc & operand8())); return;                     // AND
        case 0x5: this.logic8(acc & operand8()); return;                           // BIT
        case 0x6: set(this.logic8(operand8())); return;                            // LD
        case 0x7: {                                                                 // ST
          if (mode === 0) { this.cycles += 2; return; }
          const ea = this.ea(mode); this.write(ea, acc); this.logic8(acc); return;
        }
        case 0x8: set(this.logic8(acc ^ operand8())); return;                     // EOR
        case 0x9: set(this.add8(acc, operand8(), this.cc & C)); return;           // ADC
        case 0xA: set(this.logic8(acc | operand8())); return;                     // OR
        case 0xB: set(this.add8(acc, operand8())); return;                        // ADD
        case 0xC: {                                                                 // CMPX / LDD
          const v = operand16();
          if (useB) { this.d = v; this.cc &= ~V; this.nz16(v); } else this.sub16(this.x, v);
          return;
        }
        case 0xD: {                                                                 // JSR / STD
          if (!useB) {
            if (mode === 0) return;                                                 // BSR handled above
            const ea = this.ea(mode); this.pushS16(this.pc); this.pc = ea; this.cycles += 3; return;
          }
          if (mode === 0) { this.cycles += 2; return; }
          const ea = this.ea(mode); this.write16(ea, this.d); this.cc &= ~V; this.nz16(this.d); this.cycles += 1; return;
        }
        case 0xE: {                                                                 // LDX / LDU
          const v = operand16(); if (useB) this.u = v; else this.x = v; this.cc &= ~V; this.nz16(v); return;
        }
        case 0xF: {                                                                 // STX / STU
          if (mode === 0) { this.cycles += 2; return; }
          const ea = this.ea(mode), v = useB ? this.u : this.x;
          this.write16(ea, v); this.cc &= ~V; this.nz16(v); this.cycles += 1; return;
        }
      }
    }
    this.cycles += 2;                                                               // undefined opcode: treat as NOP
  }

  page2(op) {
    if (op >= 0x20 && op < 0x30) { this.branch(this.cond(op & 15), true); return; }   // LBcc
    if (op === 0x3F) { this.cc |= E; this.pushAll(); this.pc = this.read16(0xFFF4); this.cycles += 20; return; }   // SWI2
    const mode = (op >> 4) & 3, lo = op & 15, useS = op >= 0xC0;
    const operand16 = () => (mode === 0 ? (this.cycles += 4, this.fetch16()) : (this.cycles += 2, this.read16(this.ea(mode))));
    if (op >= 0x80) {
      switch (lo) {
        case 0x3: this.sub16(this.d, operand16()); return;                         // CMPD
        case 0xC: this.sub16(this.y, operand16()); return;                         // CMPY
        case 0xE: { const v = operand16(); if (useS) { this.s = v; this.nmiArmed = true; } else this.y = v; this.cc &= ~V; this.nz16(v); return; }   // LDY / LDS
        case 0xF: {                                                                 // STY / STS
          if (mode === 0) { this.cycles += 2; return; }
          const ea = this.ea(mode), v = useS ? this.s : this.y;
          this.write16(ea, v); this.cc &= ~V; this.nz16(v); this.cycles += 2; return;
        }
      }
    }
    this.cycles += 2;
  }

  page3(op) {
    if (op === 0x3F) { this.cc |= E; this.pushAll(); this.pc = this.read16(0xFFF2); this.cycles += 20; return; }   // SWI3
    const mode = (op >> 4) & 3, lo = op & 15;
    const operand16 = () => (mode === 0 ? (this.cycles += 4, this.fetch16()) : (this.cycles += 2, this.read16(this.ea(mode))));
    if (op >= 0x80 && op < 0xC0) {
      if (lo === 0x3) { this.sub16(this.u, operand16()); return; }                 // CMPU
      if (lo === 0xC) { this.sub16(this.s, operand16()); return; }                 // CMPS
    }
    this.cycles += 2;
  }
}
