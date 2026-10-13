// NEC V30 (uPD70116): an 8086-compatible 16-bit CPU with the 80186's added
// instructions (PUSHA/POPA, PUSH/IMUL immediate, shifts by an immediate,
// ENTER/LEAVE, BOUND, INS/OUTS) and NEC's own bit, nibble and BCD-string
// instructions (the 0F xx group) and REPC/REPNC prefixes. Used by Irem's
// M72/M81/M82/M84 boards (R-Type, Hammerin' Harry) and many others.
//
// The host supplies a 20-bit memory bus (read8/write8) and an 8-bit I/O bus
// (in8/out8; word I/O goes through it a byte at a time). Interrupts: set
// `irq` and `irqVector` (the interrupt number the board's controller puts on
// the bus); onIrqAck() is called when it's taken. nmi() raises an NMI.
//
// Timing is approximate: a base cost per instruction plus extra for memory
// operands, multiplies, divides and string repeats.

import { capture, apply } from './state.js';

const AX = 0, CX = 1, DX = 2, BX = 3, SP = 4, BP = 5, SI = 6, DI = 7;
const ES = 0, CS = 1, SS = 2, DS = 3;
const PARITY = Uint8Array.from({ length: 256 }, (_, i) => { let p = i; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1; return (p & 1) ? 0 : 1; });

const STATE = ['r', 'sreg', 'ip', 'cf', 'pf', 'af', 'zf', 'sf', 'tf', 'iflag', 'df', 'of', 'irq', 'irqVector', 'nmiPending', 'halted', 'cycles'];

export class V30 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor({ read8, write8, in8 = () => 0xFF, out8 = () => {} }) {
    this.read8 = read8; this.write8 = write8; this.in8 = in8; this.out8 = out8;
    this.onIrqAck = null;
    this.trapAddr = -1;       // a physical address where the host takes over (onTrap), e.g. a missing MCU's routine
    this.onTrap = null;
    this.r = new Uint16Array(8);
    this.sreg = new Uint16Array(4);
    this.cycles = 0;
    this.reset();
  }

  reset() {
    this.r.fill(0); this.sreg.fill(0);
    this.sreg[CS] = 0xFFFF; this.ip = 0;
    this.cf = this.pf = this.af = this.zf = this.sf = this.tf = this.iflag = this.df = this.of = 0;
    this.irq = false; this.irqVector = 0; this.nmiPending = false; this.halted = false;
    this.seg = -1; this.rep = 0;
  }

  nmi() { this.nmiPending = true; }

  // ---------------------------------------------------------------- flags

  get flags() {
    return 0xF002 | this.cf | (this.pf << 2) | (this.af << 4) | (this.zf << 6) | (this.sf << 7) | (this.tf << 8) | (this.iflag << 9) | (this.df << 10) | (this.of << 11);
  }
  set flags(v) {
    this.cf = v & 1; this.pf = (v >> 2) & 1; this.af = (v >> 4) & 1; this.zf = (v >> 6) & 1; this.sf = (v >> 7) & 1;
    this.tf = (v >> 8) & 1; this.iflag = (v >> 9) & 1; this.df = (v >> 10) & 1; this.of = (v >> 11) & 1;
  }

  szp8(v) { this.sf = (v >> 7) & 1; this.zf = v === 0 ? 1 : 0; this.pf = PARITY[v]; }
  szp16(v) { this.sf = (v >> 15) & 1; this.zf = v === 0 ? 1 : 0; this.pf = PARITY[v & 0xFF]; }

  // ---------------------------------------------------------------- registers

  get8(i) { return i < 4 ? this.r[i] & 0xFF : this.r[i - 4] >> 8; }
  set8(i, v) { if (i < 4) this.r[i] = (this.r[i] & 0xFF00) | (v & 0xFF); else this.r[i - 4] = (this.r[i - 4] & 0xFF) | ((v & 0xFF) << 8); }

  // ---------------------------------------------------------------- memory

  rb(seg, off) { return this.read8(((this.sreg[seg] << 4) + (off & 0xFFFF)) & 0xFFFFF); }
  rw(seg, off) { return this.rb(seg, off) | (this.rb(seg, off + 1) << 8); }
  wb(seg, off, v) { this.write8(((this.sreg[seg] << 4) + (off & 0xFFFF)) & 0xFFFFF, v & 0xFF); }
  ww(seg, off, v) { this.wb(seg, off, v); this.wb(seg, off + 1, v >> 8); }

  fetch() { const v = this.rb(CS, this.ip); this.ip = (this.ip + 1) & 0xFFFF; return v; }
  fetchW() { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  fetchS8() { return (this.fetch() << 24) >> 24; }

  push(v) { this.r[SP] -= 2; this.ww(SS, this.r[SP], v); }
  pop() { const v = this.rw(SS, this.r[SP]); this.r[SP] += 2; return v; }

  inW(p) { return this.in8(p & 0xFFFF) | (this.in8((p + 1) & 0xFFFF) << 8); }
  outW(p, v) { this.out8(p & 0xFFFF, v & 0xFF); this.out8((p + 1) & 0xFFFF, (v >> 8) & 0xFF); }

  // ---------------------------------------------------------------- ModRM

  // Decode a ModRM byte: sets this.mod/regf/rm and, for memory operands, this.eaSeg/eaOff.
  modrm() {
    const m = this.fetch();
    this.mod = m >> 6; this.regf = (m >> 3) & 7; this.rm = m & 7;
    if (this.mod === 3) return;
    const r = this.r;
    let off, seg = DS;
    switch (this.rm) {
      case 0: off = r[BX] + r[SI]; break;
      case 1: off = r[BX] + r[DI]; break;
      case 2: off = r[BP] + r[SI]; seg = SS; break;
      case 3: off = r[BP] + r[DI]; seg = SS; break;
      case 4: off = r[SI]; break;
      case 5: off = r[DI]; break;
      case 6: if (this.mod === 0) off = this.fetchW(); else { off = r[BP]; seg = SS; } break;
      default: off = r[BX];
    }
    if (this.mod === 1) off += this.fetchS8();
    else if (this.mod === 2) off += this.fetchW();
    this.eaOff = off & 0xFFFF;
    this.eaSeg = this.seg >= 0 ? this.seg : seg;
    this.cycles += 6;
  }
  getRM8() { return this.mod === 3 ? this.get8(this.rm) : this.rb(this.eaSeg, this.eaOff); }
  setRM8(v) { if (this.mod === 3) this.set8(this.rm, v); else this.wb(this.eaSeg, this.eaOff, v); }
  getRM16() { return this.mod === 3 ? this.r[this.rm] : this.rw(this.eaSeg, this.eaOff); }
  setRM16(v) { if (this.mod === 3) this.r[this.rm] = v; else this.ww(this.eaSeg, this.eaOff, v); }

  dseg() { return this.seg >= 0 ? this.seg : DS; }

  // ---------------------------------------------------------------- ALU

  // op: 0 ADD, 1 OR, 2 ADC, 3 SBB, 4 AND, 5 SUB, 6 XOR, 7 CMP. Returns the result (CMP's is ignored).
  alu8(op, a, b) {
    let r;
    switch (op) {
      case 0: case 2: {
        const c = op === 2 ? this.cf : 0;
        r = a + b + c;
        this.cf = r > 0xFF ? 1 : 0; this.af = ((a ^ b ^ r) >> 4) & 1;
        this.of = (((a ^ r) & (b ^ r)) >> 7) & 1;
        r &= 0xFF; break;
      }
      case 3: case 5: case 7: {
        const c = op === 3 ? this.cf : 0;
        r = a - b - c;
        this.cf = r < 0 ? 1 : 0; this.af = ((a ^ b ^ r) >> 4) & 1;
        this.of = (((a ^ b) & (a ^ r)) >> 7) & 1;
        r &= 0xFF; break;
      }
      case 1: r = a | b; this.cf = this.of = this.af = 0; break;
      case 4: r = a & b; this.cf = this.of = this.af = 0; break;
      default: r = a ^ b; this.cf = this.of = this.af = 0;
    }
    this.szp8(r);
    return r;
  }
  alu16(op, a, b) {
    let r;
    switch (op) {
      case 0: case 2: {
        const c = op === 2 ? this.cf : 0;
        r = a + b + c;
        this.cf = r > 0xFFFF ? 1 : 0; this.af = ((a ^ b ^ r) >> 4) & 1;
        this.of = (((a ^ r) & (b ^ r)) >> 15) & 1;
        r &= 0xFFFF; break;
      }
      case 3: case 5: case 7: {
        const c = op === 3 ? this.cf : 0;
        r = a - b - c;
        this.cf = r < 0 ? 1 : 0; this.af = ((a ^ b ^ r) >> 4) & 1;
        this.of = (((a ^ b) & (a ^ r)) >> 15) & 1;
        r &= 0xFFFF; break;
      }
      case 1: r = a | b; this.cf = this.of = this.af = 0; break;
      case 4: r = a & b; this.cf = this.of = this.af = 0; break;
      default: r = a ^ b; this.cf = this.of = this.af = 0;
    }
    this.szp16(r);
    return r;
  }
  inc8(v) { const r = (v + 1) & 0xFF; this.of = v === 0x7F ? 1 : 0; this.af = (v & 15) === 15 ? 1 : 0; this.szp8(r); return r; }
  dec8(v) { const r = (v - 1) & 0xFF; this.of = v === 0x80 ? 1 : 0; this.af = (v & 15) === 0 ? 1 : 0; this.szp8(r); return r; }
  inc16(v) { const r = (v + 1) & 0xFFFF; this.of = v === 0x7FFF ? 1 : 0; this.af = (v & 15) === 15 ? 1 : 0; this.szp16(r); return r; }
  dec16(v) { const r = (v - 1) & 0xFFFF; this.of = v === 0x8000 ? 1 : 0; this.af = (v & 15) === 0 ? 1 : 0; this.szp16(r); return r; }

  // Shifts and rotates: op 0 ROL, 1 ROR, 2 RCL, 3 RCR, 4 SHL, 5 SHR, 6 SHL (alias), 7 SAR.
  shift(op, v, n, bits) {
    if (n === 0) return v;
    const msb = 1 << (bits - 1), mask = (1 << bits) - 1;
    this.cycles += n;
    for (let i = 0; i < n; i++) {
      switch (op) {
        case 0: this.cf = (v & msb) ? 1 : 0; v = ((v << 1) | this.cf) & mask; break;
        case 1: this.cf = v & 1; v = (v >> 1) | (this.cf ? msb : 0); break;
        case 2: { const c = (v & msb) ? 1 : 0; v = ((v << 1) | this.cf) & mask; this.cf = c; break; }
        case 3: { const c = v & 1; v = (v >> 1) | (this.cf ? msb : 0); this.cf = c; break; }
        case 4: case 6: this.cf = (v & msb) ? 1 : 0; v = (v << 1) & mask; break;
        case 5: this.cf = v & 1; v >>= 1; break;
        default: this.cf = v & 1; v = (v >> 1) | (v & msb); break;
      }
    }
    switch (op) {
      case 0: case 2: this.of = (((v & msb) ? 1 : 0) ^ this.cf); break;
      case 1: case 3: this.of = ((v ^ (v << 1)) & msb) ? 1 : 0; break;
      case 4: case 6: this.of = (((v & msb) ? 1 : 0) ^ this.cf); if (bits === 8) this.szp8(v); else this.szp16(v); break;
      case 5: this.of = n === 1 ? (((v << 1) & msb) ? 1 : 0) : 0; if (bits === 8) this.szp8(v); else this.szp16(v); break;
      default: this.of = 0; if (bits === 8) this.szp8(v); else this.szp16(v);
    }
    return v;
  }

  cond(c) {
    switch (c) {
      case 0: return this.of;
      case 1: return !this.of;
      case 2: return this.cf;
      case 3: return !this.cf;
      case 4: return this.zf;
      case 5: return !this.zf;
      case 6: return this.cf || this.zf;
      case 7: return !this.cf && !this.zf;
      case 8: return this.sf;
      case 9: return !this.sf;
      case 10: return this.pf;
      case 11: return !this.pf;
      case 12: return this.sf !== this.of;
      case 13: return this.sf === this.of;
      case 14: return this.zf || this.sf !== this.of;
      default: return !this.zf && this.sf === this.of;
    }
  }

  // ---------------------------------------------------------------- interrupts

  interrupt(n) {
    this.push(this.flags);
    this.tf = 0; this.iflag = 0;
    this.push(this.sreg[CS]);
    this.push(this.ip);
    this.ip = this.read8(n * 4) | (this.read8(n * 4 + 1) << 8);
    this.sreg[CS] = this.read8(n * 4 + 2) | (this.read8(n * 4 + 3) << 8);
    this.cycles += 40;
  }

  run(n) {
    const start = this.cycles, end = start + n;
    while (this.cycles < end) {
      if (this.nmiPending) { this.nmiPending = false; this.halted = false; this.interrupt(2); continue; }
      if (this.irq && this.iflag) {
        this.halted = false;
        const v = this.irqVector;
        if (this.onIrqAck) this.onIrqAck();
        this.interrupt(v);
        continue;
      }
      if (this.halted) { this.cycles = end; break; }
      if (this.trapAddr >= 0 && (((this.sreg[CS] << 4) + this.ip) & 0xFFFFF) === this.trapAddr && this.onTrap(this)) continue;
      this.step();
    }
    return this.cycles - start;
  }

  // ---------------------------------------------------------------- string instructions

  stringOp(op) {
    const r = this.r, d = this.df ? -1 : 1, src = this.dseg();
    const word = op & 1, size = word ? 2 : 1;
    const once = () => {
      switch (op & 0xFE) {
        case 0xA4: // MOVS
          if (word) this.ww(ES, r[DI], this.rw(src, r[SI])); else this.wb(ES, r[DI], this.rb(src, r[SI]));
          r[SI] += d * size; r[DI] += d * size; break;
        case 0xA6: { // CMPS
          if (word) this.alu16(7, this.rw(src, r[SI]), this.rw(ES, r[DI])); else this.alu8(7, this.rb(src, r[SI]), this.rb(ES, r[DI]));
          r[SI] += d * size; r[DI] += d * size; break;
        }
        case 0xAA: // STOS
          if (word) this.ww(ES, r[DI], r[AX]); else this.wb(ES, r[DI], r[AX] & 0xFF);
          r[DI] += d * size; break;
        case 0xAC: // LODS
          if (word) r[AX] = this.rw(src, r[SI]); else this.set8(0, this.rb(src, r[SI]));
          r[SI] += d * size; break;
        case 0xAE: // SCAS
          if (word) this.alu16(7, r[AX], this.rw(ES, r[DI])); else this.alu8(7, r[AX] & 0xFF, this.rb(ES, r[DI]));
          r[DI] += d * size; break;
        case 0x6C: // INS
          if (word) this.ww(ES, r[DI], this.inW(r[DX])); else this.wb(ES, r[DI], this.in8(r[DX]));
          r[DI] += d * size; break;
        case 0x6E: // OUTS
          if (word) this.outW(r[DX], this.rw(src, r[SI])); else this.out8(r[DX], this.rb(src, r[SI]));
          r[SI] += d * size; break;
      }
      this.cycles += 8;
    };
    if (!this.rep) { once(); return; }
    const compares = (op & 0xFE) === 0xA6 || (op & 0xFE) === 0xAE;
    while (r[CX] !== 0) {
      once();
      r[CX]--;
      if (compares) {
        if (this.rep === 0xF3 && !this.zf) break;           // REPE
        if (this.rep === 0xF2 && this.zf) break;            // REPNE
      }
      if (this.rep === 0x65 && !this.cf) break;             // REPC
      if (this.rep === 0x64 && this.cf) break;              // REPNC
    }
  }

  // ---------------------------------------------------------------- execute

  step() {
    this.seg = -1; this.rep = 0;
    let op = this.fetch();
    // Prefixes.
    for (;;) {
      if (op === 0x26 || op === 0x2E || op === 0x36 || op === 0x3E) this.seg = (op >> 3) & 3;
      else if (op === 0xF2 || op === 0xF3 || op === 0x64 || op === 0x65) this.rep = op;
      else if (op !== 0xF0) break;
      op = this.fetch();
      this.cycles += 2;
    }
    this.cycles += 3;
    const r = this.r;

    // The eight ALU ops in their six forms (00-3F, except the column 6/7 specials).
    if (op < 0x40 && (op & 7) < 6) {
      const alu = op >> 3;
      switch (op & 7) {
        case 0: { this.modrm(); const v = this.alu8(alu, this.getRM8(), this.get8(this.regf)); if (alu !== 7) this.setRM8(v); return; }
        case 1: { this.modrm(); const v = this.alu16(alu, this.getRM16(), r[this.regf]); if (alu !== 7) this.setRM16(v); return; }
        case 2: { this.modrm(); const v = this.alu8(alu, this.get8(this.regf), this.getRM8()); if (alu !== 7) this.set8(this.regf, v); return; }
        case 3: { this.modrm(); const v = this.alu16(alu, r[this.regf], this.getRM16()); if (alu !== 7) r[this.regf] = v; return; }
        case 4: { const v = this.alu8(alu, r[AX] & 0xFF, this.fetch()); if (alu !== 7) this.set8(0, v); return; }
        default: { const v = this.alu16(alu, r[AX], this.fetchW()); if (alu !== 7) r[AX] = v; return; }
      }
    }

    switch (op) {
      case 0x06: case 0x0E: case 0x16: case 0x1E: this.push(this.sreg[op >> 3]); return;   // PUSH sreg
      case 0x07: case 0x17: case 0x1F: this.sreg[op >> 3] = this.pop(); return;           // POP sreg
      case 0x0F: this.extended(); return;                                                 // NEC 0F group
      case 0x27: case 0x2F: {                                                             // DAA / DAS
        let al = r[AX] & 0xFF; const oldAl = al, oldCf = this.cf;
        const sub = op === 0x2F;
        if ((al & 15) > 9 || this.af) { al = sub ? al - 6 : al + 6; this.af = 1; } else this.af = 0;
        if (oldAl > 0x99 || oldCf) { al = sub ? al - 0x60 : al + 0x60; this.cf = 1; } else this.cf = 0;
        al &= 0xFF; this.set8(0, al); this.szp8(al);
        return;
      }
      case 0x37: case 0x3F: {                                                             // AAA / AAS
        let al = r[AX] & 0xFF, ah = r[AX] >> 8;
        if ((al & 15) > 9 || this.af) {
          if (op === 0x37) { al += 6; ah++; } else { al -= 6; ah--; }
          this.af = this.cf = 1;
        } else this.af = this.cf = 0;
        r[AX] = ((ah & 0xFF) << 8) | (al & 0x0F);
        return;
      }
    }
    if (op >= 0x40 && op < 0x48) { r[op & 7] = this.inc16(r[op & 7]); return; }
    if (op >= 0x48 && op < 0x50) { r[op & 7] = this.dec16(r[op & 7]); return; }
    if (op >= 0x50 && op < 0x58) { this.push(r[op & 7]); return; }      // (PUSH SP stores the value before the push, as on the 80186)
    if (op >= 0x58 && op < 0x60) { r[op & 7] = this.pop(); return; }
    if (op >= 0x70 && op < 0x80) { const d = this.fetchS8(); if (this.cond(op & 15)) { this.ip = (this.ip + d) & 0xFFFF; this.cycles += 8; } return; }
    if (op >= 0x91 && op < 0x98) { const t = r[AX]; r[AX] = r[op & 7]; r[op & 7] = t; return; }
    if (op >= 0xB0 && op < 0xB8) { this.set8(op & 7, this.fetch()); return; }
    if (op >= 0xB8 && op < 0xC0) { r[op & 7] = this.fetchW(); return; }

    switch (op) {
      case 0x60: { const sp = r[SP]; for (let i = 0; i < 8; i++) this.push(i === SP ? sp : r[i]); this.cycles += 30; return; }   // PUSHA
      case 0x61: { for (let i = 7; i >= 0; i--) { const v = this.pop(); if (i !== SP) r[i] = v; } this.cycles += 30; return; }   // POPA
      case 0x62: {                                                                        // BOUND
        this.modrm();
        const lo = (this.rw(this.eaSeg, this.eaOff) << 16) >> 16, hi = (this.rw(this.eaSeg, this.eaOff + 2) << 16) >> 16, v = (r[this.regf] << 16) >> 16;
        if (v < lo || v > hi) this.interrupt(5);
        return;
      }
      case 0x68: this.push(this.fetchW()); return;
      case 0x6A: this.push(this.fetchS8() & 0xFFFF); return;
      case 0x69: case 0x6B: {                                                             // IMUL reg, rm, imm
        this.modrm();
        const a = (this.getRM16() << 16) >> 16, b = op === 0x69 ? (this.fetchW() << 16) >> 16 : this.fetchS8();
        const p = a * b;
        r[this.regf] = p & 0xFFFF;
        this.cf = this.of = (p < -32768 || p > 32767) ? 1 : 0;
        this.cycles += 30;
        return;
      }
      case 0x6C: case 0x6D: case 0x6E: case 0x6F: case 0xA4: case 0xA5: case 0xA6: case 0xA7:
      case 0xAA: case 0xAB: case 0xAC: case 0xAD: case 0xAE: case 0xAF:
        this.stringOp(op); return;
      case 0x80: case 0x82: { this.modrm(); const alu = this.regf, v = this.alu8(alu, this.getRM8(), this.fetch()); if (alu !== 7) this.setRM8(v); return; }
      case 0x81: { this.modrm(); const alu = this.regf, v = this.alu16(alu, this.getRM16(), this.fetchW()); if (alu !== 7) this.setRM16(v); return; }
      case 0x83: { this.modrm(); const alu = this.regf, v = this.alu16(alu, this.getRM16(), this.fetchS8() & 0xFFFF); if (alu !== 7) this.setRM16(v); return; }
      case 0x84: { this.modrm(); this.alu8(4, this.getRM8(), this.get8(this.regf)); return; }
      case 0x85: { this.modrm(); this.alu16(4, this.getRM16(), r[this.regf]); return; }
      case 0x86: { this.modrm(); const t = this.getRM8(); this.setRM8(this.get8(this.regf)); this.set8(this.regf, t); return; }
      case 0x87: { this.modrm(); const t = this.getRM16(); this.setRM16(r[this.regf]); r[this.regf] = t; return; }
      case 0x88: this.modrm(); this.setRM8(this.get8(this.regf)); return;
      case 0x89: this.modrm(); this.setRM16(r[this.regf]); return;
      case 0x8A: this.modrm(); this.set8(this.regf, this.getRM8()); return;
      case 0x8B: this.modrm(); r[this.regf] = this.getRM16(); return;
      case 0x8C: this.modrm(); this.setRM16(this.sreg[this.regf & 3]); return;
      case 0x8D: this.modrm(); r[this.regf] = this.eaOff; return;                        // LEA
      case 0x8E: this.modrm(); this.sreg[this.regf & 3] = this.getRM16(); return;
      case 0x8F: this.modrm(); this.setRM16(this.pop()); return;
      case 0x90: return;                                                                  // NOP
      case 0x98: r[AX] = ((r[AX] << 24) >> 24) & 0xFFFF; return;                          // CBW
      case 0x99: r[DX] = r[AX] & 0x8000 ? 0xFFFF : 0; return;                              // CWD
      case 0x9A: { const ip = this.fetchW(), cs = this.fetchW(); this.push(this.sreg[CS]); this.push(this.ip); this.ip = ip; this.sreg[CS] = cs; this.cycles += 20; return; }
      case 0x9B: return;                                                                  // WAIT (POLL)
      case 0x9C: this.push(this.flags); return;
      case 0x9D: this.flags = this.pop(); return;
      case 0x9E: { const ah = r[AX] >> 8; this.flags = (this.flags & 0xFF00) | ah; return; }   // SAHF
      case 0x9F: this.set8(4, this.flags & 0xFF); return;                                   // LAHF
      case 0xA0: this.set8(0, this.rb(this.dseg(), this.fetchW())); return;
      case 0xA1: r[AX] = this.rw(this.dseg(), this.fetchW()); return;
      case 0xA2: this.wb(this.dseg(), this.fetchW(), r[AX]); return;
      case 0xA3: this.ww(this.dseg(), this.fetchW(), r[AX]); return;
      case 0xA8: this.alu8(4, r[AX] & 0xFF, this.fetch()); return;
      case 0xA9: this.alu16(4, r[AX], this.fetchW()); return;
      case 0xC0: case 0xC1: case 0xD0: case 0xD1: case 0xD2: case 0xD3: {               // shifts
        this.modrm();
        const n = op <= 0xC1 ? this.fetch() & 0x1F : op <= 0xD1 ? 1 : r[CX] & 0x1F;
        if (op & 1) this.setRM16(this.shift(this.regf, this.getRM16(), n, 16));
        else this.setRM8(this.shift(this.regf, this.getRM8(), n, 8));
        return;
      }
      case 0xC2: { const n = this.fetchW(); this.ip = this.pop(); r[SP] += n; return; }
      case 0xC3: this.ip = this.pop(); this.cycles += 8; return;
      case 0xC4: case 0xC5: {                                                             // LES / LDS
        this.modrm();
        r[this.regf] = this.rw(this.eaSeg, this.eaOff);
        this.sreg[op === 0xC4 ? ES : DS] = this.rw(this.eaSeg, this.eaOff + 2);
        return;
      }
      case 0xC6: this.modrm(); this.setRM8(this.fetch()); return;
      case 0xC7: this.modrm(); this.setRM16(this.fetchW()); return;
      case 0xC8: {                                                                        // ENTER
        const size = this.fetchW(), level = this.fetch() & 31;
        this.push(r[BP]);
        const frame = r[SP];
        for (let i = 1; i < level; i++) { r[BP] -= 2; this.push(this.rw(SS, r[BP])); }
        if (level) this.push(frame);
        r[BP] = frame; r[SP] -= size;
        this.cycles += 16;
        return;
      }
      case 0xC9: r[SP] = r[BP]; r[BP] = this.pop(); return;                               // LEAVE
      case 0xCA: { const n = this.fetchW(); this.ip = this.pop(); this.sreg[CS] = this.pop(); r[SP] += n; return; }
      case 0xCB: this.ip = this.pop(); this.sreg[CS] = this.pop(); this.cycles += 10; return;
      case 0xCC: this.interrupt(3); return;
      case 0xCD: this.interrupt(this.fetch()); return;
      case 0xCE: if (this.of) this.interrupt(4); return;
      case 0xCF: this.ip = this.pop(); this.sreg[CS] = this.pop(); this.flags = this.pop(); this.cycles += 10; return;   // IRET
      case 0xD4: {                                                                        // AAM
        const base = this.fetch() || 10, al = r[AX] & 0xFF;
        r[AX] = (Math.floor(al / base) << 8) | (al % base);
        this.szp8(r[AX] & 0xFF); this.cycles += 15;
        return;
      }
      case 0xD5: {                                                                        // AAD
        const base = this.fetch() || 10;
        const al = ((r[AX] >> 8) * base + (r[AX] & 0xFF)) & 0xFF;
        r[AX] = al; this.szp8(al);
        return;
      }
      case 0xD6: this.set8(0, this.cf ? 0xFF : 0); return;                               // (undocumented) SALC
      case 0xD7: this.set8(0, this.rb(this.dseg(), r[BX] + (r[AX] & 0xFF))); return;     // XLAT
      case 0xD8: case 0xD9: case 0xDA: case 0xDB: case 0xDC: case 0xDD: case 0xDE: case 0xDF:
        this.modrm(); return;                                                             // coprocessor escape: skip operand
      case 0xE0: case 0xE1: case 0xE2: {                                                  // LOOPNE / LOOPE / LOOP
        const d = this.fetchS8();
        r[CX]--;
        const go = r[CX] !== 0 && (op === 0xE2 || (op === 0xE1 ? this.zf : !this.zf));
        if (go) { this.ip = (this.ip + d) & 0xFFFF; this.cycles += 6; }
        return;
      }
      case 0xE3: { const d = this.fetchS8(); if (r[CX] === 0) this.ip = (this.ip + d) & 0xFFFF; return; }
      case 0xE4: this.set8(0, this.in8(this.fetch())); return;
      case 0xE5: r[AX] = this.inW(this.fetch()); return;
      case 0xE6: this.out8(this.fetch(), r[AX] & 0xFF); return;
      case 0xE7: this.outW(this.fetch(), r[AX]); return;
      case 0xE8: { const d = this.fetchW(); this.push(this.ip); this.ip = (this.ip + d) & 0xFFFF; this.cycles += 10; return; }
      case 0xE9: { const d = this.fetchW(); this.ip = (this.ip + d) & 0xFFFF; this.cycles += 8; return; }
      case 0xEA: { const ip = this.fetchW(), cs = this.fetchW(); this.ip = ip; this.sreg[CS] = cs; this.cycles += 8; return; }
      case 0xEB: { const d = this.fetchS8(); this.ip = (this.ip + d) & 0xFFFF; this.cycles += 8; return; }
      case 0xEC: this.set8(0, this.in8(r[DX])); return;
      case 0xED: r[AX] = this.inW(r[DX]); return;
      case 0xEE: this.out8(r[DX], r[AX] & 0xFF); return;
      case 0xEF: this.outW(r[DX], r[AX]); return;
      case 0xF4: this.halted = true; return;
      case 0xF5: this.cf ^= 1; return;
      case 0xF6: case 0xF7: this.group3(op & 1); return;
      case 0xF8: this.cf = 0; return;
      case 0xF9: this.cf = 1; return;
      case 0xFA: this.iflag = 0; return;
      case 0xFB: this.iflag = 1; return;
      case 0xFC: this.df = 0; return;
      case 0xFD: this.df = 1; return;
      case 0xFE: {
        this.modrm();
        if (this.regf === 0) this.setRM8(this.inc8(this.getRM8()));
        else if (this.regf === 1) this.setRM8(this.dec8(this.getRM8()));
        return;
      }
      case 0xFF: {
        this.modrm();
        switch (this.regf) {
          case 0: this.setRM16(this.inc16(this.getRM16())); return;
          case 1: this.setRM16(this.dec16(this.getRM16())); return;
          case 2: { const t = this.getRM16(); this.push(this.ip); this.ip = t; this.cycles += 10; return; }
          case 3: { const ip = this.rw(this.eaSeg, this.eaOff), cs = this.rw(this.eaSeg, this.eaOff + 2); this.push(this.sreg[CS]); this.push(this.ip); this.ip = ip; this.sreg[CS] = cs; this.cycles += 20; return; }
          case 4: this.ip = this.getRM16(); this.cycles += 8; return;
          case 5: { this.ip = this.rw(this.eaSeg, this.eaOff); this.sreg[CS] = this.rw(this.eaSeg, this.eaOff + 2); this.cycles += 10; return; }
          default: this.push(this.getRM16()); return;
        }
      }
    }
    // Anything else (63, 66, 67, F1 and the unused 0F codes) is treated as a no-op.
  }

  // TEST/NOT/NEG/MUL/IMUL/DIV/IDIV on a byte (w=0) or word (w=1).
  group3(w) {
    this.modrm();
    const r = this.r;
    const v = w ? this.getRM16() : this.getRM8();
    switch (this.regf) {
      case 0: case 1: if (w) this.alu16(4, v, this.fetchW()); else this.alu8(4, v, this.fetch()); return;
      case 2: if (w) this.setRM16(~v & 0xFFFF); else this.setRM8(~v & 0xFF); return;
      case 3: {
        if (w) { const res = this.alu16(5, 0, v); this.setRM16(res); } else { const res = this.alu8(5, 0, v); this.setRM8(res); }
        this.cf = v !== 0 ? 1 : 0;
        return;
      }
      case 4: {                                                                           // MUL
        this.cycles += w ? 26 : 18;
        if (w) { const p = r[AX] * v; r[AX] = p & 0xFFFF; r[DX] = (p / 65536) & 0xFFFF; this.cf = this.of = r[DX] ? 1 : 0; }
        else { const p = (r[AX] & 0xFF) * v; r[AX] = p; this.cf = this.of = (p >> 8) ? 1 : 0; }
        this.zf = 0;
        return;
      }
      case 5: {                                                                           // IMUL
        this.cycles += w ? 30 : 20;
        if (w) {
          const p = ((r[AX] << 16) >> 16) * ((v << 16) >> 16);
          r[AX] = p & 0xFFFF; r[DX] = Math.floor(p / 65536) & 0xFFFF;
          this.cf = this.of = (p < -32768 || p > 32767) ? 1 : 0;
        } else {
          const p = ((r[AX] << 24) >> 24) * ((v << 24) >> 24);
          r[AX] = p & 0xFFFF;
          this.cf = this.of = (p < -128 || p > 127) ? 1 : 0;
        }
        return;
      }
      case 6: {                                                                           // DIV
        this.cycles += w ? 38 : 25;
        if (v === 0) { this.interrupt(0); return; }
        if (w) {
          const n = (r[DX] * 65536 + r[AX]), q = Math.floor(n / v);
          if (q > 0xFFFF) { this.interrupt(0); return; }
          r[AX] = q; r[DX] = n % v;
        } else {
          const n = r[AX], q = Math.floor(n / v);
          if (q > 0xFF) { this.interrupt(0); return; }
          r[AX] = ((n % v) << 8) | q;
        }
        return;
      }
      default: {                                                                          // IDIV
        this.cycles += w ? 45 : 30;
        if (v === 0) { this.interrupt(0); return; }
        if (w) {
          const n = (r[DX] << 16) | r[AX], d = (v << 16) >> 16, q = Math.trunc(n / d);
          if (q > 32767 || q < -32768) { this.interrupt(0); return; }
          r[AX] = q & 0xFFFF; r[DX] = (n - q * d) & 0xFFFF;
        } else {
          const n = (r[AX] << 16) >> 16, d = (v << 24) >> 24, q = Math.trunc(n / d);
          if (q > 127 || q < -128) { this.interrupt(0); return; }
          r[AX] = (((n - q * d) & 0xFF) << 8) | (q & 0xFF);
        }
      }
    }
  }

  // NEC's 0F-prefixed instructions: single-bit test/clear/set/invert, packed
  // BCD string add/subtract/compare, nibble rotates, and bit-field insert/extract.
  extended() {
    const op = this.fetch(), r = this.r;
    switch (op) {
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16: case 0x17:
      case 0x18: case 0x19: case 0x1A: case 0x1B: case 0x1C: case 0x1D: case 0x1E: case 0x1F: {
        this.modrm();
        const w = op & 1, imm = op & 8;
        const bit = (imm ? this.fetch() : r[CX] & 0xFF) & (w ? 15 : 7);
        let v = w ? this.getRM16() : this.getRM8();
        switch ((op >> 1) & 3) {
          case 0: this.zf = (v >> bit) & 1 ? 0 : 1; this.cf = this.of = 0; return;   // TEST1
          case 1: v &= ~(1 << bit); break;                                           // CLR1
          case 2: v |= 1 << bit; break;                                              // SET1
          default: v ^= 1 << bit;                                                    // NOT1
        }
        if (w) this.setRM16(v); else this.setRM8(v);
        return;
      }
      case 0x20: case 0x22: case 0x26: {                                                  // ADD4S / SUB4S / CMP4S
        const count = Math.ceil((r[CX] & 0xFF) / 2);
        let carry = 0, zero = 1;
        const src = this.dseg();
        for (let i = 0; i < count; i++) {
          const a = this.rb(ES, r[DI] + i), b = this.rb(src, r[SI] + i);
          let lo, hi;
          if (op === 0x20) {
            lo = (a & 15) + (b & 15) + carry; carry = lo > 9 ? 1 : 0; if (carry) lo -= 10;
            hi = (a >> 4) + (b >> 4) + carry; carry = hi > 9 ? 1 : 0; if (carry) hi -= 10;
          } else {
            lo = (a & 15) - (b & 15) - carry; carry = lo < 0 ? 1 : 0; if (carry) lo += 10;
            hi = (a >> 4) - (b >> 4) - carry; carry = hi < 0 ? 1 : 0; if (carry) hi += 10;
          }
          const res = (hi << 4) | lo;
          if (res) zero = 0;
          if (op !== 0x26) this.wb(ES, r[DI] + i, res);
        }
        this.cf = carry; this.zf = zero;
        this.cycles += 7 + 19 * count;
        return;
      }
      case 0x28: case 0x2A: {                                                             // ROL4 / ROR4
        this.modrm();
        const v = this.getRM8(), al = r[AX] & 0xFF;
        if (op === 0x28) { this.setRM8(((v << 4) | (al & 15)) & 0xFF); this.set8(0, (al & 0xF0) | (v >> 4)); }
        else { this.setRM8(((al & 15) << 4) | (v >> 4)); this.set8(0, (al & 0xF0) | (v & 15)); }
        return;
      }
      case 0x31: case 0x39: case 0x33: case 0x3B: {                                       // INS / EXT (bit fields)
        let lenReg = 0;
        if (op === 0x31 || op === 0x33) { const m = this.fetch(); this.regf = (m >> 3) & 7; this.rm = m & 7; lenReg = this.get8(this.regf) & 15; }
        else { const m = this.fetch(); this.rm = m & 7; this.regf = (m >> 3) & 7; lenReg = this.fetch() & 15; }
        const len = lenReg + 1, offReg = op === 0x31 || op === 0x39 ? this.rm : this.rm;
        let bitOff = this.get8(offReg) & 15;
        if (op === 0x31 || op === 0x39) {
          // INS: store the low `len` bits of AX at ES:DI, bit offset in the register.
          let val = r[AX] & ((1 << len) - 1);
          const word = this.rw(ES, r[DI]) | (this.rw(ES, r[DI] + 2) << 16);
          const mask = ((1 << len) - 1) << bitOff;
          const nw = (word & ~mask) | ((val << bitOff) & mask);
          this.ww(ES, r[DI], nw & 0xFFFF); this.ww(ES, r[DI] + 2, (nw >>> 16) & 0xFFFF);
          bitOff += len; if (bitOff > 15) { r[DI] += 2; bitOff -= 16; }
        } else {
          const word = this.rw(this.dseg(), r[SI]) | (this.rw(this.dseg(), r[SI] + 2) << 16);
          r[AX] = (word >>> bitOff) & ((1 << len) - 1);
          bitOff += len; if (bitOff > 15) { r[SI] += 2; bitOff -= 16; }
        }
        this.set8(offReg, bitOff);
        this.cycles += 30;
        return;
      }
      case 0xFF: this.interrupt(this.fetch()); return;                                    // BRKEM (emulation mode not supported)
    }
  }
}
