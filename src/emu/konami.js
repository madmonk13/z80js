// Konami 052001 / 052526 ("KONAMI-1"): a 6809 with its opcodes rearranged and
// extended, used as the main CPU of Super Contra, Aliens, Crime Fighters,
// Gang Busters, Ajax and others. The registers, flags, stack and interrupts
// are the 6809's; this reuses M6809 for them and decodes the Konami map:
//
// - Every memory operand goes through a mode byte after the opcode: high
//   nibble the base (2 X, 3 Y, 5 U, 6 S, 7 PC; A/B/D offsets at Ax/Bx/Dx/Ex/Fx),
//   low nibble auto inc/dec, 8/16-bit offset or none, bit 3 indirect; 07
//   extended, 0F [extended], C4 direct, CC [direct].
// - Additions: block moves (BMOVE, MOVE, BSET, BSET2), DECB/DECX-and-branch,
//   16-bit memory shifts and clears, D shifts by a count, LMUL (X*Y), DIVX
//   (X/B), ABS, and SETLINE, which drives the CPU's extra address lines
//   (boards use it for ROM banking: the `onSetLines` hook).
// - TFR/EXG register numbers: 0 A, 1 B, 2 X, 3 Y, 4 S, 5 U; TFR copies from
//   the low nibble to the high one.

import { M6809 } from './m6809.js';

const C = 0x01, V = 0x02, Z = 0x04, N = 0x08, H = 0x20;
// Base cycles per opcode (from the chip's published timings).
const CYCLES = [
  1, 1, 1, 1, 1, 1, 1, 1, 4, 4, 4, 4, 5, 5, 5, 5,  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 7, 6,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 3, 3, 4, 4,  4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 1, 1, 1,
  3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 5, 5, 5, 5, 5, 5,  3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 5, 5, 5, 5, 5, 5,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 5,  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 6,
  2, 2, 2, 4, 4, 4, 4, 4, 2, 2, 2, 2, 3, 3, 2, 1,  3, 2, 2, 11, 22, 11, 2, 4, 3, 3, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 3, 2,  2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  ...new Array(32).fill(1),
];
// 8-bit ALU ops with an immediate form at op and a memory form at op + 2.
const ALU8 = {};
[['ld', 0x10], ['add', 0x14], ['adc', 0x18], ['sub', 0x1C], ['sbc', 0x20], ['and', 0x24], ['bit', 0x28], ['eor', 0x2C],
  ['or', 0x30], ['cmp', 0x34]].forEach(([name, op]) => {
  ALU8[op] = [name, 'a', false]; ALU8[op + 1] = [name, 'b', false];
  ALU8[op + 2] = [name, 'a', true]; ALU8[op + 3] = [name, 'b', true];
});
// 16-bit ops: immediate at op, memory at op + 1.
const ALU16 = { 0x40: ['ld', 'd'], 0x42: ['ld', 'x'], 0x44: ['ld', 'y'], 0x46: ['ld', 'u'], 0x48: ['ld', 's'],
  0x4A: ['cmp', 'd'], 0x4C: ['cmp', 'x'], 0x4E: ['cmp', 'y'], 0x50: ['cmp', 'u'], 0x52: ['cmp', 's'], 0x54: ['add', 'd'], 0x56: ['sub', 'd'] };
// Read-modify-write on memory -> the M6809 rmw() operation code; and on A/B.
const RMW_MEM = { 0x82: 0xF, 0x85: 0x3, 0x88: 0x0, 0x8B: 0xC, 0x8E: 0xA, 0x92: 0xD, 0x95: 0x4, 0x98: 0x6, 0x9B: 0x7, 0x9E: 0x8, 0xA2: 0x9 };
const RMW_A = { 0x80: 0xF, 0x83: 0x3, 0x86: 0x0, 0x89: 0xC, 0x8C: 0xA, 0x90: 0xD, 0x93: 0x4, 0x96: 0x6, 0x99: 0x7, 0x9C: 0x8, 0xA0: 0x9 };
const RMW_B = { 0x81: 0xF, 0x84: 0x3, 0x87: 0x0, 0x8A: 0xC, 0x8D: 0xA, 0x91: 0xD, 0x94: 0x4, 0x97: 0x6, 0x9A: 0x7, 0x9D: 0x8, 0xA1: 0x9 };

export class KonamiCPU extends M6809 {
  constructor(bus) {
    super(bus);
    this.onSetLines = null;
  }

  sx8(v) { return (v ^ 0x80) - 0x80; }

  // The operand address from the mode byte.
  operand() {
    const m = this.fetch(), hi = m >> 4, lo = m & 0x0F;
    if (m === 0x07) { this.cycles += 2; return this.fetch16(); }
    if (m === 0x0F) { this.cycles += 4; return this.read16(this.fetch16()); }
    if (m === 0xC4) { this.cycles += 1; return (this.dp << 8) | this.fetch(); }
    if (m === 0xCC) { this.cycles += 4; return this.read16((this.dp << 8) | this.fetch()); }
    const regOf = { 2: 'x', 3: 'y', 5: 'u', 6: 's', 7: 'pc', 0xA: 'x', 0xB: 'y', 0xD: 'u', 0xE: 's', 0xF: 'pc' }[hi];
    if (!regOf) return 0;
    let ea;
    const ind = lo & 8;
    if (hi >= 0xA) {                                   // register offsets
      const r = this[regOf], k = lo & 7;
      if (k === 0) ea = r + this.sx8(this.a);
      else if (k === 1) ea = r + this.sx8(this.b);
      else ea = r + this.d;                           // 7: D
      this.cycles += k === 7 ? 4 : 1;
    } else {
      switch (lo & 7) {
        case 0: ea = this[regOf]; this.bump(regOf, 1); this.cycles += 2; break;
        case 1: ea = this[regOf]; this.bump(regOf, 2); this.cycles += 3; break;
        case 2: this.bump(regOf, -1); ea = this[regOf]; this.cycles += 2; break;
        case 3: this.bump(regOf, -2); ea = this[regOf]; this.cycles += 3; break;
        // PC-relative offsets count from the offset itself.
        case 4: { const o = this.sx8(this.fetch()); ea = (regOf === 'pc' ? this.pc - 1 : this[regOf]) + o; this.cycles += 2; break; }
        case 5: { const o = this.fetch16(); ea = (regOf === 'pc' ? this.pc - 2 : this[regOf]) + o; this.cycles += 4; break; }
        default: ea = this[regOf];
      }
    }
    ea &= 0xFFFF;
    if (ind) { ea = this.read16(ea); this.cycles += 3; }
    return ea;
  }
  bump(reg, by) { if (reg === 'pc') return; this[reg] = (this[reg] + by) & 0xFFFF; if (reg === 's') this.nmiArmed = true; }

  // TFR/EXG register numbers.
  kGet(n) { return [this.a, this.b, this.x, this.y, this.s, this.u][n] ?? 0xFF; }
  kSet(n, v) {
    switch (n) {
      case 0: this.a = v & 0xFF; break; case 1: this.b = v & 0xFF; break;
      case 2: this.x = v & 0xFFFF; break; case 3: this.y = v & 0xFFFF; break;
      case 4: this.s = v & 0xFFFF; this.nmiArmed = true; break; case 5: this.u = v & 0xFFFF; break;
    }
  }

  alu8(name, reg, v) {
    const r = this[reg];
    switch (name) {
      case 'ld': this[reg] = this.logic8(v); break;
      case 'add': this[reg] = this.add8(r, v); break;
      case 'adc': this[reg] = this.add8(r, v, this.cc & C); break;
      case 'sub': this[reg] = this.sub8(r, v); break;
      case 'sbc': this[reg] = this.sub8(r, v, this.cc & C); break;
      case 'and': this[reg] = this.logic8(r & v); break;
      case 'bit': this.logic8(r & v); break;
      case 'eor': this[reg] = this.logic8(r ^ v); break;
      case 'or': this[reg] = this.logic8(r | v); break;
      case 'cmp': this.sub8(r, v); break;
    }
  }
  reg16(r) { return r === 'd' ? this.d : this[r]; }
  set16(r, v) { if (r === 'd') this.d = v & 0xFFFF; else { this[r] = v & 0xFFFF; if (r === 's') this.nmiArmed = true; } }

  // 16-bit memory shifts / clears: the 6809 8-bit semantics widened.
  word(kind, ea) {
    const t = this.read16(ea);
    let r = t;
    switch (kind) {
      case 'lsr': this.cc = (this.cc & ~(N | Z | C)) | (t & 1 ? C : 0); r = t >> 1; this.cc |= r ? 0 : Z; break;
      case 'ror': r = (t >> 1) | (this.cc & C ? 0x8000 : 0); this.cc = (this.cc & ~(N | Z | C)) | (t & 1 ? C : 0); this.nz16(r); break;
      case 'asr': r = (t >> 1) | (t & 0x8000); this.cc = (this.cc & ~(N | Z | C)) | (t & 1 ? C : 0); this.nz16(r); break;
      case 'asl': r = (t << 1) & 0xFFFF; this.cc = (this.cc & ~(N | Z | V | C)) | (t & 0x8000 ? C : 0) | (((t ^ (t << 1)) & 0x8000) ? V : 0); this.nz16(r); break;
      case 'rol': r = ((t << 1) | (this.cc & C)) & 0xFFFF; this.cc = (this.cc & ~(N | Z | V | C)) | (t & 0x8000 ? C : 0) | (((t ^ (t << 1)) & 0x8000) ? V : 0); this.nz16(r); break;
      case 'clr': r = 0; this.cc = (this.cc & ~(N | V | C)) | Z; break;
      case 'neg': r = (-t) & 0xFFFF; this.cc = (this.cc & ~(N | Z | V | C)) | (r ? C : 0) | (t === 0x8000 ? V : 0); this.nz16(r); break;
      case 'inc': r = (t + 1) & 0xFFFF; this.cc = (this.cc & ~V) | (t === 0x7FFF ? V : 0); this.nz16(r); break;
      case 'dec': r = (t - 1) & 0xFFFF; this.cc = (this.cc & ~V) | (t === 0x8000 ? V : 0); this.nz16(r); break;
      case 'tst': this.cc &= ~V; this.nz16(t); return;
    }
    this.write16(ea, r);
  }

  // D shifted `n` times.
  dshift(kind, n) {
    let d = this.d;
    while (n-- > 0) {
      switch (kind) {
        case 'lsr': this.cc = (this.cc & ~(N | Z | C)) | (d & 1 ? C : 0); d >>= 1; if (!d) this.cc |= Z; break;
        case 'ror': { const r = (d >> 1) | (this.cc & C ? 0x8000 : 0); this.cc = (this.cc & ~(N | Z | C)) | (d & 1 ? C : 0); d = r; this.nz16(d); break; }
        case 'asr': this.cc = (this.cc & ~(N | Z | C)) | (d & 1 ? C : 0); d = (d & 0x8000) | (d >> 1); this.nz16(d); break;
        case 'asl': { const r = d << 1; this.cc = (this.cc & ~(N | Z | V | C)) | (r & 0x10000 ? C : 0) | (((d ^ r) & 0x8000) ? V : 0); d = r & 0xFFFF; this.nz16(d); break; }
        case 'rol': { const c = d & 0x8000 ? 1 : 0; d = ((d << 1) | (this.cc & C)) & 0xFFFF; this.cc = (this.cc & ~(N | Z | C)) | c; this.nz16(d); break; }
      }
    }
    this.d = d;
  }

  exec(op) {
    this.cycles += CYCLES[op];
    const alu = ALU8[op];
    if (alu) { this.alu8(alu[0], alu[1], alu[2] ? this.read(this.operand()) : this.fetch()); return; }
    if (ALU16[op] || ALU16[op - 1]) {
      const mem = !ALU16[op], [name, r] = ALU16[mem ? op - 1 : op];
      let v;
      if (mem) { v = this.read16(this.operand()); } else v = this.fetch16();
      if (name === 'ld') { this.set16(r, v); this.cc &= ~V; this.nz16(v); }
      else if (name === 'cmp') this.sub16(this.reg16(r), v);
      else if (name === 'add') this.d = this.add16(this.d, v);
      else this.d = this.sub16(this.d, v);
      return;
    }
    if (op in RMW_MEM) { const ea = this.operand(), r = this.rmw(RMW_MEM[op], this.read(ea)); if (r !== null) this.write(ea, r); return; }
    if (op in RMW_A) { const r = this.rmw(RMW_A[op], this.a); if (r !== null) this.a = r; return; }
    if (op in RMW_B) { const r = this.rmw(RMW_B[op], this.b); if (r !== null) this.b = r; return; }
    if (op >= 0x60 && op < 0x80) {                    // branches: 60-67 / 70-77 short, 68-6F / 78-7F long
      const cond = ((op & 7) << 1) | (op >= 0x70 ? 1 : 0);
      this.branch(this.cond(cond), (op & 8) !== 0);
      this.cycles -= (op & 8) ? 5 : 3;                // branch() adds the 6809's own counts
      return;
    }
    switch (op) {
      case 0x08: case 0x09: {                         // LEAX / LEAY (set Z)
        const ea = this.operand();
        if (op === 0x08) this.x = ea; else this.y = ea;
        this.cc = (this.cc & ~Z) | (ea ? 0 : Z); return;
      }
      case 0x0A: this.u = this.operand(); return;
      case 0x0B: this.s = this.operand(); this.nmiArmed = true; return;
      case 0x0C: this.pshs(this.fetch(), false); return;
      case 0x0D: this.pshs(this.fetch(), true); return;
      case 0x0E: this.puls(this.fetch(), false); return;
      case 0x0F: this.puls(this.fetch(), true); return;
      case 0x38: { const v = this.fetch(); if (this.onSetLines) this.onSetLines(v); return; }
      case 0x39: { const v = this.read(this.operand()); if (this.onSetLines) this.onSetLines(v); return; }
      case 0x3A: { const ea = this.operand(); this.logic8(this.a); this.write(ea, this.a); return; }
      case 0x3B: { const ea = this.operand(); this.logic8(this.b); this.write(ea, this.b); return; }
      case 0x3C: this.cc &= this.fetch(); return;
      case 0x3D: this.cc |= this.fetch(); return;
      case 0x3E: { const t = this.fetch(), a = this.kGet(t >> 4), b = this.kGet(t & 15); this.kSet(t >> 4, b); this.kSet(t & 15, a); return; }
      case 0x3F: { const t = this.fetch(); this.kSet((t >> 4) & 7, this.kGet(t & 15)); return; }
      case 0x58: case 0x59: case 0x5A: case 0x5B: case 0x5C: {
        const ea = this.operand(), v = [this.d, this.x, this.y, this.u, this.s][op - 0x58];
        this.cc &= ~V; this.nz16(v); this.write16(ea, v); return;
      }
      case 0x8F: this.pc = this.pullS16(); return;    // RTS
      case 0x9F: {                                    // RTI
        this.cc = this.pullS();
        if (this.cc & 0x80) {
          this.a = this.pullS(); this.b = this.pullS(); this.dp = this.pullS();
          this.x = this.pullS16(); this.y = this.pullS16(); this.u = this.pullS16(); this.cycles += 9;
        }
        this.pc = this.pullS16(); return;
      }
      case 0xA3: this.word('lsr', this.operand()); return;
      case 0xA4: this.word('ror', this.operand()); return;
      case 0xA5: this.word('asr', this.operand()); return;
      case 0xA6: this.word('asl', this.operand()); return;
      case 0xA7: this.word('rol', this.operand()); return;
      case 0xA8: this.pc = this.operand(); return;
      case 0xA9: { const ea = this.operand(); this.pushS16(this.pc); this.pc = ea; return; }
      case 0xAA: { const o = this.sx8(this.fetch()); this.pushS16(this.pc); this.pc = (this.pc + o) & 0xFFFF; return; }
      case 0xAB: { const o = this.fetch16(); this.pushS16(this.pc); this.pc = (this.pc + o) & 0xFFFF; return; }
      case 0xAC: {                                    // DECB, branch if not zero
        this.b = (this.b - 1) & 0xFF; this.cc = (this.cc & ~V) | (this.b === 0x7F ? V : 0); this.nz8(this.b);
        const o = this.sx8(this.fetch()); if (this.b) this.pc = (this.pc + o) & 0xFFFF; return;
      }
      case 0xAD: {                                    // DECX, branch if not zero
        this.x = (this.x - 1) & 0xFFFF; this.cc &= ~V; this.nz16(this.x);
        const o = this.sx8(this.fetch()); if (this.x) this.pc = (this.pc + o) & 0xFFFF; return;
      }
      case 0xAE: return;                              // NOP
      case 0xB0: this.x = (this.x + this.b) & 0xFFFF; return;      // ABX
      case 0xB1: {                                    // DAA
        let cf = 0; const msn = this.a & 0xF0, lsn = this.a & 0x0F;
        if (lsn > 9 || (this.cc & H)) cf |= 0x06;
        if (msn > 0x80 && lsn > 9) cf |= 0x60;
        if (msn > 0x90 || (this.cc & C)) cf |= 0x60;
        const t = this.a + cf;
        this.cc = (this.cc & ~(V)) | (t & 0x100 ? C : this.cc & C);
        this.a = t & 0xFF; this.nz8(this.a); return;
      }
      case 0xB2: this.a = this.b & 0x80 ? 0xFF : 0; this.nz16(this.d); return;   // SEX
      case 0xB3: { const r = this.a * this.b; this.d = r; this.cc = (this.cc & ~(Z | C)) | (r ? 0 : Z) | (r & 0x80 ? C : 0); return; }   // MUL
      case 0xB4: { const t = (this.x * this.y) >>> 0; this.x = t >>> 16; this.y = t & 0xFFFF;
        this.cc = (this.cc & ~(Z | C)) | (t ? 0 : Z) | (t & 0x8000 ? C : 0); return; }    // LMUL
      case 0xB5: {                                    // DIVX
        let t = 0, r = 0;
        if (this.b) { t = Math.floor(this.x / this.b); r = this.x % this.b; }
        this.cc = (this.cc & ~(Z | C)) | ((t & 0xFFFF) ? 0 : Z) | (t & 0x80 ? C : 0);
        this.x = t & 0xFFFF; this.b = r & 0xFF; return;
      }
      case 0xB6:                                      // BMOVE: U bytes from Y to X
        while (this.u) { this.write(this.x, this.read(this.y)); this.x = (this.x + 1) & 0xFFFF; this.y = (this.y + 1) & 0xFFFF; this.u = (this.u - 1) & 0xFFFF; this.cycles += 2; }
        return;
      case 0xB7: this.write(this.x, this.read(this.y)); this.x = (this.x + 1) & 0xFFFF; this.y = (this.y + 1) & 0xFFFF; this.u = (this.u - 1) & 0xFFFF; return;
      case 0xB8: this.dshift('lsr', this.fetch()); return;
      case 0xB9: this.dshift('lsr', this.read(this.operand())); return;
      case 0xBA: this.dshift('ror', this.fetch()); return;
      case 0xBB: this.dshift('ror', this.read(this.operand())); return;
      case 0xBC: this.dshift('asr', this.fetch()); return;
      case 0xBD: this.dshift('asr', this.read(this.operand())); return;
      case 0xBE: this.dshift('asl', this.fetch()); return;
      case 0xBF: this.dshift('asl', this.read(this.operand())); return;
      case 0xC0: this.dshift('rol', this.fetch()); return;
      case 0xC1: this.dshift('rol', this.read(this.operand())); return;
      case 0xC2: this.d = 0; this.cc = (this.cc & ~(N | V | C)) | Z; return;
      case 0xC3: this.word('clr', this.operand()); return;
      case 0xC4: { const t = this.d, r = (-t) & 0xFFFF; this.cc = (this.cc & ~(N | Z | V | C)) | (r ? C : 0) | (t === 0x8000 ? V : 0); this.nz16(r); this.d = r; return; }
      case 0xC5: this.word('neg', this.operand()); return;
      case 0xC6: { const t = this.d; this.d = (t + 1) & 0xFFFF; this.cc = (this.cc & ~V) | (t === 0x7FFF ? V : 0); this.nz16(this.d); return; }
      case 0xC7: this.word('inc', this.operand()); return;
      case 0xC8: { const t = this.d; this.d = (t - 1) & 0xFFFF; this.cc = (this.cc & ~V) | (t === 0x8000 ? V : 0); this.nz16(this.d); return; }
      case 0xC9: this.word('dec', this.operand()); return;
      case 0xCA: this.cc &= ~V; this.nz16(this.d); return;
      case 0xCB: this.word('tst', this.operand()); return;
      case 0xCC: { const t = this.a, r = t & 0x80 ? (-t) & 0xFF : t; this.cc = (this.cc & ~(N | Z | V | C)) | (t === 0x80 ? V : 0) | (t & 0x80 ? C : 0); this.nz8(r); this.a = r; return; }
      case 0xCD: { const t = this.b, r = t & 0x80 ? (-t) & 0xFF : t; this.cc = (this.cc & ~(N | Z | V | C)) | (t === 0x80 ? V : 0) | (t & 0x80 ? C : 0); this.nz8(r); this.b = r; return; }
      case 0xCE: { const t = this.d, r = t & 0x8000 ? (-t) & 0xFFFF : t; this.cc = (this.cc & ~(N | Z | V | C)) | (t === 0x8000 ? V : 0) | (t & 0x8000 ? C : 0); this.nz16(r); this.d = r; return; }
      case 0xCF:                                      // BSET: A into U bytes from X
        while (this.u) { this.write(this.x, this.a); this.x = (this.x + 1) & 0xFFFF; this.u = (this.u - 1) & 0xFFFF; this.cycles += 2; }
        return;
      case 0xD0:                                      // BSET2: D into U words from X
        while (this.u) { this.write16(this.x, this.d); this.x = (this.x + 2) & 0xFFFF; this.u = (this.u - 1) & 0xFFFF; this.cycles += 3; }
        return;
    }
    // Anything else is undefined on the chip; treat as a 1-cycle no-op.
  }
}
