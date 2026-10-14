// Motorola 68000: the full user and supervisor instruction set, exceptions
// (traps, CHK, divide by zero, illegal and line A/F opcodes, privilege
// violations) and autovectored interrupts. Address errors are not modeled.
//
// The host supplies a 24-bit bus: read8/read16/write8/write16 (word accesses
// are always at even addresses). Interrupts: set `irq` to the level (1-7) on
// the CPU's IPL pins; the CPU calls onIrqAck(level) when it takes one (for
// "hold until acknowledged" lines) and uses autovectors.
//
// Timing is approximate: four clocks for every bus word, plus the internal
// time of the slow instructions (multiply, divide, shifts, exceptions).

import { capture, apply } from './state.js';

const STATE = ['d', 'a', 'pc', 'usp', 'ssp', 's', 'intMask', 't', 'xf', 'nf', 'zf', 'vf', 'cf', 'irq', 'stopped', 'cycles'];
const MSB = [0, 0x80, 0x8000, 0, 0x80000000];
const MASK = [0, 0xFF, 0xFFFF, 0, 0xFFFFFFFF];
const SIZE_OF = [1, 2, 4];                       // the usual size field (00 byte, 01 word, 10 long)

const sext8 = (v) => (v << 24) >> 24;
const sext16 = (v) => (v << 16) >> 16;

export class M68000 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor({ read8, read16, write8, write16 }) {
    this.read8 = read8; this.read16 = read16; this.write8 = write8; this.write16 = write16;
    this.onIrqAck = null;
    this.d = new Int32Array(8);
    this.a = new Int32Array(8);
    this.table = OPS;
    this.reset();
  }

  reset() {
    this.d.fill(0); this.a.fill(0);
    this.usp = 0; this.ssp = 0;
    this.s = 1; this.t = 0; this.intMask = 7;
    this.xf = this.nf = this.zf = this.vf = this.cf = 0;
    this.irq = 0; this.stopped = 0;
    this.cycles = this.cycles || 0;
    this.a[7] = this.rl(0);
    this.pc = this.rl(4) & 0xFFFFFF;
  }

  // ---------------------------------------------------------------- bus

  rb(a) { this.cycles += 4; return this.read8(a & 0xFFFFFF); }
  rw(a) { this.cycles += 4; return this.read16(a & 0xFFFFFE); }
  rl(a) { this.cycles += 8; a &= 0xFFFFFE; return ((this.read16(a) << 16) | this.read16((a + 2) & 0xFFFFFE)) >>> 0; }
  wb(a, v) { this.cycles += 4; this.write8(a & 0xFFFFFF, v & 0xFF); }
  ww(a, v) { this.cycles += 4; this.write16(a & 0xFFFFFE, v & 0xFFFF); }
  wl(a, v) { this.cycles += 8; a &= 0xFFFFFE; this.write16(a, (v >>> 16) & 0xFFFF); this.write16((a + 2) & 0xFFFFFE, v & 0xFFFF); }
  read(a, sz) { return sz === 1 ? this.rb(a) : sz === 2 ? this.rw(a) : this.rl(a); }
  write(a, sz, v) { if (sz === 1) this.wb(a, v); else if (sz === 2) this.ww(a, v); else this.wl(a, v); }

  fetch() { const v = this.rw(this.pc); this.pc = (this.pc + 2) & 0xFFFFFF; return v; }
  fetchL() { const hi = this.fetch(); return ((hi << 16) | this.fetch()) >>> 0; }
  push16(v) { this.a[7] -= 2; this.ww(this.a[7], v); }
  push32(v) { this.a[7] -= 4; this.wl(this.a[7], v); }
  pop16() { const v = this.rw(this.a[7]); this.a[7] += 2; return v; }
  pop32() { const v = this.rl(this.a[7]); this.a[7] += 4; return v; }

  // ---------------------------------------------------------------- status register

  get sr() {
    return (this.t << 15) | (this.s << 13) | (this.intMask << 8) | (this.xf << 4) | (this.nf << 3) | (this.zf << 2) | (this.vf << 1) | this.cf;
  }
  set sr(v) {
    this.t = (v >> 15) & 1; this.intMask = (v >> 8) & 7;
    this.setCCR(v);
    const s = (v >> 13) & 1;
    if (s !== this.s) {
      if (s) { this.usp = this.a[7]; this.a[7] = this.ssp; } else { this.ssp = this.a[7]; this.a[7] = this.usp; }
      this.s = s;
    }
  }
  setCCR(v) { this.xf = (v >> 4) & 1; this.nf = (v >> 3) & 1; this.zf = (v >> 2) & 1; this.vf = (v >> 1) & 1; this.cf = v & 1; }

  // ---------------------------------------------------------------- exceptions

  exception(vector, pc = this.pc) {
    const old = this.sr;
    this.sr = (old & 0x7FFF) | 0x2000;           // supervisor, trace off
    this.push32(pc);
    this.push16(old);
    this.pc = this.rl(vector * 4) & 0xFFFFFF;
    this.cycles += 26;
  }

  privileged() { if (this.s) return true; this.exception(8, (this.pc - 2) & 0xFFFFFF); return false; }

  // ---------------------------------------------------------------- running

  run(n) {
    const end = this.cycles + n, start = this.cycles;
    while (this.cycles < end) {
      if (this.irq && (this.irq > this.intMask || this.irq === 7)) {
        const level = this.irq;
        this.stopped = 0;
        if (this.onIrqAck) this.onIrqAck(level);
        this.exception(24 + level);
        this.intMask = level;
        continue;
      }
      if (this.stopped) { this.cycles = end; break; }
      this.opPc = this.pc;                 // the current instruction's address (for boards that peek at it)
      const op = this.fetch();
      this.table[op](this, op);
    }
    return this.cycles - start;
  }

  // ---------------------------------------------------------------- effective addresses

  // Brief extension word for d8(An,Xn) and d8(PC,Xn).
  index(base) {
    const ext = this.fetch();
    const r = (ext >> 12) & 7;
    let x = ext & 0x8000 ? this.a[r] : this.d[r];
    if (!(ext & 0x800)) x = sext16(x);
    this.cycles += 2;
    return (base + x + sext8(ext)) | 0;
  }

  // The address of a memory operand (modes 2-7, not immediate).
  addr(mode, reg, sz) {
    switch (mode) {
      case 2: return this.a[reg];
      case 3: { const a = this.a[reg]; this.a[reg] += (reg === 7 && sz === 1) ? 2 : sz; return a; }
      case 4: this.cycles += 2; this.a[reg] -= (reg === 7 && sz === 1) ? 2 : sz; return this.a[reg];
      case 5: return (this.a[reg] + sext16(this.fetch())) | 0;
      case 6: return this.index(this.a[reg]);
      case 7:
        switch (reg) {
          case 0: return sext16(this.fetch());
          case 1: return this.fetchL() | 0;
          case 2: { const pc = this.pc; return (pc + sext16(this.fetch())) | 0; }
          case 3: return this.index(this.pc);
        }
    }
    return 0;
  }

  // Read an operand of any mode (data registers, address registers and immediates too).
  readEA(mode, reg, sz) {
    if (mode === 0) return this.d[reg] & MASK[sz] >>> 0;
    if (mode === 1) return sz === 2 ? this.a[reg] & 0xFFFF : this.a[reg] >>> 0;
    if (mode === 7 && reg === 4) {
      if (sz === 4) return this.fetchL();
      const v = this.fetch();
      return sz === 1 ? v & 0xFF : v;
    }
    return this.read(this.addr(mode, reg, sz), sz) >>> 0;
  }

  // Resolve a destination once (for read-modify-write): returns a token
  // where -1-reg means a data register, otherwise a memory address.
  loc(mode, reg, sz) {
    if (mode === 0) return -1 - reg;
    if (mode === 1) return -9 - reg;
    return this.addr(mode, reg, sz) & 0xFFFFFF;
  }
  readLoc(l, sz) {
    if (l < 0) return l >= -8 ? (this.d[-1 - l] & MASK[sz]) >>> 0 : this.a[-9 - l] >>> 0;
    return this.read(l, sz) >>> 0;
  }
  writeLoc(l, sz, v) {
    if (l < 0) {
      if (l >= -8) {
        const r = -1 - l;
        if (sz === 4) this.d[r] = v; else this.d[r] = (this.d[r] & ~MASK[sz]) | (v & MASK[sz]);
      } else this.a[-9 - l] = v;
      return;
    }
    this.write(l, sz, v);
  }

  // ---------------------------------------------------------------- flags

  logic(v, sz) { v &= MASK[sz]; this.nf = (v & MSB[sz]) ? 1 : 0; this.zf = v === 0 ? 1 : 0; this.vf = this.cf = 0; return v >>> 0; }

  add(s, d, sz, x = 0) {
    const m = MASK[sz], msb = MSB[sz];
    s >>>= 0; d >>>= 0;
    const sum = sz === 4 ? s + d + x : (s & m) + (d & m) + x;
    const r = sz === 4 ? sum >>> 0 : sum & m;
    this.cf = this.xf = sum > m ? 1 : 0;
    this.vf = ((s ^ r) & (d ^ r) & msb) ? 1 : 0;
    this.nf = (r & msb) ? 1 : 0;
    return r;
  }
  sub(s, d, sz, x = 0) {
    const m = MASK[sz], msb = MSB[sz];
    s = (s >>> 0) & m; d = (d >>> 0) & m;
    if (sz === 4) { s >>>= 0; d >>>= 0; }
    const diff = d - s - x;
    const r = sz === 4 ? diff >>> 0 : diff & m;
    this.cf = this.xf = diff < 0 ? 1 : 0;
    this.vf = ((s ^ d) & (r ^ d) & msb) ? 1 : 0;
    this.nf = (r & msb) ? 1 : 0;
    return r;
  }
  cmp(s, d, sz) { const x = this.xf; const r = this.sub(s, d, sz); this.xf = x; this.zf = r === 0 ? 1 : 0; }

  cond(c) {
    switch (c) {
      case 0: return true;
      case 1: return false;
      case 2: return !this.cf && !this.zf;          // HI
      case 3: return !!(this.cf || this.zf);        // LS
      case 4: return !this.cf;                      // CC
      case 5: return !!this.cf;                     // CS
      case 6: return !this.zf;                      // NE
      case 7: return !!this.zf;                     // EQ
      case 8: return !this.vf;                      // VC
      case 9: return !!this.vf;                     // VS
      case 10: return !this.nf;                     // PL
      case 11: return !!this.nf;                    // MI
      case 12: return this.nf === this.vf;          // GE
      case 13: return this.nf !== this.vf;          // LT
      case 14: return !this.zf && this.nf === this.vf;   // GT
      default: return !!this.zf || this.nf !== this.vf;  // LE
    }
  }
}

// ---------------------------------------------------------------- the instructions

const OPS = new Array(65536);

function illegal(c, op) {
  const line = op >> 12;
  c.exception(line === 0xA ? 10 : line === 0xF ? 11 : 4, (c.pc - 2) & 0xFFFFFF);
}

// Which addressing modes an instruction accepts.
const isData = (m, r) => m !== 1 && !(m === 7 && r > 4);
const isMem = (m, r) => m >= 2 && !(m === 7 && r > 4);
const isAlt = (m, r) => m < 7 || r < 2;                       // alterable (no PC-relative or immediate)
const isDataAlt = (m, r) => m !== 1 && isAlt(m, r);
const isMemAlt = (m, r) => m >= 2 && isAlt(m, r);
const isControl = (m, r) => m === 2 || m === 5 || m === 6 || (m === 7 && r < 4);
const isAny = (m, r) => !(m === 7 && r > 4);

function def(mask, match, fn) {
  for (let op = 0; op < 65536; op++) if ((op & mask) === match && !OPS[op]) OPS[op] = fn;
}
// Like def, but only where the EA field (bits 0-5) passes `ok`.
function defEA(mask, match, ok, fn) {
  for (let op = 0; op < 65536; op++) {
    if ((op & mask) === match && !OPS[op] && ok((op >> 3) & 7, op & 7, op)) OPS[op] = fn;
  }
}

// ---- immediate ALU ops (ORI, ANDI, SUBI, ADDI, EORI, CMPI) and to CCR/SR
def(0xFFFF, 0x003C, (c) => { c.setCCR(c.sr | (c.fetch() & 0x1F)); });                       // ORI to CCR
def(0xFFFF, 0x007C, (c) => { const v = c.fetch(); if (c.privileged()) c.sr = c.sr | v; });  // ORI to SR
def(0xFFFF, 0x023C, (c) => { c.setCCR(c.sr & c.fetch()); });                                 // ANDI to CCR
def(0xFFFF, 0x027C, (c) => { const v = c.fetch(); if (c.privileged()) c.sr = c.sr & v; });  // ANDI to SR
def(0xFFFF, 0x0A3C, (c) => { c.setCCR(c.sr ^ (c.fetch() & 0x1F)); });                       // EORI to CCR
def(0xFFFF, 0x0A7C, (c) => { const v = c.fetch(); if (c.privileged()) c.sr = c.sr ^ v; });  // EORI to SR

for (const [base, kind] of [[0x0000, 'or'], [0x0200, 'and'], [0x0400, 'sub'], [0x0600, 'add'], [0x0A00, 'eor'], [0x0C00, 'cmp']]) {
  for (let s = 0; s < 3; s++) {
    const sz = SIZE_OF[s];
    defEA(0xFFC0, base | (s << 6), kind === 'cmp' ? isData : isDataAlt, (c, op) => {
      const imm = sz === 4 ? c.fetchL() : sz === 2 ? c.fetch() : c.fetch() & 0xFF;
      const l = c.loc((op >> 3) & 7, op & 7, sz);
      const d = c.readLoc(l, sz);
      let r;
      switch (kind) {
        case 'or': r = c.logic(d | imm, sz); break;
        case 'and': r = c.logic(d & imm, sz); break;
        case 'eor': r = c.logic(d ^ imm, sz); break;
        case 'add': r = c.add(imm, d, sz); c.zf = r === 0 ? 1 : 0; break;
        case 'sub': r = c.sub(imm, d, sz); c.zf = r === 0 ? 1 : 0; break;
        case 'cmp': c.cmp(imm, d, sz); return;
      }
      c.writeLoc(l, sz, r);
    });
  }
}

// ---- bit operations: BTST/BCHG/BCLR/BSET, dynamic (Dn) and static (#imm)
function bitOp(c, op, bit) {
  const mode = (op >> 3) & 7, reg = op & 7, type = (op >> 6) & 3;
  if (mode === 0) {
    bit &= 31;
    const v = c.d[reg];
    c.zf = (v >>> bit) & 1 ? 0 : 1;
    if (type === 1) c.d[reg] = v ^ (1 << bit);
    else if (type === 2) c.d[reg] = v & ~(1 << bit);
    else if (type === 3) c.d[reg] = v | (1 << bit);
    c.cycles += type ? 4 : 2;
    return;
  }
  bit &= 7;
  if (type === 0) { c.zf = (c.readEA(mode, reg, 1) >> bit) & 1 ? 0 : 1; return; }
  const a = c.addr(mode, reg, 1), v = c.rb(a);
  c.zf = (v >> bit) & 1 ? 0 : 1;
  c.wb(a, type === 1 ? v ^ (1 << bit) : type === 2 ? v & ~(1 << bit) : v | (1 << bit));
}
// MOVEP (0000 ddd1 ss00 1aaa) comes before the dynamic bit ops, which share the pattern.
def(0xF138, 0x0108, (c, op) => {
  const dr = (op >> 9) & 7, ar = op & 7, mode = (op >> 6) & 3;
  let a = (c.a[ar] + sext16(c.fetch())) | 0;
  if (mode === 0) { c.d[dr] = (c.d[dr] & ~0xFFFF) | (c.rb(a) << 8) | c.rb(a + 2); }
  else if (mode === 1) { c.d[dr] = (c.rb(a) << 24) | (c.rb(a + 2) << 16) | (c.rb(a + 4) << 8) | c.rb(a + 6); }
  else if (mode === 2) { const v = c.d[dr]; c.wb(a, v >> 8); c.wb(a + 2, v); }
  else { const v = c.d[dr]; c.wb(a, v >> 24); c.wb(a + 2, v >> 16); c.wb(a + 4, v >> 8); c.wb(a + 6, v); }
});
defEA(0xF1C0, 0x0100, isData, (c, op) => bitOp(c, op, c.d[(op >> 9) & 7]));                   // BTST Dn
defEA(0xF1C0, 0x0140, isDataAlt, (c, op) => bitOp(c, op, c.d[(op >> 9) & 7]));
defEA(0xF1C0, 0x0180, isDataAlt, (c, op) => bitOp(c, op, c.d[(op >> 9) & 7]));
defEA(0xF1C0, 0x01C0, isDataAlt, (c, op) => bitOp(c, op, c.d[(op >> 9) & 7]));
defEA(0xFFC0, 0x0800, (m, r) => isData(m, r) && !(m === 7 && r === 4), (c, op) => bitOp(c, op, c.fetch()));   // BTST #
defEA(0xFFC0, 0x0840, isDataAlt, (c, op) => bitOp(c, op, c.fetch()));
defEA(0xFFC0, 0x0880, isDataAlt, (c, op) => bitOp(c, op, c.fetch()));
defEA(0xFFC0, 0x08C0, isDataAlt, (c, op) => bitOp(c, op, c.fetch()));

// ---- MOVE and MOVEA
for (const [line, sz] of [[1, 1], [3, 2], [2, 4]]) {
  for (let op = line << 12; op < (line + 1) << 12; op++) {
    const sm = (op >> 3) & 7, sr = op & 7, dm = (op >> 6) & 7, dr = (op >> 9) & 7;
    if (!isAny(sm, sr) || (sz === 1 && sm === 1)) continue;
    if (dm === 1) {
      if (sz === 1) continue;
      OPS[op] = (c) => { const v = c.readEA(sm, sr, sz); c.a[dr] = sz === 2 ? sext16(v) : v; };   // MOVEA
      continue;
    }
    if (!isAlt(dm, dr)) continue;
    OPS[op] = (c) => {
      const v = c.readEA(sm, sr, sz);
      c.logic(v, sz);
      c.writeLoc(c.loc(dm, dr, sz), sz, v);
    };
  }
}

// ---- line 4: miscellaneous
for (let s = 0; s < 3; s++) {
  const sz = SIZE_OF[s];
  defEA(0xFFC0, 0x4000 | (s << 6), isDataAlt, (c, op) => {                          // NEGX
    const l = c.loc((op >> 3) & 7, op & 7, sz), z = c.zf;
    const r = c.sub(c.readLoc(l, sz), 0, sz, c.xf);
    c.zf = r === 0 ? z : 0;
    c.writeLoc(l, sz, r);
  });
  defEA(0xFFC0, 0x4200 | (s << 6), isDataAlt, (c, op) => {                          // CLR
    c.writeLoc(c.loc((op >> 3) & 7, op & 7, sz), sz, 0);
    c.nf = c.vf = c.cf = 0; c.zf = 1;
  });
  defEA(0xFFC0, 0x4400 | (s << 6), isDataAlt, (c, op) => {                          // NEG
    const l = c.loc((op >> 3) & 7, op & 7, sz);
    const r = c.sub(c.readLoc(l, sz), 0, sz);
    c.zf = r === 0 ? 1 : 0;
    c.writeLoc(l, sz, r);
  });
  defEA(0xFFC0, 0x4600 | (s << 6), isDataAlt, (c, op) => {                          // NOT
    const l = c.loc((op >> 3) & 7, op & 7, sz);
    c.writeLoc(l, sz, c.logic(~c.readLoc(l, sz), sz));
  });
  defEA(0xFFC0, 0x4A00 | (s << 6), (m, r) => isAny(m, r) && !(sz === 1 && m === 1), (c, op) => {   // TST
    c.logic(c.readEA((op >> 3) & 7, op & 7, sz), sz);
  });
}
defEA(0xFFC0, 0x40C0, isDataAlt, (c, op) => { c.writeLoc(c.loc((op >> 3) & 7, op & 7, 2), 2, c.sr); });       // MOVE from SR
defEA(0xFFC0, 0x44C0, isData, (c, op) => { c.setCCR(c.readEA((op >> 3) & 7, op & 7, 2)); });                   // MOVE to CCR
defEA(0xFFC0, 0x46C0, isData, (c, op) => { if (c.privileged()) c.sr = c.readEA((op >> 3) & 7, op & 7, 2); });  // MOVE to SR
defEA(0xFFC0, 0x4800, isDataAlt, (c, op) => {                                         // NBCD
  const l = c.loc((op >> 3) & 7, op & 7, 1);
  c.writeLoc(l, 1, sbcd(c, c.readLoc(l, 1), 0));
});
def(0xFFF8, 0x4840, (c, op) => { const r = op & 7, v = c.d[r]; c.d[r] = (v >>> 16) | (v << 16); c.logic(c.d[r], 4); });   // SWAP
defEA(0xFFC0, 0x4840, isControl, (c, op) => { c.push32(c.addr((op >> 3) & 7, op & 7, 4)); });                  // PEA
def(0xFFF8, 0x4880, (c, op) => { const r = op & 7; const v = sext8(c.d[r]) & 0xFFFF; c.d[r] = (c.d[r] & ~0xFFFF) | v; c.logic(v, 2); });   // EXT.W
def(0xFFF8, 0x48C0, (c, op) => { const r = op & 7; c.d[r] = sext16(c.d[r]); c.logic(c.d[r], 4); });            // EXT.L
// MOVEM registers to memory (4880/48C0 with a memory EA) and memory to registers (4C80/4CC0).
defEA(0xFF80, 0x4880, (m, r) => m === 4 || isControl(m, r) && isAlt(m, r), (c, op) => {
  const sz = op & 0x40 ? 4 : 2, mask = c.fetch(), mode = (op >> 3) & 7, reg = op & 7;
  if (mode === 4) {
    // Predecrement: the mask runs A7..A0, D7..D0.
    let a = c.a[reg];
    for (let i = 0; i < 16; i++) {
      if (!(mask & (1 << i))) continue;
      a -= sz;
      const v = i < 8 ? c.a[7 - i] : c.d[15 - i];
      c.write(a, sz, v);
    }
    c.a[reg] = a;
    return;
  }
  let a = c.addr(mode, reg, sz);
  for (let i = 0; i < 16; i++) {
    if (!(mask & (1 << i))) continue;
    c.write(a, sz, i < 8 ? c.d[i] : c.a[i - 8]);
    a += sz;
  }
});
defEA(0xFF80, 0x4C80, (m, r) => m === 3 || isControl(m, r), (c, op) => {
  const sz = op & 0x40 ? 4 : 2, mask = c.fetch(), mode = (op >> 3) & 7, reg = op & 7;
  let a = mode === 3 ? c.a[reg] : c.addr(mode, reg, sz);
  for (let i = 0; i < 16; i++) {
    if (!(mask & (1 << i))) continue;
    const v = sz === 2 ? sext16(c.rw(a)) : c.rl(a) | 0;
    if (i < 8) c.d[i] = v; else c.a[i - 8] = v;
    a += sz;
  }
  if (mode === 3) c.a[reg] = a;
  c.cycles += 4;
});
def(0xFFFF, 0x4AFC, illegal);                                                         // ILLEGAL
defEA(0xFFC0, 0x4AC0, isDataAlt, (c, op) => {                                         // TAS
  const l = c.loc((op >> 3) & 7, op & 7, 1), v = c.readLoc(l, 1);
  c.logic(v, 1);
  c.writeLoc(l, 1, v | 0x80);
});
def(0xFFF0, 0x4E40, (c, op) => c.exception(32 + (op & 15)));                          // TRAP
def(0xFFF8, 0x4E50, (c, op) => {                                                      // LINK
  const r = op & 7, disp = sext16(c.fetch());
  c.push32(c.a[r]);
  c.a[r] = c.a[7];
  c.a[7] += disp;
});
def(0xFFF8, 0x4E58, (c, op) => { const r = op & 7; c.a[7] = c.a[r]; c.a[r] = c.pop32() | 0; });    // UNLK
def(0xFFF8, 0x4E60, (c, op) => { if (c.privileged()) c.usp = c.a[op & 7]; });                    // MOVE An,USP
def(0xFFF8, 0x4E68, (c, op) => { if (c.privileged()) c.a[op & 7] = c.usp; });                    // MOVE USP,An
def(0xFFFF, 0x4E70, (c) => { if (c.privileged()) c.cycles += 128; });                           // RESET
def(0xFFFF, 0x4E71, () => {});                                                                   // NOP
def(0xFFFF, 0x4E72, (c) => { const v = c.fetch(); if (c.privileged()) { c.sr = v; c.stopped = 1; } });   // STOP
def(0xFFFF, 0x4E73, (c) => {                                                                     // RTE
  if (!c.privileged()) return;
  const sr = c.pop16(), pc = c.pop32();
  c.sr = sr; c.pc = pc & 0xFFFFFF;
});
def(0xFFFF, 0x4E75, (c) => { c.pc = c.pop32() & 0xFFFFFF; });                                    // RTS
def(0xFFFF, 0x4E76, (c) => { if (c.vf) c.exception(7); });                                       // TRAPV
def(0xFFFF, 0x4E77, (c) => { c.setCCR(c.pop16()); c.pc = c.pop32() & 0xFFFFFF; });               // RTR
defEA(0xFFC0, 0x4E80, isControl, (c, op) => { const a = c.addr((op >> 3) & 7, op & 7, 4); c.push32(c.pc); c.pc = a & 0xFFFFFF; });   // JSR
defEA(0xFFC0, 0x4EC0, isControl, (c, op) => { c.pc = c.addr((op >> 3) & 7, op & 7, 4) & 0xFFFFFF; });                                 // JMP
defEA(0xF1C0, 0x4180, isData, (c, op) => {                                            // CHK.W
  const bound = sext16(c.readEA((op >> 3) & 7, op & 7, 2)), v = sext16(c.d[(op >> 9) & 7]);
  if (v < 0) { c.nf = 1; c.exception(6); } else if (v > bound) { c.nf = 0; c.exception(6); }
});
defEA(0xF1C0, 0x41C0, isControl, (c, op) => { c.a[(op >> 9) & 7] = c.addr((op >> 3) & 7, op & 7, 4); });   // LEA

// ---- line 5: ADDQ/SUBQ, Scc, DBcc
for (let s = 0; s < 3; s++) {
  const sz = SIZE_OF[s];
  for (const sub of [0, 1]) {
    defEA(0xF1C0, 0x5000 | (sub << 8) | (s << 6), (m, r) => isAlt(m, r) && !(sz === 1 && m === 1), (c, op) => {
      const q = ((op >> 9) & 7) || 8, mode = (op >> 3) & 7, reg = op & 7;
      if (mode === 1) { c.a[reg] += sub ? -q : q; return; }   // address registers: whole register, flags untouched
      const l = c.loc(mode, reg, sz), d = c.readLoc(l, sz);
      const r = sub ? c.sub(q, d, sz) : c.add(q, d, sz);
      c.zf = r === 0 ? 1 : 0;
      c.writeLoc(l, sz, r);
    });
  }
}
def(0xF0F8, 0x50C8, (c, op) => {                                                     // DBcc
  const pc = c.pc, disp = sext16(c.fetch()), r = op & 7;
  if (c.cond((op >> 8) & 15)) { c.cycles += 4; return; }
  const v = (c.d[r] - 1) & 0xFFFF;
  c.d[r] = (c.d[r] & ~0xFFFF) | v;
  if (v !== 0xFFFF) c.pc = (pc + disp) & 0xFFFFFF; else c.cycles += 4;
});
defEA(0xF0C0, 0x50C0, isDataAlt, (c, op) => {                                         // Scc
  c.writeLoc(c.loc((op >> 3) & 7, op & 7, 1), 1, c.cond((op >> 8) & 15) ? 0xFF : 0);
});

// ---- line 6: Bcc, BRA, BSR
def(0xF000, 0x6000, (c, op) => {
  const cc = (op >> 8) & 15, pc = c.pc;
  let disp = sext8(op);
  if (disp === 0) disp = sext16(c.fetch());
  if (cc === 1) { c.push32(c.pc); c.pc = (pc + disp) & 0xFFFFFF; return; }   // BSR
  if (c.cond(cc)) { c.pc = (pc + disp) & 0xFFFFFF; c.cycles += 2; }
});

// ---- line 7: MOVEQ
def(0xF100, 0x7000, (c, op) => { const v = sext8(op); c.d[(op >> 9) & 7] = v; c.logic(v, 4); });

// ---- lines 8, 9, B, C, D: register/EA arithmetic
function bcd(c, s, d, x) {
  // ABCD: decimal add with extend.
  let lo = (s & 15) + (d & 15) + x, hi = (s >> 4) + (d >> 4);
  if (lo > 9) { lo -= 10; hi++; }
  c.cf = c.xf = hi > 9 ? 1 : 0;
  if (hi > 9) hi -= 10;
  const r = ((hi << 4) | lo) & 0xFF;
  if (r) c.zf = 0;
  c.nf = (r >> 7) & 1;
  return r;
}
function sbcd(c, s, d) {
  // SBCD/NBCD: decimal d - s - X.
  const x = c.xf;
  let lo = (d & 15) - (s & 15) - x, hi = (d >> 4) - (s >> 4);
  if (lo < 0) { lo += 10; hi--; }
  c.cf = c.xf = hi < 0 ? 1 : 0;
  if (hi < 0) hi += 10;
  const r = ((hi << 4) | lo) & 0xFF;
  if (r) c.zf = 0;
  c.nf = (r >> 7) & 1;
  return r;
}

// ABCD/SBCD (Dy,Dx or -(Ay),-(Ax)), ADDX/SUBX, CMPM and EXG share encodings with the
// general forms, so they're defined first.
for (const [base, kind] of [[0xC100, 'abcd'], [0x8100, 'sbcd']]) {
  def(0xF1F8, base, (c, op) => {
    const rx = (op >> 9) & 7, ry = op & 7;
    const r = kind === 'abcd' ? bcd(c, c.d[ry] & 0xFF, c.d[rx] & 0xFF, c.xf) : sbcd(c, c.d[ry] & 0xFF, c.d[rx] & 0xFF);
    c.d[rx] = (c.d[rx] & ~0xFF) | r;
    c.cycles += 2;
  });
  def(0xF1F8, base | 8, (c, op) => {
    const rx = (op >> 9) & 7, ry = op & 7;
    const s = c.rb(c.addr(4, ry, 1)), ax = c.addr(4, rx, 1), d = c.rb(ax);
    c.wb(ax, kind === 'abcd' ? bcd(c, s, d, c.xf) : sbcd(c, s, d));
  });
}
for (let s = 0; s < 3; s++) {
  const sz = SIZE_OF[s];
  for (const [base, sub] of [[0xD100, 0], [0x9100, 1]]) {
    def(0xF1F8, base | (s << 6), (c, op) => {                                       // ADDX/SUBX Dy,Dx
      const rx = (op >> 9) & 7, ry = op & 7, z = c.zf;
      const r = sub ? c.sub(c.d[ry], c.d[rx], sz, c.xf) : c.add(c.d[ry], c.d[rx], sz, c.xf);
      c.zf = r === 0 ? z : 0;
      c.writeLoc(-1 - rx, sz, r);
    });
    def(0xF1F8, base | (s << 6) | 8, (c, op) => {                                   // ADDX/SUBX -(Ay),-(Ax)
      const rx = (op >> 9) & 7, ry = op & 7, z = c.zf;
      const sv = c.read(c.addr(4, ry, sz), sz), ax = c.addr(4, rx, sz), dv = c.read(ax, sz);
      const r = sub ? c.sub(sv, dv, sz, c.xf) : c.add(sv, dv, sz, c.xf);
      c.zf = r === 0 ? z : 0;
      c.write(ax, sz, r);
    });
  }
  def(0xF1F8, 0xB108 | (s << 6), (c, op) => {                                      // CMPM (Ay)+,(Ax)+
    const sv = c.read(c.addr(3, op & 7, sz), sz), dv = c.read(c.addr(3, (op >> 9) & 7, sz), sz);
    c.cmp(sv, dv, sz);
  });
}
def(0xF1F8, 0xC140, (c, op) => { const x = (op >> 9) & 7, y = op & 7, t = c.d[x]; c.d[x] = c.d[y]; c.d[y] = t; c.cycles += 2; });   // EXG Dx,Dy
def(0xF1F8, 0xC148, (c, op) => { const x = (op >> 9) & 7, y = op & 7, t = c.a[x]; c.a[x] = c.a[y]; c.a[y] = t; c.cycles += 2; });   // EXG Ax,Ay
def(0xF1F8, 0xC188, (c, op) => { const x = (op >> 9) & 7, y = op & 7, t = c.d[x]; c.d[x] = c.a[y]; c.a[y] = t; c.cycles += 2; });   // EXG Dx,Ay

// MULU/MULS, DIVU/DIVS.
defEA(0xF1C0, 0xC0C0, isData, (c, op) => {
  const r = (op >> 9) & 7, v = Math.imul(c.d[r] & 0xFFFF, c.readEA((op >> 3) & 7, op & 7, 2));
  c.d[r] = v; c.logic(v, 4); c.cycles += 54;
});
defEA(0xF1C0, 0xC1C0, isData, (c, op) => {
  const r = (op >> 9) & 7, v = Math.imul(sext16(c.d[r]), sext16(c.readEA((op >> 3) & 7, op & 7, 2)));
  c.d[r] = v; c.logic(v, 4); c.cycles += 54;
});
defEA(0xF1C0, 0x80C0, isData, (c, op) => {
  const r = (op >> 9) & 7, s = c.readEA((op >> 3) & 7, op & 7, 2);
  if (s === 0) { c.exception(5); return; }
  const d = c.d[r] >>> 0, q = Math.floor(d / s);
  c.cycles += 136;
  if (q > 0xFFFF) { c.vf = 1; c.cf = 0; c.nf = 1; return; }
  c.d[r] = ((d % s) << 16) | q;
  c.nf = (q >> 15) & 1; c.zf = q === 0 ? 1 : 0; c.vf = c.cf = 0;
});
defEA(0xF1C0, 0x81C0, isData, (c, op) => {
  const r = (op >> 9) & 7, s = sext16(c.readEA((op >> 3) & 7, op & 7, 2));
  if (s === 0) { c.exception(5); return; }
  const d = c.d[r], q = Math.trunc(d / s);
  c.cycles += 154;
  if (q > 32767 || q < -32768) { c.vf = 1; c.cf = 0; c.nf = 1; return; }
  const rem = d - q * s;
  c.d[r] = ((rem & 0xFFFF) << 16) | (q & 0xFFFF);
  c.nf = (q >> 15) & 1; c.zf = q === 0 ? 1 : 0; c.vf = c.cf = 0;
});

// OR, SUB, CMP/EOR, AND, ADD: <ea>,Dn and Dn,<ea>; SUBA/CMPA/ADDA.
const ALU = { 0x8: 'or', 0x9: 'sub', 0xB: 'cmp', 0xC: 'and', 0xD: 'add' };
for (const lineStr of Object.keys(ALU)) {
  const line = +lineStr, kind = ALU[line];
  for (let s = 0; s < 3; s++) {
    const sz = SIZE_OF[s];
    // <ea> op Dn -> Dn
    defEA(0xF1C0, (line << 12) | (s << 6), (m, r) => isAny(m, r) && !(m === 1 && (sz === 1 || kind === 'or' || kind === 'and')), (c, op) => {
      const dr = (op >> 9) & 7, src = c.readEA((op >> 3) & 7, op & 7, sz), d = c.d[dr] >>> 0;
      let r;
      switch (kind) {
        case 'or': r = c.logic(d | src, sz); break;
        case 'and': r = c.logic(d & src, sz); break;
        case 'add': r = c.add(src, d, sz); c.zf = r === 0 ? 1 : 0; break;
        case 'sub': r = c.sub(src, d, sz); c.zf = r === 0 ? 1 : 0; break;
        case 'cmp': c.cmp(src, d, sz); return;
      }
      c.writeLoc(-1 - dr, sz, r);
      if (sz === 4) c.cycles += 2;
    });
    // Dn op <ea> -> <ea> (CMP's slot here is EOR)
    defEA(0xF1C0, (line << 12) | 0x100 | (s << 6), kind === 'cmp' ? isDataAlt : isMemAlt, (c, op) => {
      const src = c.d[(op >> 9) & 7] >>> 0, l = c.loc((op >> 3) & 7, op & 7, sz), d = c.readLoc(l, sz);
      let r;
      switch (kind) {
        case 'or': r = c.logic(d | src, sz); break;
        case 'and': r = c.logic(d & src, sz); break;
        case 'cmp': r = c.logic(d ^ src, sz); break;   // EOR
        case 'add': r = c.add(src, d, sz); c.zf = r === 0 ? 1 : 0; break;
        case 'sub': r = c.sub(src, d, sz); c.zf = r === 0 ? 1 : 0; break;
      }
      c.writeLoc(l, sz, r);
    });
  }
  if (kind === 'add' || kind === 'sub' || kind === 'cmp') {
    for (const [opm, sz] of [[0xC0, 2], [0x1C0, 4]]) {                               // ADDA/SUBA/CMPA
      defEA(0xF1C0, (line << 12) | opm, isAny, (c, op) => {
        const ar = (op >> 9) & 7;
        let s = c.readEA((op >> 3) & 7, op & 7, sz);
        if (sz === 2) s = sext16(s);
        if (kind === 'add') c.a[ar] = (c.a[ar] + s) | 0;
        else if (kind === 'sub') c.a[ar] = (c.a[ar] - s) | 0;
        else c.cmp(s, c.a[ar], 4);
        c.cycles += 4;
      });
    }
  }
}

// ---- line E: shifts and rotates
function shift(c, kind, left, v, n, sz) {
  const msb = MSB[sz], m = MASK[sz], bits = sz * 8;
  v = (v >>> 0) & m;
  if (sz === 4) v >>>= 0;
  c.vf = 0;
  if (n === 0) {
    c.cf = kind === 2 ? c.xf : 0;
    c.nf = (v & msb) ? 1 : 0; c.zf = v === 0 ? 1 : 0;
    return v;
  }
  c.cycles += 2 * n;
  for (let i = 0; i < n; i++) {
    let out;
    if (left) {
      out = (v & msb) ? 1 : 0;
      let inBit = 0;
      if (kind === 2) inBit = c.xf; else if (kind === 3) inBit = out;
      const nv = ((v << 1) | inBit) & m;
      if (kind === 0 && ((nv ^ v) & msb)) c.vf = 1;       // ASL: the sign changed along the way
      v = sz === 4 ? nv >>> 0 : nv;
    } else {
      out = v & 1;
      let inBit = 0;
      if (kind === 0) inBit = (v & msb) ? 1 : 0;           // ASR keeps the sign
      else if (kind === 2) inBit = c.xf;
      else if (kind === 3) inBit = out;
      v = (v >>> 1) | (inBit ? msb : 0);
      if (sz === 4) v >>>= 0;
    }
    c.cf = out;
    if (kind !== 3) c.xf = out;                            // rotates without extend leave X alone
  }
  c.nf = (v & msb) ? 1 : 0; c.zf = v === 0 ? 1 : 0;
  void bits;
  return v;
}
for (let s = 0; s < 3; s++) {
  const sz = SIZE_OF[s];
  def(0xF0C0, 0xE000 | (s << 6), (c, op) => {
    const kind = (op >> 3) & 3, left = (op >> 8) & 1, r = op & 7;
    const cnt = (op >> 5) & 1 ? c.d[(op >> 9) & 7] & 63 : (((op >> 9) & 7) || 8);
    c.writeLoc(-1 - r, sz, shift(c, kind, left, c.d[r], cnt, sz));
    c.cycles += 2;
  });
}
defEA(0xF8C0, 0xE0C0, isMemAlt, (c, op) => {                                          // memory shifts, one bit
  const kind = (op >> 9) & 3, left = (op >> 8) & 1, a = c.addr((op >> 3) & 7, op & 7, 2);
  c.ww(a, shift(c, kind, left, c.rw(a), 1, 2));
});

for (let op = 0; op < 65536; op++) if (!OPS[op]) OPS[op] = illegal;
