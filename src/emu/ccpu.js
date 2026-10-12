// The Cinematronics CPU (Tail Gunner, Star Castle, Rip Off, Armor Attack):
// a 12-bit processor built from TTL, about 5 MHz, with no stack or
// interrupts. Two accumulators (A and B; most instructions work on A, and an
// instruction can't name B: a "B" prefix means the next one does), 256 words
// of 12-bit RAM addressed by a page register P and an index I, a jump
// register J, and the beam registers X and Y. Draws by computing an endpoint
// in A/B and executing DV.
//
// Flags come lazily from the last accumulator operation: A0 (bit 0 of A
// before it), NC (no carry out of bit 12), LT / EQ (the operand compared with
// the old accumulator) and MI (bit 11 of a result, visible two instructions
// later). JMI tests an external line instead where the board wires one (the
// joystick comparator).
//
// Modeled after Zonn Moore's documentation of the instruction set.

import { capture, apply } from './state.js';

const STATE = ['pc', 'a', 'b', 'i', 'j', 'p', 'x', 'y', 't', 'onB', 'a0', 'nc', 'cmpAcc', 'cmpVal',
  'mi', 'mi1', 'mi2', 'cycles', 'waiting', 'frameAt', 'ram'];
const sx12 = (v) => ((v & 0xFFF) << 20) >> 20;

export class CCPU {
  // bus: { op(addr) -> byte, input(port) -> bit, output(port, bit), external() -> bit, vector(x0, y0, x1, y1, shift) }
  constructor(bus) { this.bus = bus; this.ram = new Uint16Array(256); this.reset(); }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.pc = 0; this.a = 0; this.b = 0; this.i = 0; this.j = 0; this.p = 0; this.x = 0; this.y = 0; this.t = 0;
    this.onB = false;
    this.a0 = 0; this.nc = 0; this.cmpAcc = 0; this.cmpVal = 1;
    this.mi = this.mi1 = this.mi2 = 0;
    this.cycles = 0;
    this.waiting = false;      // FRM: idle until the next frame
    this.frameAt = 0;          // cycle count when the current frame began
  }

  // The board calls this at the start of each frame.
  startFrame() { this.waiting = false; this.frameAt = this.cycles; }

  get acc() { return this.onB ? this.b : this.a; }
  set acc(v) { if (this.onB) this.b = v; else this.a = v; }

  // The usual accumulator update: flags from the old values, keep 12 bits.
  accOp(result, operand) {
    this.a0 = this.a;
    this.cmpAcc = this.acc; this.cmpVal = operand & 0xFFF;
    this.nc = ~result;
    this.acc = result & 0xFFF;
  }
  // After each instruction: back to A, or (a "B" prefix) toggle to B.
  nextA() { this.mi2 = this.acc; this.onB = false; }
  nextB() { this.mi2 = this.acc; this.onB = !this.onB; }

  rd(addr) { return this.ram[addr & 0xFF] & 0xFFF; }
  jumpIn() { this.pc = ((this.pc - 1) & 0xF000) + this.j; }
  // Arithmetic right shift of a 12-bit value.
  static asr(v) { return (sx12(v) >> 1) & 0xFFF; }

  run(budget) {
    const start = this.cycles, end = start + budget, bus = this.bus;
    while (this.cycles < end && !this.waiting) {
      this.mi = this.mi1; this.mi1 = this.mi2;
      const op = bus.op(this.pc); this.pc = (this.pc + 1) & 0xFFFF;
      const lo = op & 15;
      switch (op >> 4) {
        case 0x0: { const v = lo << 8; this.accOp(v, v); this.nextA(); this.cycles += 1; break; }       // LDAI
        case 0x1: {                                                                                      // INP
          const v = (this.onB ? bus.input(16 + (op & 7)) : bus.input(lo)) & 1;
          this.accOp(v, v); this.nextA(); this.cycles += 1; break;
        }
        case 0x2: {                                                                                      // A8I / A4I
          const v = lo ? lo : bus.op(this.pc++);
          this.accOp(this.acc + v, v); this.nextA(); this.cycles += lo ? 1 : 3; break;
        }
        case 0x3: {                                                                                      // S8I / S4I
          const v = lo ? lo : bus.op(this.pc++);
          this.accOp(this.acc + (v ^ 0xFFF) + 1, v); this.nextA(); this.cycles += lo ? 1 : 3; break;
        }
        case 0x4: {                                                                                      // LPAI
          const v = bus.op(this.pc++);
          this.j = lo + (v & 0xF0) + ((v & 0x0F) << 8);
          this.nextA(); this.cycles += 3; break;
        }
        case 0x5: this.branch(op); break;
        case 0x6: { this.i = (this.p << 4) + lo; const v = this.rd(this.i); this.accOp(this.acc + v, v); this.nextA(); this.cycles += 3; break; }                  // ADD
        case 0x7: { this.i = (this.p << 4) + lo; const v = this.rd(this.i); this.accOp(this.acc + (v ^ 0xFFF) + 1, v); this.nextA(); this.cycles += 3; break; }   // SUB
        case 0x8: this.p = lo; this.nextA(); this.cycles += 1; break;                                   // SETP
        case 0x9: if (!this.onB) bus.output(op & 7, ~this.a & 1); this.nextA(); this.cycles += 1; break;  // OUT
        case 0xA: { this.i = (this.p << 4) + lo; const v = this.rd(this.i); this.accOp(v, v); this.nextA(); this.cycles += 3; break; }                              // LDA
        case 0xB: {                                                                                      // TST
          this.i = (this.p << 4) + lo;
          const v = this.rd(this.i), r = this.acc + (v ^ 0xFFF) + 1;
          this.a0 = this.a; this.cmpAcc = this.acc; this.cmpVal = v; this.nc = ~r;
          this.nextA(); this.cycles += 3; break;
        }
        case 0xC: this.i = (this.p << 4) + lo; this.i = this.rd(this.i) & 0xFF; this.nextA(); this.cycles += 3; break;   // WS
        case 0xD: this.i = (this.p << 4) + lo; this.ram[this.i] = this.acc; this.nextA(); this.cycles += 3; break;      // STA
        default: this.misc(op); break;
      }
    }
    if (this.waiting) this.cycles = end;
    return this.cycles - start;
  }

  // 5x: jumps to J within the current 4K page (T4K jumps across pages); the
  // 50-57 forms are also "B" prefixes.
  branch(op) {
    const lo = op & 7, prefixB = !(op & 8);
    let take;
    switch (lo) {
      case 0: take = prefixB ? 'page' : true; break;                  // T4K (50) / JMP (58)
      case 1: take = this.bus.external ? this.bus.external() : (this.mi >> 11) & 1; break;   // JMI
      case 2: take = false; break;                                    // JVN: the vector generator is never busy
      case 3: take = this.cmpVal < this.cmpAcc; break;                // JLT
      case 4: take = this.cmpVal === this.cmpAcc; break;              // JEQ
      case 5: take = (this.nc >> 12) & 1; break;                      // JCZ
      case 6: take = this.a0 & 1; break;                              // JOS
      case 7: take = false; break;                                    // SSA / NOP
    }
    if (take === 'page') { this.pc = (this.p << 12) + this.j; this.nextB(); this.cycles += 4; return; }
    if (op === 0x58) { this.jumpIn(); this.nextA(); this.cycles += 4; return; }
    if (take) { this.jumpIn(); this.cycles += 2; }
    if (prefixB) this.nextB(); else this.nextA();
    this.cycles += 2;
  }

  // Ex / Fx: the indirect (through I), shift, vector and frame instructions.
  misc(op) {
    const bus = this.bus, k = op & 15;
    switch (k) {
      case 0x0:
        if (op === 0xE0) {                                            // DV: draw from (X, Y) toward (A, B), scaled by T
          const sxA = sx12(this.a), syB = sx12(this.b);
          const ex = ((sxA - this.x) >> this.t) + this.x, ey = ((syB - this.y) >> this.t) + this.y;
          bus.vector(this.x, this.y, (ex << 16) >> 16, (ey << 16) >> 16, this.t);
          this.a = this.x & 0xFFF; this.b = this.y & 0xFFF;
        } else { this.x = sx12(this.a); this.y = sx12(this.b); }     // IV: beam to (A, B)
        this.nextA(); this.cycles += 1; return;
      case 0x1:
        if (op === 0xE1) this.j = this.rd(this.i);                    // LPAP
        else this.i = this.rd(this.i) & 0xFF;                         // WSP
        this.nextA(); this.cycles += 3; return;
      case 0x2: {                                                     // LKP: read program memory at the accumulator
        const v = bus.op(((this.pc - 1) & 0xF000) + this.acc);
        this.accOp(v, v); this.nextA(); this.cycles += 7; this.pc = (this.pc + 1) & 0xFFFF; return;
      }
      case 0x3: this.mul(); this.nextA(); this.cycles += 2; return;   // MUL: one multiply step
      case 0x4: {                                                     // NV: normalize A and B together
        this.t = 0;
        const flat = (v) => (v & 0xA00) === 0 || (v & 0xA00) === 0xA00;
        while (flat(this.a) && flat(this.b) && this.t < 16) {
          this.a = (this.a << 1) & 0xFFF; this.b = (this.b << 1) & 0xFFF; this.t++; this.cycles++;
        }
        this.nextA(); this.cycles += 1; return;
      }
      case 0x5:                                                       // FRM: wait for the frame signal
        // The signal stays up a little while after a frame starts, so a
        // second FRM right away (Tail Gunner has two in a row) goes through.
        if (this.cycles - this.frameAt > 256) this.waiting = true;
        this.nextA(); this.cycles += 1; return;
      case 0x6: this.ram[this.i] = this.acc; this.nextA(); this.cycles += 2; return;   // STAP
      case 0x7: case 0x8: case 0x9: case 0xA: {                       // ADDP (F7 CST too), SUBP, ANDP, LDAP
        const v = this.rd(this.i);
        if (k === 0x7) this.accOp(this.acc + v, v);
        else if (k === 0x8) this.accOp(this.acc + (v ^ 0xFFF) + 1, v);
        else if (k === 0x9) this.accOp(this.acc & v, v);
        else this.accOp(v, v);
        this.nextA(); this.cycles += k === 0x8 ? 3 : 2; return;
      }
      default: this.shift(op); this.nextA(); this.cycles += 1; return;
    }
  }

  // SHR, SHL, ASR, SHRB, SHLB. Their compare operand is a fixed pattern
  // from the opcode, and bit 12 (the carry) comes from adding it.
  shift(op) {
    const k = op & 15, pat = ((k << 8) | k | (op & 0xF0)) & 0xFFF;
    let v;
    switch (k) {
      case 0xB: v = this.onB ? CCPU.asr(this.b) : this.a >> 1; break;
      case 0xC: v = (this.acc << 1) & 0xFFF; break;
      case 0xD: v = CCPU.asr(this.acc); this.accOp(v, pat); return;
      case 0xE:
        if (!this.onB) { v = (this.a >> 1) | ((this.b << 11) & 0x800); this.b = CCPU.asr(this.b); }
        else v = CCPU.asr(this.b);
        break;
      case 0xF:
        if (!this.onB) { v = (this.a << 1) & 0xFFF; this.b = (this.b << 1) & 0xFFF; }
        else v = (this.b << 1) & 0xFFF;
        break;
    }
    v |= (this.acc + pat) & 0x1000;
    this.accOp(v, pat);
  }

  mul() {
    const v = this.rd(this.i);
    this.a0 = this.a;
    this.cmpVal = v;
    if (!this.onB) {
      if (this.a & 1) {
        this.cmpAcc = this.b;
        this.a = (this.a >> 1) | ((this.b << 11) & 0x800);
        this.b = CCPU.asr(this.b);
        const r = this.b + v;
        this.nc = ~r; this.mi2 = r;
        this.b = r & 0xFFF;
      } else {
        this.cmpAcc = this.a;
        const r = this.a + v;
        this.a = (this.a >> 1) | ((this.b << 11) & 0x800);
        this.b = CCPU.asr(this.b);
        this.nc = ~r; this.mi2 = r;
      }
    } else {
      this.cmpAcc = this.b;
      this.b = CCPU.asr(this.b);
      const r = this.b + v;
      this.nc = ~r; this.mi2 = r;
      if (this.a & 1) this.b = r & 0xFFF;
    }
  }
}
