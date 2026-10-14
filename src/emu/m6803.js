// Motorola 6803: the 6800 instruction set plus the 6801's additions (the
// 16-bit D register, MUL, ABX, PSHX/PULX, LSRD/ASLD, BRN, JSR direct), with
// the chip's internal parts that sound boards use: 128 bytes of RAM at
// $80-$FF, I/O ports 1 and 2 (registers $02/$03), and the 16-bit timer with
// output compare and overflow interrupts (registers $08-$0C).
//
// Counts E-clock cycles. The host supplies read(a) / write(a, v) for the
// external bus and portIn(n) / portOut(n, v) for ports 1 and 2; it raises
// the IRQ line by setting `irq` (see holdIrq below) and pulses NMI
// with nmi().
//
// hd63701: true adds the Hitachi HD63701's extra instructions (XGDX, SLP,
// and AIM/OIM/EIM/TIM, which work on memory with an immediate mask).

import { capture, apply } from './state.js';

const C = 1, V = 2, Z = 4, N = 8, I = 16, H = 32;
const STATE = ['a', 'b', 'x', 'sp', 'pc', 'cc', 'cycles', 'irq', 'nmiPending', 'waiting', 'sleeping', 'irqDelay', 'ram',
  'ddr1', 'ddr2', 'port1', 'port2', 'tcsr', 'counter', 'ocr', 'timerCarry', 'ramcr'];

// Base cycle counts (6801 timings) for each opcode; 0 marks an illegal one.
const CYCLES = new Uint8Array([
  0, 2, 0, 0, 3, 3, 2, 2, 3, 3, 2, 2, 2, 2, 2, 2,
  2, 2, 0, 0, 0, 0, 2, 2, 0, 2, 0, 2, 0, 0, 0, 0,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  3, 3, 4, 4, 3, 3, 3, 3, 5, 5, 3, 10, 4, 10, 9, 12,
  2, 0, 0, 2, 2, 0, 2, 2, 2, 2, 2, 0, 2, 2, 0, 2,
  2, 0, 0, 2, 2, 0, 2, 2, 2, 2, 2, 0, 2, 2, 0, 2,
  6, 0, 0, 6, 6, 0, 6, 6, 6, 6, 6, 0, 6, 6, 3, 6,
  6, 0, 0, 6, 6, 0, 6, 6, 6, 6, 6, 0, 6, 6, 3, 6,
  2, 2, 2, 4, 2, 2, 2, 0, 2, 2, 2, 2, 4, 6, 3, 0,
  3, 3, 3, 5, 3, 3, 3, 3, 3, 3, 3, 3, 5, 5, 4, 4,
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 6, 6, 5, 5,
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 6, 6, 5, 5,
  2, 2, 2, 4, 2, 2, 2, 0, 2, 2, 2, 2, 3, 0, 3, 0,
  3, 3, 3, 5, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4,
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
  4, 4, 4, 6, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
]);

// The HD63701 runs most instructions in fewer cycles (Hitachi's timings).
const CYCLES_63701 = new Uint8Array([
  0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 0, 0, 0, 0, 1, 1, 2, 2, 4, 1, 0, 0, 0, 0,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  1, 1, 3, 3, 1, 1, 4, 4, 4, 5, 1, 10, 5, 7, 9, 12,
  1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1,
  1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1,
  6, 7, 7, 6, 6, 7, 6, 6, 6, 6, 6, 5, 6, 4, 3, 5,
  6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 4, 6, 4, 3, 5,
  2, 2, 2, 3, 2, 2, 2, 0, 2, 2, 2, 2, 3, 5, 3, 0,
  3, 3, 3, 4, 3, 3, 3, 3, 3, 3, 3, 3, 4, 5, 4, 4,
  4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
  4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4, 4, 5, 6, 5, 5,
  2, 2, 2, 3, 2, 2, 2, 0, 2, 2, 2, 2, 3, 0, 3, 0,
  3, 3, 3, 4, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4,
  4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
  4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5,
]);

export class M6803 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // internal: false makes it a plain 6800/6808 (no on-chip RAM, ports or
  // timer). holdIrq: true clears `irq` when the CPU takes it (a held line);
  // false leaves it to the host (a level, e.g. from a PIA).
  constructor({ read, write, portIn = () => 0xFF, portOut = () => {}, internal = true, holdIrq = true, hd63701 = false }) {
    this.internal = internal;
    this.holdIrq = holdIrq;
    this.hd63701 = hd63701;
    this.timing = hd63701 ? CYCLES_63701 : CYCLES;
    this.readBus = read;
    this.writeBus = write;
    this.portIn = portIn;
    this.portOut = portOut;
    this.ram = new Uint8Array(128);
    this.reset();
  }

  reset() {
    this.a = 0; this.b = 0; this.x = 0; this.sp = 0;
    this.cc = I | 0xC0;
    this.cycles = 0;
    this.irq = false; this.nmiPending = false; this.waiting = false; this.sleeping = false; this.irqDelay = false;
    this.ddr1 = 0; this.ddr2 = 0; this.port1 = 0xFF; this.port2 = 0xFF;
    this.tcsr = 0; this.counter = 0; this.ocr = 0xFFFF; this.timerCarry = 0;
    this.ramcr = 0x40;                       // RAM control (register $14): bit 6 RAM enable, bit 7 standby flag
    this.pc = this.read16(0xFFFE);
  }

  nmi() { this.nmiPending = true; }

  // ---------------------------------------------------------------- bus

  read(a) {
    a &= 0xFFFF;
    if (this.internal) {
      if (a < 0x20) return this.readReg(a);
      if (a >= 0x80 && a < 0x100) return this.ram[a - 0x80];
    }
    return this.readBus(a);
  }
  write(a, v) {
    a &= 0xFFFF; v &= 0xFF;
    if (this.internal) {
      if (a < 0x20) { this.writeReg(a, v); return; }
      if (a >= 0x80 && a < 0x100) { this.ram[a - 0x80] = v; return; }
    }
    this.writeBus(a, v);
  }
  read16(a) { return (this.read(a) << 8) | this.read((a + 1) & 0xFFFF); }
  write16(a, v) { this.write(a, v >> 8); this.write((a + 1) & 0xFFFF, v & 0xFF); }

  // Internal registers.
  readReg(r) {
    switch (r) {
      case 0x00: return this.ddr1;
      case 0x01: return this.ddr2;
      // Port pins set as outputs read back the output latch.
      case 0x02: return (this.portIn(1) & ~this.ddr1) | (this.port1 & this.ddr1);
      case 0x03: return (this.portIn(2) & ~this.ddr2) | (this.port2 & this.ddr2);
      case 0x08: return this.tcsr;
      case 0x09: this.tcsr &= ~0x20; return this.counter >> 8;    // reading the counter clears overflow
      case 0x0A: return this.counter & 0xFF;
      case 0x0B: return this.ocr >> 8;
      case 0x0C: return this.ocr & 0xFF;
      case 0x14: return this.ramcr;
    }
    return 0;
  }
  writeReg(r, v) {
    switch (r) {
      case 0x00: this.ddr1 = v; break;
      case 0x01: this.ddr2 = v; break;
      case 0x02: this.port1 = v; this.portOut(1, (v & this.ddr1) | (~this.ddr1 & 0xFF)); break;
      case 0x03: this.port2 = v; this.portOut(2, (v & this.ddr2) | (~this.ddr2 & 0xFF)); break;
      case 0x08: this.tcsr = (this.tcsr & 0xE0) | (v & 0x1F); break;
      case 0x09: this.counter = 0xFFF8; break;                 // a write presets the counter
      case 0x0B: this.ocr = (v << 8) | (this.ocr & 0xFF); this.tcsr &= ~0x40; break;
      case 0x0C: this.ocr = (this.ocr & 0xFF00) | v; this.tcsr &= ~0x40; break;
      case 0x14: this.ramcr = v; break;    // (programs set the standby bit to tell a warm restart from power-on)
    }
  }

  // ---------------------------------------------------------------- helpers

  get d() { return (this.a << 8) | this.b; }
  set d(v) { this.a = (v >> 8) & 0xFF; this.b = v & 0xFF; }

  fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  fetch16() { const v = this.read16(this.pc); this.pc = (this.pc + 2) & 0xFFFF; return v; }
  push(v) { this.write(this.sp, v); this.sp = (this.sp - 1) & 0xFFFF; }
  pull() { this.sp = (this.sp + 1) & 0xFFFF; return this.read(this.sp); }
  push16(v) { this.push(v & 0xFF); this.push(v >> 8); }
  pull16() { const hi = this.pull(); return (hi << 8) | this.pull(); }

  setNZ8(v) { this.cc = (this.cc & ~(N | Z)) | (v & 0x80 ? N : 0) | (v & 0xFF ? 0 : Z); }
  setNZ16(v) { this.cc = (this.cc & ~(N | Z)) | (v & 0x8000 ? N : 0) | (v & 0xFFFF ? 0 : Z); }
  flag(f, on) { this.cc = on ? this.cc | f : this.cc & ~f; }

  add8(a, b, carry) {
    const r = a + b + carry;
    this.cc &= ~(H | N | Z | V | C);
    if (((a & 15) + (b & 15) + carry) & 0x10) this.cc |= H;
    if (r & 0x100) this.cc |= C;
    if (~(a ^ b) & (a ^ r) & 0x80) this.cc |= V;
    this.setNZ8(r);
    return r & 0xFF;
  }
  sub8(a, b, borrow) {
    const r = a - b - borrow;
    this.cc &= ~(N | Z | V | C);
    if (r & 0x100) this.cc |= C;
    if ((a ^ b) & (a ^ r) & 0x80) this.cc |= V;
    this.setNZ8(r);
    return r & 0xFF;
  }
  sub16(a, b) {
    const r = a - b;
    this.cc &= ~(N | Z | V | C);
    if (r & 0x10000) this.cc |= C;
    if ((a ^ b) & (a ^ r) & 0x8000) this.cc |= V;
    this.setNZ16(r);
    return r & 0xFFFF;
  }
  add16(a, b) {
    const r = a + b;
    this.cc &= ~(N | Z | V | C);
    if (r & 0x10000) this.cc |= C;
    if (~(a ^ b) & (a ^ r) & 0x8000) this.cc |= V;
    this.setNZ16(r);
    return r & 0xFFFF;
  }
  logic(v) { this.cc &= ~V; this.setNZ8(v); return v & 0xFF; }

  // Read-modify-write operations shared by A, B and memory (opcode low nibble).
  rmw(op, v) {
    switch (op) {
      case 0x0: { const r = (-v) & 0xFF; this.cc &= ~(N | Z | V | C); if (r) this.cc |= C; if (r === 0x80) this.cc |= V; this.setNZ8(r); return r; }   // NEG
      case 0x3: { const r = ~v & 0xFF; this.cc = (this.cc & ~V) | C; this.setNZ8(r); return r; }                                                  // COM
      case 0x4: { const r = v >> 1; this.flag(C, v & 1); this.setNZ8(r); this.flag(V, ((this.cc & N) ? 1 : 0) ^ (this.cc & C)); return r; }      // LSR
      case 0x6: { const r = (v >> 1) | ((this.cc & C) << 7); this.flag(C, v & 1); this.setNZ8(r); this.flag(V, ((this.cc & N) ? 1 : 0) ^ (this.cc & C)); return r; }  // ROR
      case 0x7: { const r = (v >> 1) | (v & 0x80); this.flag(C, v & 1); this.setNZ8(r); this.flag(V, ((this.cc & N) ? 1 : 0) ^ (this.cc & C)); return r; }  // ASR
      case 0x8: { const r = (v << 1) & 0xFF; this.flag(C, v & 0x80); this.setNZ8(r); this.flag(V, ((this.cc & N) ? 1 : 0) ^ (this.cc & C)); return r; }  // ASL
      case 0x9: { const r = ((v << 1) | (this.cc & C)) & 0xFF; this.flag(C, v & 0x80); this.setNZ8(r); this.flag(V, ((this.cc & N) ? 1 : 0) ^ (this.cc & C)); return r; }  // ROL
      case 0xA: { const r = (v - 1) & 0xFF; this.flag(V, v === 0x80); this.setNZ8(r); return r; }   // DEC
      case 0xC: { const r = (v + 1) & 0xFF; this.flag(V, v === 0x7F); this.setNZ8(r); return r; }   // INC
      case 0xD: this.cc &= ~(V | C); this.setNZ8(v); return v;                                        // TST
      case 0xF: this.cc = (this.cc & ~(N | V | C)) | Z; return 0;                                      // CLR
    }
    return v;
  }

  branch(take) {
    const off = this.fetch();
    if (take) this.pc = (this.pc + ((off << 24) >> 24)) & 0xFFFF;
  }

  // WAI has already stacked everything, so an interrupt that wakes it doesn't again.
  interrupt(vector) {
    if (!this.waiting) { this.push16(this.pc); this.push16(this.x); this.push(this.a); this.push(this.b); this.push(this.cc); }
    this.cc |= I;
    this.pc = this.read16(vector);
    this.waiting = false; this.sleeping = false;
  }

  // ---------------------------------------------------------------- run

  run(n) {
    const end = this.cycles + n;
    while (this.cycles < end) {
      const before = this.cycles;
      this.step();
      if (this.internal) this.clockTimer(this.cycles - before);
    }
  }

  // The free-running counter: output compare and overflow raise IRQ2 when enabled.
  clockTimer(n) {
    const prev = this.counter;
    const next = prev + n;
    if (prev < this.ocr && next >= this.ocr) this.tcsr |= 0x40;
    else if (next > 0xFFFF && (next & 0xFFFF) >= this.ocr) this.tcsr |= 0x40;
    if (next > 0xFFFF) this.tcsr |= 0x20;
    this.counter = next & 0xFFFF;
  }

  step() {
    if (this.nmiPending) {
      this.nmiPending = false;
      this.interrupt(0xFFFC);
      this.cycles += 12;
      return;
    }
    // After CLI (or TAP clearing I) one more instruction runs before a pending IRQ is taken.
    if (this.irqDelay) this.irqDelay = false;
    else if (!(this.cc & I)) {
      if (this.irq) { if (this.holdIrq) this.irq = false; this.interrupt(0xFFF8); this.cycles += 12; return; }
      if ((this.tcsr & 0x48) === 0x48) { this.interrupt(0xFFF4); this.cycles += 12; return; }   // output compare
      if ((this.tcsr & 0x24) === 0x24) { this.interrupt(0xFFF2); this.cycles += 12; return; }   // overflow
    }
    if (this.waiting || this.sleeping) { this.cycles += 4; return; }

    const op = this.fetch();
    this.cycles += this.timing[op] || 2;
    const hi = op >> 4, lo = op & 15;

    if (hi === 0x2) {                       // branches
      const c = this.cc;
      const n = !!(c & N), v = !!(c & V), z = !!(c & Z), cy = !!(c & C);
      const cond = [true, false, !(cy || z), cy || z, !cy, cy, !z, z, !v, v, !n, n, n === v, n !== v, !z && n === v, z || n !== v][lo];
      this.branch(cond);
      return;
    }
    if (hi === 0x4 || hi === 0x5) {         // accumulator RMW
      if (hi === 0x4) this.a = this.rmw(lo, this.a); else this.b = this.rmw(lo, this.b);
      return;
    }
    if (hi === 0x6 || hi === 0x7) {         // memory RMW, JMP
      if (this.hd63701 && (lo === 0x1 || lo === 0x2 || lo === 0x5 || lo === 0xB)) {   // AIM / OIM / EIM / TIM
        const m = this.fetch();
        const ea = hi === 0x6 ? (this.x + this.fetch()) & 0xFFFF : this.fetch();
        const v = this.read(ea), r = lo === 0x1 ? v & m : lo === 0x2 ? v | m : lo === 0x5 ? v ^ m : v & m;
        this.cc &= ~V; this.setNZ8(r);
        if (lo !== 0xB) this.write(ea, r);
        return;
      }
      const ea = hi === 0x6 ? (this.x + this.fetch()) & 0xFFFF : this.fetch16();
      if (lo === 0xE) { this.pc = ea; return; }
      if (lo === 0xD) { this.rmw(lo, this.read(ea)); return; }
      this.write(ea, this.rmw(lo, lo === 0xF ? 0 : this.read(ea)));
      return;
    }
    if (hi >= 0x8) {                        // the two accumulator groups
      const mode = hi & 3;                  // 0 immediate, 1 direct, 2 indexed, 3 extended
      const isB = hi >= 0xC;
      const wide = lo === 0x3 || lo === 0xC || lo === 0xE || (isB && lo === 0xD && mode !== 0);
      let ea;
      if (mode === 0) { ea = this.pc; this.pc = (this.pc + (wide ? 2 : 1)) & 0xFFFF; }
      else if (mode === 1) ea = this.fetch();
      else if (mode === 2) ea = (this.x + this.fetch()) & 0xFFFF;
      else ea = this.fetch16();
      this.alu(isB, lo, mode, ea);
      return;
    }
    this.misc(op);
  }

  alu(isB, lo, mode, ea) {
    const acc = isB ? this.b : this.a;
    const setAcc = (v) => { if (isB) this.b = v; else this.a = v; };
    switch (lo) {
      case 0x0: setAcc(this.sub8(acc, this.read(ea), 0)); return;                       // SUB
      case 0x1: this.sub8(acc, this.read(ea), 0); return;                               // CMP
      case 0x2: setAcc(this.sub8(acc, this.read(ea), this.cc & C)); return;             // SBC
      case 0x3: if (isB) this.d = this.add16(this.d, this.read16(ea)); else this.d = this.sub16(this.d, this.read16(ea)); return;   // ADDD / SUBD
      case 0x4: setAcc(this.logic(acc & this.read(ea))); return;                        // AND
      case 0x5: this.logic(acc & this.read(ea)); return;                                // BIT
      case 0x6: setAcc(this.logic(this.read(ea))); return;                              // LDA
      case 0x7: if (mode) { this.write(ea, acc); this.logic(acc); } return;             // STA
      case 0x8: setAcc(this.logic(acc ^ this.read(ea))); return;                        // EOR
      case 0x9: setAcc(this.add8(acc, this.read(ea), this.cc & C)); return;             // ADC
      case 0xA: setAcc(this.logic(acc | this.read(ea))); return;                        // ORA
      case 0xB: setAcc(this.add8(acc, this.read(ea), 0)); return;                       // ADD
      case 0xC:
        if (isB) { const d = this.read16(ea); this.d = d; this.cc &= ~V; this.setNZ16(d); }   // LDD
        else this.sub16(this.x, this.read16(ea));                                           // CPX
        return;
      case 0xD:
        if (isB) { if (mode) { this.write16(ea, this.d); this.cc &= ~V; this.setNZ16(this.d); } }   // STD
        else if (mode === 0) { const off = this.read(ea); this.push16(this.pc); this.pc = (this.pc + ((off << 24) >> 24)) & 0xFFFF; }   // BSR
        else { this.push16(this.pc); this.pc = ea; }                                       // JSR
        return;
      case 0xE: {                                                                          // LDS / LDX
        const v = this.read16(ea);
        if (isB) this.x = v; else this.sp = v;
        this.cc &= ~V; this.setNZ16(v);
        return;
      }
      case 0xF:                                                                            // STS / STX
        if (mode) { const v = isB ? this.x : this.sp; this.write16(ea, v); this.cc &= ~V; this.setNZ16(v); }
        return;
    }
  }

  misc(op) {
    switch (op) {
      case 0x01: return;                                                         // NOP
      case 0x04: { const d = this.d; this.flag(C, d & 1); this.d = d >> 1; this.setNZ16(d >> 1); this.flag(V, (this.cc & C) ? 1 : 0); return; }   // LSRD
      case 0x05: { const d = this.d; const r = (d << 1) & 0xFFFF; this.flag(C, d & 0x8000); this.d = r; this.setNZ16(r); this.flag(V, ((r >> 15) ^ (d >> 15)) & 1); return; }   // ASLD
      case 0x06: if (this.cc & I && !(this.a & I)) this.irqDelay = true; this.cc = this.a | 0xC0; return;   // TAP
      case 0x07: this.a = this.cc | 0xC0; return;                                // TPA
      case 0x08: this.x = (this.x + 1) & 0xFFFF; this.flag(Z, !this.x); return;  // INX
      case 0x09: this.x = (this.x - 1) & 0xFFFF; this.flag(Z, !this.x); return;  // DEX
      case 0x0A: this.cc &= ~V; return;
      case 0x0B: this.cc |= V; return;
      case 0x0C: this.cc &= ~C; return;
      case 0x0D: this.cc |= C; return;
      case 0x0E: if (this.cc & I) this.irqDelay = true; this.cc &= ~I; return;                     // CLI
      case 0x0F: this.cc |= I; return;
      case 0x10: this.a = this.sub8(this.a, this.b, 0); return;                  // SBA
      case 0x11: this.sub8(this.a, this.b, 0); return;                           // CBA
      case 0x16: this.b = this.logic(this.a); return;                            // TAB
      case 0x17: this.a = this.logic(this.b); return;                            // TBA
      case 0x19: {                                                               // DAA
        let a = this.a, adj = 0, carry = this.cc & C;
        if ((this.cc & H) || (a & 15) > 9) adj |= 0x06;
        if (carry || a > 0x99 || (a > 0x8F && (a & 15) > 9)) { adj |= 0x60; carry = 1; }
        a = (a + adj) & 0xFF;
        this.setNZ8(a); this.flag(C, carry); this.a = a;
        return;
      }
      case 0x1B: this.a = this.add8(this.a, this.b, 0); return;                  // ABA
      case 0x18: if (this.hd63701) { const t = this.x; this.x = this.d; this.d = t; } return;   // XGDX
      case 0x1A: if (this.hd63701) this.sleeping = true; return;                // SLP
      case 0x30: this.x = (this.sp + 1) & 0xFFFF; return;                        // TSX
      case 0x31: this.sp = (this.sp + 1) & 0xFFFF; return;                       // INS
      case 0x32: this.a = this.pull(); return;
      case 0x33: this.b = this.pull(); return;
      case 0x34: this.sp = (this.sp - 1) & 0xFFFF; return;                       // DES
      case 0x35: this.sp = (this.x - 1) & 0xFFFF; return;                        // TXS
      case 0x36: this.push(this.a); return;
      case 0x37: this.push(this.b); return;
      case 0x38: this.x = this.pull16(); return;                                 // PULX
      case 0x39: this.pc = this.pull16(); return;                                // RTS
      case 0x3A: this.x = (this.x + this.b) & 0xFFFF; return;                    // ABX
      case 0x3B:                                                                 // RTI
        this.cc = this.pull() | 0xC0; this.b = this.pull(); this.a = this.pull();
        this.x = this.pull16(); this.pc = this.pull16();
        return;
      case 0x3C: this.push16(this.x); return;                                    // PSHX
      case 0x3D: { const r = this.a * this.b; this.d = r; this.flag(C, r & 0x80); return; }   // MUL
      case 0x3E:                                                                 // WAI: stack now, then wait
        this.push16(this.pc); this.push16(this.x); this.push(this.a); this.push(this.b); this.push(this.cc);
        this.waiting = true;
        return;
      case 0x3F: this.interrupt(0xFFFA); return;                                 // SWI
    }
    // Undefined opcodes act as NOPs.
  }
}
