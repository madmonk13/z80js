// Motorola 68705 (6805 family) microcontroller core: A, X, an 11-bit PC, a
// 5-bit stack in page 0 (60-7F), and the H I N Z C flags. Used as a
// protection/helper MCU (Legend of Kage and others). The host supplies
// read/write over the 2K space (ports, RAM and ROM included) and drives the
// external interrupt line with `irq`. The on-chip timer isn't modeled.
//
// Timing is approximate (a few cycles per instruction).

import { capture, apply } from './state.js';

const STATE = ['a', 'x', 'pc', 'sp', 'h', 'i', 'n', 'z', 'c', 'irq', 'cycles'];
const MASK = 0x7FF;

export class M6805 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor({ read, write }) {
    this.read = read; this.write = write;
    this.cycles = 0;
    this.reset();
  }

  reset() {
    this.a = 0; this.x = 0; this.sp = 0x7F;
    this.h = 0; this.i = 1; this.n = 0; this.z = 0; this.c = 0;
    this.irq = false;
    this.pc = ((this.read(0x7FE) << 8) | this.read(0x7FF)) & MASK;
  }

  get cc() { return 0xE0 | (this.h << 4) | (this.i << 3) | (this.n << 2) | (this.z << 1) | this.c; }
  set cc(v) { this.h = (v >> 4) & 1; this.i = (v >> 3) & 1; this.n = (v >> 2) & 1; this.z = (v >> 1) & 1; this.c = v & 1; }

  fetch() { const v = this.read(this.pc); this.pc = (this.pc + 1) & MASK; return v; }
  push(v) { this.write(this.sp, v & 0xFF); this.sp = 0x60 | ((this.sp - 1) & 0x1F); }
  pull() { this.sp = 0x60 | ((this.sp + 1) & 0x1F); return this.read(this.sp); }
  nz(v) { this.n = (v >> 7) & 1; this.z = v === 0 ? 1 : 0; }

  interrupt(vec) {
    this.push(this.pc); this.push(this.pc >> 8); this.push(this.x); this.push(this.a); this.push(this.cc);
    this.i = 1;
    this.pc = ((this.read(vec) << 8) | this.read(vec + 1)) & MASK;
    this.cycles += 11;
  }

  run(n) {
    const start = this.cycles, end = start + n;
    while (this.cycles < end) {
      if (this.irq && !this.i) { this.interrupt(0x7FA); continue; }
      this.step();
    }
    return this.cycles - start;
  }

  cond(op) {
    switch (op & 0x0F) {
      case 0x0: return true;
      case 0x1: return false;
      case 0x2: return !this.c && !this.z;
      case 0x3: return this.c || this.z;
      case 0x4: return !this.c;
      case 0x5: return !!this.c;
      case 0x6: return !this.z;
      case 0x7: return !!this.z;
      case 0x8: return !this.h;
      case 0x9: return !!this.h;
      case 0xA: return !this.n;
      case 0xB: return !!this.n;
      case 0xC: return !this.i;
      case 0xD: return !!this.i;
      case 0xE: return !!this.irq;                 // BIL: the INT pin is low while the interrupt is asserted
      default: return !this.irq;                   // BIH
    }
  }

  // Read-modify-write operations (rows 3-7).
  rmw(op, v) {
    switch (op & 0x0F) {
      case 0x0: { const r = (-v) & 0xFF; this.c = r !== 0 ? 1 : 0; this.nz(r); return r; }   // NEG
      case 0x3: { const r = ~v & 0xFF; this.c = 1; this.nz(r); return r; }                  // COM
      case 0x4: { this.c = v & 1; const r = v >> 1; this.nz(r); return r; }                // LSR
      case 0x6: { const r = (v >> 1) | (this.c << 7); this.c = v & 1; this.nz(r); return r; }   // ROR
      case 0x7: { this.c = v & 1; const r = (v >> 1) | (v & 0x80); this.nz(r); return r; } // ASR
      case 0x8: { this.c = v >> 7; const r = (v << 1) & 0xFF; this.nz(r); return r; }      // LSL
      case 0x9: { const r = ((v << 1) | this.c) & 0xFF; this.c = v >> 7; this.nz(r); return r; }   // ROL
      case 0xA: { const r = (v - 1) & 0xFF; this.nz(r); return r; }                        // DEC
      case 0xC: { const r = (v + 1) & 0xFF; this.nz(r); return r; }                        // INC
      case 0xD: this.nz(v); return -1;                                                     // TST
      case 0xF: this.n = 0; this.z = 1; return 0;                                          // CLR
    }
    return -1;
  }

  step() {
    const op = this.fetch();
    this.cycles += 4;
    if (op < 0x10) {                               // BRSET / BRCLR n,dir,rel
      const addr = this.fetch(), rel = (this.fetch() << 24) >> 24;
      const bit = (this.read(addr) >> (op >> 1)) & 1;
      this.c = bit;
      if ((op & 1) ? !bit : bit) this.pc = (this.pc + rel) & MASK;
      this.cycles += 6;
      return;
    }
    if (op < 0x20) {                               // BSET / BCLR n,dir
      const addr = this.fetch(), m = 1 << ((op >> 1) & 7);
      const v = this.read(addr);
      this.write(addr, op & 1 ? v & ~m : v | m);
      this.cycles += 3;
      return;
    }
    if (op < 0x30) { const rel = (this.fetch() << 24) >> 24; if (this.cond(op)) this.pc = (this.pc + rel) & MASK; return; }
    if (op < 0x80) {
      const row = op >> 4;
      if (row === 4 || row === 5) {
        const v = row === 4 ? this.a : this.x, r = this.rmw(op, v);
        if (r >= 0) { if (row === 4) this.a = r; else this.x = r; }
        return;
      }
      const addr = row === 3 ? this.fetch() : row === 6 ? (this.fetch() + this.x) & 0xFF : this.x;
      const r = this.rmw(op, this.read(addr));
      if (r >= 0) this.write(addr, r);
      this.cycles += 2;
      return;
    }
    switch (op) {
      case 0x80: this.cc = this.pull(); this.a = this.pull(); this.x = this.pull(); { const hi = this.pull(); this.pc = ((hi << 8) | this.pull()) & MASK; } this.cycles += 5; return;   // RTI
      case 0x81: { const hi = this.pull(); this.pc = ((hi << 8) | this.pull()) & MASK; this.cycles += 2; return; }   // RTS
      case 0x83: this.interrupt(0x7FC); return;                                            // SWI
      case 0x97: this.x = this.a; return;
      case 0x98: this.c = 0; return;
      case 0x99: this.c = 1; return;
      case 0x9A: this.i = 0; return;
      case 0x9B: this.i = 1; return;
      case 0x9C: this.sp = 0x7F; return;
      case 0x9D: return;
      case 0x9F: this.a = this.x; return;
      case 0xAD: { const rel = (this.fetch() << 24) >> 24; this.push(this.pc); this.push(this.pc >> 8); this.pc = (this.pc + rel) & MASK; this.cycles += 4; return; }   // BSR
    }
    if (op < 0xA0) return;                         // other 8x/9x codes: no-ops
    // Register/memory instructions: the high nibble picks the addressing mode.
    const mode = op >> 4, fn = op & 0x0F;
    let addr = -1;
    switch (mode) {
      case 0xB: addr = this.fetch(); break;
      case 0xC: { const hi = this.fetch(); addr = ((hi << 8) | this.fetch()) & MASK; break; }
      case 0xD: { const hi = this.fetch(); addr = (((hi << 8) | this.fetch()) + this.x) & MASK; break; }
      case 0xE: addr = (this.fetch() + this.x) & MASK; break;
      case 0xF: addr = this.x; break;
    }
    const operand = () => (mode === 0xA ? this.fetch() : this.read(addr));
    switch (fn) {
      case 0x0: { const m = operand(), r = this.a - m; this.c = r < 0 ? 1 : 0; this.a = r & 0xFF; this.nz(this.a); return; }   // SUB
      case 0x1: { const m = operand(), r = this.a - m; this.c = r < 0 ? 1 : 0; this.nz(r & 0xFF); return; }                    // CMP
      case 0x2: { const m = operand(), r = this.a - m - this.c; this.c = r < 0 ? 1 : 0; this.a = r & 0xFF; this.nz(this.a); return; }   // SBC
      case 0x3: { const m = operand(), r = this.x - m; this.c = r < 0 ? 1 : 0; this.nz(r & 0xFF); return; }                    // CPX
      case 0x4: this.a &= operand(); this.nz(this.a); return;                                                             // AND
      case 0x5: this.nz(this.a & operand()); return;                                                                      // BIT
      case 0x6: this.a = operand(); this.nz(this.a); return;                                                              // LDA
      case 0x7: if (addr >= 0) { this.write(addr, this.a); this.nz(this.a); } return;                                     // STA
      case 0x8: this.a ^= operand(); this.nz(this.a); return;                                                             // EOR
      case 0x9: { const m = operand(), r = this.a + m + this.c; this.h = ((this.a & 15) + (m & 15) + this.c) > 15 ? 1 : 0; this.c = r > 0xFF ? 1 : 0; this.a = r & 0xFF; this.nz(this.a); return; }   // ADC
      case 0xA: this.a |= operand(); this.nz(this.a); return;                                                             // ORA
      case 0xB: { const m = operand(), r = this.a + m; this.h = ((this.a & 15) + (m & 15)) > 15 ? 1 : 0; this.c = r > 0xFF ? 1 : 0; this.a = r & 0xFF; this.nz(this.a); return; }   // ADD
      case 0xC: if (addr >= 0) this.pc = addr; return;                                                                    // JMP
      case 0xD: if (addr >= 0) { this.push(this.pc); this.push(this.pc >> 8); this.pc = addr; this.cycles += 4; } return;   // JSR
      case 0xE: this.x = operand(); this.nz(this.x); return;                                                              // LDX
      case 0xF: if (addr >= 0) { this.write(addr, this.x); this.nz(this.x); } return;                                     // STX
    }
  }
}
