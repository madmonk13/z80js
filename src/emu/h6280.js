// Hudson HuC6280: a 65C02 with an MMU and extra instructions (the PC Engine's
// CPU; Data East used it as a protection and sound processor). Logical
// addresses are 16 bits in eight 8K pages; eight mapping registers (MPR)
// give each page's physical 8K bank, making a 21-bit bus. The zero page
// lives at logical 2000-20FF and the stack at 2100-21FF.
//
// Beyond the 65C02: register swaps (SAX, SAY, SXY), clears (CLA, CLX, CLY),
// TAM/TMA for the mapping registers, block moves (TII, TDD, TIN, TIA, TAI),
// TST, BSR, the T flag (SET makes the next logic/arithmetic instruction work
// on the zero-page byte at X instead of A), ST0-ST2 (video chip writes) and
// the speed switches CSH/CSL. Interrupts: IRQ2/BRK (vector FFF6), IRQ1
// (FFF8), timer (FFFA), NMI (FFFC), reset (FFFE). The interrupt mask and
// timer acknowledge live at physical 1FF402/1FF403.
//
// The host's bus sees physical addresses: { read(pa), write(pa, v) }.
// Cycle counts follow the published per-instruction timings (approximately
// for block moves).

import { capture, apply } from './state.js';

const C = 0x01, Z = 0x02, I = 0x04, D = 0x08, B = 0x10, T = 0x20, V = 0x40, N = 0x80;
const STATE = ['a', 'x', 'y', 'sp', 'pc', 'p', 'mpr', 'irqMask', 'irqLines', 'nmiPending', 'cycles', 'fast'];

export class H6280 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor(bus) {
    this.bus = bus;
    this.mpr = new Uint8Array(8);
    this.cycles = 0;
    this.onIrqAck = null;
    this.reset();
  }

  reset() {
    this.a = this.x = this.y = 0;
    this.sp = 0xFF;
    this.p = I;
    this.mpr.fill(0); this.mpr[7] = 0;
    this.irqMask = 0;           // bit 0 IRQ2, bit 1 IRQ1, bit 2 timer: set = disabled
    this.irqLines = 0;          // the same bits: line asserted
    this.nmiPending = false;
    this.fast = 0;
    this.pc = this.rd(0xFFFE) | (this.rd(0xFFFF) << 8);
  }

  // IRQ1 is input 0, IRQ2 input 1, the timer input 2 (levels).
  setIrq(line, on) { const bit = [2, 1, 4][line]; this.irqLines = on ? this.irqLines | bit : this.irqLines & ~bit; }
  nmi() { this.nmiPending = true; }

  phys(a) { return (this.mpr[a >> 13] << 13) | (a & 0x1FFF); }
  rd(a) {
    const pa = this.phys(a & 0xFFFF);
    if (pa >= 0x1FF400 && pa < 0x1FF800) return (pa & 3) === 2 ? this.irqMask : (pa & 3) === 3 ? this.irqLines : 0;
    return this.bus.read(pa);
  }
  wr(a, v) {
    const pa = this.phys(a & 0xFFFF);
    if (pa >= 0x1FF400 && pa < 0x1FF800) {
      if ((pa & 3) === 2) this.irqMask = v & 7;
      else if ((pa & 3) === 3) this.irqLines &= ~4;      // acknowledge the timer
      return;
    }
    this.bus.write(pa, v & 0xFF);
  }
  zp(a) { return this.rd(0x2000 | (a & 0xFF)); }
  zpw(a, v) { this.wr(0x2000 | (a & 0xFF), v); }
  zp16(a) { return this.zp(a) | (this.zp(a + 1) << 8); }
  fetch() { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  push(v) { this.wr(0x2100 | this.sp, v); this.sp = (this.sp - 1) & 0xFF; }
  pull() { this.sp = (this.sp + 1) & 0xFF; return this.rd(0x2100 | this.sp); }
  nz(v) { this.p = (this.p & ~(N | Z)) | (v & N) | (v ? 0 : Z); return v; }

  interrupt(vector, brk = false) {
    this.push(this.pc >> 8); this.push(this.pc & 0xFF);
    this.push((this.p & ~(B | T)) | (brk ? B : 0));
    this.p = (this.p & ~(D | T)) | I;
    this.pc = this.rd(vector) | (this.rd(vector + 1) << 8);
    this.cycles += 7;
  }

  run(n) {
    const end = this.cycles + n;
    while (this.cycles < end) {
      if (this.nmiPending) { this.nmiPending = false; this.interrupt(0xFFFC); continue; }
      const pending = this.irqLines & ~this.irqMask;
      if (pending && !(this.p & I)) {
        const bit = pending & 4 ? 4 : pending & 2 ? 2 : 1;
        this.interrupt(bit === 4 ? 0xFFFA : bit === 2 ? 0xFFF8 : 0xFFF6);
        if (this.onIrqAck) this.onIrqAck(bit === 2 ? 0 : bit === 1 ? 1 : 2);   // for lines held until taken
        continue;
      }
      this.step();
    }
    return n + (this.cycles - end);
  }

  // ---------------------------------------------------------------- arithmetic

  // With T set, logic and arithmetic work on the zero-page byte at X.
  accGet() { return this.p & T ? this.zp(this.x) : this.a; }
  accSet(v) { if (this.p & T) this.zpw(this.x, v); else this.a = v; }
  adc(m) {
    const acc = this.accGet(), c = this.p & C;
    let r;
    if (this.p & D) {
      let lo = (acc & 15) + (m & 15) + c, hi = (acc >> 4) + (m >> 4);
      if (lo > 9) { lo -= 10; hi++; }
      this.p &= ~C; if (hi > 9) { hi -= 10; this.p |= C; }
      r = ((hi << 4) | (lo & 15)) & 0xFF;
      this.cycles++;
    } else {
      const sum = acc + m + c;
      r = sum & 0xFF;
      this.p = (this.p & ~(C | V)) | (sum > 0xFF ? C : 0) | ((~(acc ^ m) & (acc ^ r) & 0x80) ? V : 0);
    }
    this.nz(r); this.accSet(r);
  }
  sbc(m) {
    const acc = this.a, borrow = (this.p & C) ? 0 : 1;
    let r;
    if (this.p & D) {
      let lo = (acc & 15) - (m & 15) - borrow, hi = (acc >> 4) - (m >> 4);
      if (lo < 0) { lo += 10; hi--; }
      this.p &= ~C; if (hi >= 0) this.p |= C; else hi += 10;
      r = ((hi << 4) | (lo & 15)) & 0xFF;
      this.cycles++;
    } else {
      const diff = acc - m - borrow;
      r = diff & 0xFF;
      this.p = (this.p & ~(C | V)) | (diff >= 0 ? C : 0) | (((acc ^ m) & (acc ^ r) & 0x80) ? V : 0);
    }
    this.a = this.nz(r);
  }
  cmp(reg, m) { const d = reg - m; this.p = (this.p & ~C) | (d >= 0 ? C : 0); this.nz(d & 0xFF); }
  bit(m) { this.p = (this.p & ~(N | V | Z)) | (m & (N | V)) | ((m & this.a) ? 0 : Z); }
  asl(v) { this.p = (this.p & ~C) | (v >> 7); return this.nz((v << 1) & 0xFF); }
  lsr(v) { this.p = (this.p & ~C) | (v & 1); return this.nz(v >> 1); }
  rol(v) { const c = this.p & C; this.p = (this.p & ~C) | (v >> 7); return this.nz(((v << 1) | c) & 0xFF); }
  ror(v) { const c = this.p & C; this.p = (this.p & ~C) | (v & 1); return this.nz((v >> 1) | (c << 7)); }
  branch(cond) {
    const off = this.fetch();
    if (cond) { this.pc = (this.pc + ((off << 24) >> 24)) & 0xFFFF; this.cycles += 2; }
  }

  // ---------------------------------------------------------------- addressing (return logical addresses)

  aZpx() { return 0x2000 | ((this.fetch() + this.x) & 0xFF); }
  aZpy() { return 0x2000 | ((this.fetch() + this.y) & 0xFF); }
  aZpg() { return 0x2000 | this.fetch(); }
  aAbs() { return this.fetch16(); }
  aAbx() { return (this.fetch16() + this.x) & 0xFFFF; }
  aAby() { return (this.fetch16() + this.y) & 0xFFFF; }
  aIdx() { return this.zp16(this.fetch() + this.x); }
  aIdy() { return (this.zp16(this.fetch()) + this.y) & 0xFFFF; }
  aZpi() { return this.zp16(this.fetch()); }

  // Block moves: source, destination, length (0 = 64K); `sm`/`dm` step each
  // (0 fixed, 1 up, -1 down, 2 alternate).
  block(sm, dm) {
    let s = this.fetch16(), d = this.fetch16(), len = this.fetch16() || 0x10000;
    this.push(this.y); this.push(this.a); this.push(this.x);
    for (let i = 0; i < len; i++) {
      this.wr(d, this.rd(s));
      s = (s + (sm === 2 ? (i & 1 ? -1 : 1) : sm)) & 0xFFFF;
      d = (d + (dm === 2 ? (i & 1 ? -1 : 1) : dm)) & 0xFFFF;
    }
    this.x = this.pull(); this.a = this.pull(); this.y = this.pull();
    this.cycles += 17 + 6 * len;
  }

  // ---------------------------------------------------------------- instructions

  step() {
    const op = this.fetch();
    const tWas = this.p & T;
    this.exec(op);
    if (tWas && op !== 0xF4) this.p &= ~T;   // T lasts one instruction
  }

  exec(op) {
    let a, m;
    const low = op & 0x1F, grp = op >> 5;
    // The regular ALU column (x1, x5, x9, xD, plus (zp) at x2): ORA AND EOR ADC STA LDA CMP SBC.
    const aluAddr = () => {
      switch (low) {
        case 0x01: this.cycles += 7; return this.aIdx();
        case 0x05: this.cycles += 4; return this.aZpg();
        case 0x09: this.cycles += 2; return -1;            // immediate
        case 0x0D: this.cycles += 5; return this.aAbs();
        case 0x11: this.cycles += 7; return this.aIdy();
        case 0x12: this.cycles += 7; return this.aZpi();
        case 0x15: this.cycles += 4; return this.aZpx();
        case 0x19: this.cycles += 5; return this.aAby();
        case 0x1D: this.cycles += 5; return this.aAbx();
      }
      return null;
    };
    if ([0x01, 0x05, 0x09, 0x0D, 0x11, 0x12, 0x15, 0x19, 0x1D].includes(low) && !(op === 0x89)) {
      a = aluAddr();
      if (grp === 4) { if (a !== -1) this.wr(a, this.a); return; }   // STA (89 is BIT #)
      m = a === -1 ? this.fetch() : this.rd(a);
      switch (grp) {
        case 0: this.accSet(this.nz(this.accGet() | m)); this.cycles += this.p & T ? 3 : 0; break;
        case 1: this.accSet(this.nz(this.accGet() & m)); break;
        case 2: this.accSet(this.nz(this.accGet() ^ m)); break;
        case 3: this.adc(m); break;
        case 5: this.a = this.nz(m); break;
        case 6: this.cmp(this.a, m); break;
        case 7: this.sbc(m); break;
      }
      return;
    }
    // Read-modify-write: ASL ROL LSR ROR / DEC INC on zp, zp+x, abs, abs+x.
    const rmw = (fn) => {
      const mode = op & 0x1C;
      a = mode === 0x04 ? this.aZpg() : mode === 0x14 ? this.aZpx() : mode === 0x0C ? this.aAbs() : this.aAbx();
      this.cycles += mode === 0x04 || mode === 0x14 ? 6 : 7;
      this.wr(a, fn(this.rd(a)));
    };
    switch (op) {
      // ---- shifts and inc/dec
      case 0x06: case 0x16: case 0x0E: case 0x1E: rmw((v) => this.asl(v)); return;
      case 0x26: case 0x36: case 0x2E: case 0x3E: rmw((v) => this.rol(v)); return;
      case 0x46: case 0x56: case 0x4E: case 0x5E: rmw((v) => this.lsr(v)); return;
      case 0x66: case 0x76: case 0x6E: case 0x7E: rmw((v) => this.ror(v)); return;
      case 0xC6: case 0xD6: case 0xCE: case 0xDE: rmw((v) => this.nz((v - 1) & 0xFF)); return;
      case 0xE6: case 0xF6: case 0xEE: case 0xFE: rmw((v) => this.nz((v + 1) & 0xFF)); return;
      case 0x0A: this.a = this.asl(this.a); this.cycles += 2; return;
      case 0x2A: this.a = this.rol(this.a); this.cycles += 2; return;
      case 0x4A: this.a = this.lsr(this.a); this.cycles += 2; return;
      case 0x6A: this.a = this.ror(this.a); this.cycles += 2; return;
      case 0x1A: this.a = this.nz((this.a + 1) & 0xFF); this.cycles += 2; return;
      case 0x3A: this.a = this.nz((this.a - 1) & 0xFF); this.cycles += 2; return;
      case 0xE8: this.x = this.nz((this.x + 1) & 0xFF); this.cycles += 2; return;
      case 0xCA: this.x = this.nz((this.x - 1) & 0xFF); this.cycles += 2; return;
      case 0xC8: this.y = this.nz((this.y + 1) & 0xFF); this.cycles += 2; return;
      case 0x88: this.y = this.nz((this.y - 1) & 0xFF); this.cycles += 2; return;
      // ---- loads / stores of X, Y, zero
      case 0xA2: this.x = this.nz(this.fetch()); this.cycles += 2; return;
      case 0xA6: this.x = this.nz(this.rd(this.aZpg())); this.cycles += 4; return;
      case 0xB6: this.x = this.nz(this.rd(this.aZpy())); this.cycles += 4; return;
      case 0xAE: this.x = this.nz(this.rd(this.aAbs())); this.cycles += 5; return;
      case 0xBE: this.x = this.nz(this.rd(this.aAby())); this.cycles += 5; return;
      case 0xA0: this.y = this.nz(this.fetch()); this.cycles += 2; return;
      case 0xA4: this.y = this.nz(this.rd(this.aZpg())); this.cycles += 4; return;
      case 0xB4: this.y = this.nz(this.rd(this.aZpx())); this.cycles += 4; return;
      case 0xAC: this.y = this.nz(this.rd(this.aAbs())); this.cycles += 5; return;
      case 0xBC: this.y = this.nz(this.rd(this.aAbx())); this.cycles += 5; return;
      case 0x86: this.wr(this.aZpg(), this.x); this.cycles += 4; return;
      case 0x96: this.wr(this.aZpy(), this.x); this.cycles += 4; return;
      case 0x8E: this.wr(this.aAbs(), this.x); this.cycles += 5; return;
      case 0x84: this.wr(this.aZpg(), this.y); this.cycles += 4; return;
      case 0x94: this.wr(this.aZpx(), this.y); this.cycles += 4; return;
      case 0x8C: this.wr(this.aAbs(), this.y); this.cycles += 5; return;
      case 0x64: this.wr(this.aZpg(), 0); this.cycles += 4; return;
      case 0x74: this.wr(this.aZpx(), 0); this.cycles += 4; return;
      case 0x9C: this.wr(this.aAbs(), 0); this.cycles += 5; return;
      case 0x9E: this.wr(this.aAbx(), 0); this.cycles += 5; return;
      // ---- compares and bit tests
      case 0xE0: this.cmp(this.x, this.fetch()); this.cycles += 2; return;
      case 0xE4: this.cmp(this.x, this.rd(this.aZpg())); this.cycles += 4; return;
      case 0xEC: this.cmp(this.x, this.rd(this.aAbs())); this.cycles += 5; return;
      case 0xC0: this.cmp(this.y, this.fetch()); this.cycles += 2; return;
      case 0xC4: this.cmp(this.y, this.rd(this.aZpg())); this.cycles += 4; return;
      case 0xCC: this.cmp(this.y, this.rd(this.aAbs())); this.cycles += 5; return;
      case 0x89: this.bit(this.fetch()); this.cycles += 2; return;
      case 0x24: this.bit(this.rd(this.aZpg())); this.cycles += 4; return;
      case 0x34: this.bit(this.rd(this.aZpx())); this.cycles += 4; return;
      case 0x2C: this.bit(this.rd(this.aAbs())); this.cycles += 5; return;
      case 0x3C: this.bit(this.rd(this.aAbx())); this.cycles += 5; return;
      case 0x04: case 0x0C: case 0x14: case 0x1C: {        // TSB / TRB
        a = op & 8 ? this.aAbs() : this.aZpg(); m = this.rd(a);
        const r = op & 0x10 ? m & ~this.a : m | this.a;
        this.p = (this.p & ~(N | V | Z)) | (r & (N | V)) | ((m & this.a) ? 0 : Z);
        this.wr(a, r & 0xFF); this.cycles += op & 8 ? 7 : 6; return;
      }
      case 0x83: case 0xA3: case 0x93: case 0xB3: {        // TST #imm, memory
        const imm = this.fetch();
        a = op === 0x83 ? this.aZpg() : op === 0xA3 ? this.aZpx() : op === 0x93 ? this.aAbs() : this.aAbx();
        m = this.rd(a);
        this.p = (this.p & ~(N | V | Z)) | (m & (N | V)) | ((m & imm) ? 0 : Z);
        this.cycles += op & 0x10 ? 8 : 7; return;
      }
      // ---- transfers, swaps, clears
      case 0xAA: this.x = this.nz(this.a); this.cycles += 2; return;
      case 0x8A: this.a = this.nz(this.x); this.cycles += 2; return;
      case 0xA8: this.y = this.nz(this.a); this.cycles += 2; return;
      case 0x98: this.a = this.nz(this.y); this.cycles += 2; return;
      case 0xBA: this.x = this.nz(this.sp); this.cycles += 2; return;
      case 0x9A: this.sp = this.x; this.cycles += 2; return;
      case 0x02: [this.x, this.y] = [this.y, this.x]; this.cycles += 3; return;
      case 0x22: [this.a, this.x] = [this.x, this.a]; this.cycles += 3; return;
      case 0x42: [this.a, this.y] = [this.y, this.a]; this.cycles += 3; return;
      case 0x62: this.a = 0; this.cycles += 2; return;
      case 0x82: this.x = 0; this.cycles += 2; return;
      case 0xC2: this.y = 0; this.cycles += 2; return;
      // ---- stack
      case 0x48: this.push(this.a); this.cycles += 3; return;
      case 0x68: this.a = this.nz(this.pull()); this.cycles += 4; return;
      case 0xDA: this.push(this.x); this.cycles += 3; return;
      case 0xFA: this.x = this.nz(this.pull()); this.cycles += 4; return;
      case 0x5A: this.push(this.y); this.cycles += 3; return;
      case 0x7A: this.y = this.nz(this.pull()); this.cycles += 4; return;
      case 0x08: this.push(this.p | B); this.cycles += 3; return;
      case 0x28: this.p = this.pull() & ~B; this.cycles += 4; return;
      // ---- flags
      case 0x18: this.p &= ~C; this.cycles += 2; return;
      case 0x38: this.p |= C; this.cycles += 2; return;
      case 0x58: this.p &= ~I; this.cycles += 2; return;
      case 0x78: this.p |= I; this.cycles += 2; return;
      case 0xB8: this.p &= ~V; this.cycles += 2; return;
      case 0xD8: this.p &= ~D; this.cycles += 2; return;
      case 0xF8: this.p |= D; this.cycles += 2; return;
      case 0xF4: this.p |= T; this.cycles += 2; return;
      case 0x54: this.fast = 0; this.cycles += 3; return;   // CSL
      case 0xD4: this.fast = 1; this.cycles += 3; return;   // CSH
      // ---- jumps, calls, branches
      case 0x4C: this.pc = this.fetch16(); this.cycles += 4; return;
      case 0x6C: { const p = this.fetch16(); this.pc = this.rd(p) | (this.rd((p + 1) & 0xFFFF) << 8); this.cycles += 7; return; }
      case 0x7C: { const p = (this.fetch16() + this.x) & 0xFFFF; this.pc = this.rd(p) | (this.rd((p + 1) & 0xFFFF) << 8); this.cycles += 7; return; }
      case 0x20: { const t = this.fetch16(); const r = (this.pc - 1) & 0xFFFF; this.push(r >> 8); this.push(r & 0xFF); this.pc = t; this.cycles += 7; return; }
      case 0x44: { const off = this.fetch(); const r = (this.pc - 1) & 0xFFFF; this.push(r >> 8); this.push(r & 0xFF);
        this.pc = (this.pc + ((off << 24) >> 24)) & 0xFFFF; this.cycles += 8; return; }
      case 0x60: { const lo = this.pull(); this.pc = ((lo | (this.pull() << 8)) + 1) & 0xFFFF; this.cycles += 7; return; }
      case 0x40: { this.p = this.pull() & ~B; const lo = this.pull(); this.pc = lo | (this.pull() << 8); this.cycles += 7; return; }
      case 0x00: this.pc = (this.pc + 1) & 0xFFFF; this.interrupt(0xFFF6, true); this.cycles += 1; return;
      case 0x80: this.branch(true); this.cycles += 2; return;
      case 0x10: this.branch(!(this.p & N)); this.cycles += 2; return;
      case 0x30: this.branch(this.p & N); this.cycles += 2; return;
      case 0x50: this.branch(!(this.p & V)); this.cycles += 2; return;
      case 0x70: this.branch(this.p & V); this.cycles += 2; return;
      case 0x90: this.branch(!(this.p & C)); this.cycles += 2; return;
      case 0xB0: this.branch(this.p & C); this.cycles += 2; return;
      case 0xD0: this.branch(!(this.p & Z)); this.cycles += 2; return;
      case 0xF0: this.branch(this.p & Z); this.cycles += 2; return;
      // ---- the mapping registers
      case 0x53: { const imm = this.fetch(); for (let i = 0; i < 8; i++) if (imm & (1 << i)) this.mpr[i] = this.a; this.cycles += 5; return; }
      case 0x43: { const imm = this.fetch(); for (let i = 0; i < 8; i++) if (imm & (1 << i)) { this.a = this.mpr[i]; break; } this.cycles += 4; return; }
      // ---- block moves
      case 0x73: this.block(1, 1); return;     // TII
      case 0xC3: this.block(-1, -1); return;   // TDD
      case 0xD3: this.block(1, 0); return;     // TIN
      case 0xE3: this.block(1, 2); return;     // TIA
      case 0xF3: this.block(2, 1); return;     // TAI
      // ---- video chip writes (no video chip on these boards)
      case 0x03: case 0x13: case 0x23: this.fetch(); this.cycles += 5; return;
    }
    // ---- bit instructions on zero page
    if ((op & 0x0F) === 0x07) {
      a = this.aZpg(); m = this.rd(a); const bit = 1 << ((op >> 4) & 7);
      this.wr(a, op & 0x80 ? m | bit : m & ~bit); this.cycles += 7; return;
    }
    if ((op & 0x0F) === 0x0F) {
      m = this.rd(this.aZpg()); const bit = 1 << ((op >> 4) & 7);
      this.cycles += 6;
      this.branch(op & 0x80 ? m & bit : !(m & bit)); return;
    }
    this.cycles += 2;                          // everything else is a NOP
  }
}
