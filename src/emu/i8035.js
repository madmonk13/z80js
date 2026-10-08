// Intel 8035/8039 (MCS-48) microcontroller core. Arcade boards use it as a
// sound processor (Donkey Kong, Donkey Kong Jr., Mario Bros.).
//
// Counts machine cycles (one is 15 oscillator clocks). Internal RAM holds the
// two register banks (0-7, 24-31) and the 8-level stack (8-23). The host
// supplies:
//   rom: Uint8Array of program memory (up to 4K)
//   read(port) / write(port, v) for MOVX (external bus, port = R0/R1)
//   portIn(n) -> byte for P1 (n = 1) and P2 (n = 2); test(n) -> 0/1 for T0/T1
//   portOut(n, v) when P1/P2 are written (OUTL, ANL, ORL)
// and raises the external interrupt by setting `int` true (level sensitive).

import { capture, apply } from './state.js';

const C = 0x80, AC = 0x40, F0 = 0x20, BS = 0x10;

// Two-cycle instructions: immediate data, jumps and calls, port and external
// memory transfers, table lookups, returns.
const TWO = new Uint8Array(256);
for (const op of [
  0x03, 0x13, 0x43, 0x53, 0xD3, 0x23,                       // ALU/MOV A,#
  0x88, 0x89, 0x8A, 0x98, 0x99, 0x9A,                       // ORL/ANL BUS/P1/P2,#
  0x08, 0x09, 0x0A, 0x02, 0x39, 0x3A,                       // INS, IN, OUTL
  0x80, 0x81, 0x90, 0x91, 0xA3, 0xE3, 0xB3,                 // MOVX, MOVP, MOVP3, JMPP
  0x83, 0x93, 0x16, 0x26, 0x36, 0x46, 0x56, 0x76, 0x86, 0x96, 0xB6, 0xC6, 0xE6, 0xF6,
  0xB0, 0xB1,                                               // MOV @Ri,#
  0x0C, 0x0D, 0x0E, 0x0F, 0x3C, 0x3D, 0x3E, 0x3F, 0x8C, 0x8D, 0x8E, 0x8F, 0x9C, 0x9D, 0x9E, 0x9F,
]) TWO[op] = 1;
for (let i = 0; i < 8; i++) {
  TWO[0x04 | (i << 5)] = 1;          // JMP
  TWO[0x14 | (i << 5)] = 1;          // CALL
  TWO[0x12 | (i << 5)] = 1;          // JBb
  TWO[0xB8 + i] = 1;                 // MOV Rr,#
  TWO[0xE8 + i] = 1;                 // DJNZ
}

const I_STATE = ['pc', 'a', 'psw', 'a11', 'f1', 'p1', 'p2', 'xirqEnable', 'tirqEnable', 'inIrq', 'timer', 'timerOn', 'prescale', 'timerFlag', 'timerPending', 'int', 'cycles', 'ram'];

export class I8035 {
  // Save states: everything that changes while running (not ROM-derived data).
  saveState() { return capture(this, I_STATE); }
  loadState(s) { apply(this, I_STATE, s); }

  constructor({ rom, read = () => 0xFF, write = () => {}, portIn = () => 0xFF, portOut = () => {}, test = () => 1 }) {
    this.rom = rom;
    this.readBus = read;
    this.writeBus = write;
    this.portIn = portIn;
    this.portOut = portOut;
    this.test = test;
    this.ram = new Uint8Array(128);
    this.reset();
  }

  reset() {
    this.pc = 0; this.a = 0; this.psw = 0;
    this.a11 = 0;              // memory bank for JMP/CALL (SEL MB0/MB1)
    this.f1 = 0;
    this.p1 = 0xFF; this.p2 = 0xFF;
    this.xirqEnable = false; this.tirqEnable = false;
    this.inIrq = false;
    this.timer = 0; this.timerOn = false; this.prescale = 0;
    this.timerFlag = false; this.timerPending = false;
    this.int = false;
    this.cycles = 0;
  }

  // ---------------------------------------------------------------- helpers

  romAt(a) { return this.rom[a & 0xFFF] ?? 0; }
  fetch() { const v = this.romAt(this.pc); this.pc = (this.pc & 0x800) | ((this.pc + 1) & 0x7FF); return v; }
  reg(r) { return ((this.psw & BS) ? 24 : 0) + r; }
  get sp() { return this.psw & 7; }
  push() {
    const at = 8 + this.sp * 2;
    this.ram[at] = this.pc & 0xFF;
    this.ram[at + 1] = ((this.pc >> 8) & 0x0F) | (this.psw & 0xF0);
    this.psw = (this.psw & 0xF8) | ((this.sp + 1) & 7);
  }
  pull() {
    this.psw = (this.psw & 0xF8) | ((this.sp - 1) & 7);
    const at = 8 + this.sp * 2;
    return { lo: this.ram[at], hi: this.ram[at + 1] };
  }
  // Conditional jumps stay in the page of the operand byte.
  jumpIf(cond) {
    const page = this.pc & 0xF00, target = this.fetch();     // pc points at the operand
    if (cond) this.pc = page | target;
  }
  add(v, carry) {
    const c = carry ? (this.psw >> 7) : 0, sum = this.a + v + c;
    this.psw = (this.psw & ~(C | AC)) | (sum > 0xFF ? C : 0) | (((this.a & 0x0F) + (v & 0x0F) + c) > 0x0F ? AC : 0);
    this.a = sum & 0xFF;
  }
  setP1(v) { this.p1 = v & 0xFF; this.portOut(1, this.p1); }
  setP2(v) { this.p2 = v & 0xFF; this.portOut(2, this.p2); }

  interrupt(vector) {
    this.push();
    this.pc = vector;
    this.inIrq = true;
    this.cycles += 2;
  }

  // ---------------------------------------------------------------- run

  run(n) {
    const end = this.cycles + n;
    while (this.cycles < end) this.step();
  }

  step() {
    if (!this.inIrq) {
      if (this.int && this.xirqEnable) { this.interrupt(3); return; }
      if (this.timerPending && this.tirqEnable) { this.timerPending = false; this.interrupt(7); return; }
    }
    const op = this.fetch();
    const cyc = TWO[op] ? 2 : 1;
    this.exec(op);
    this.cycles += cyc;
    if (this.timerOn) {
      this.prescale += cyc;
      while (this.prescale >= 32) {
        this.prescale -= 32;
        this.timer = (this.timer + 1) & 0xFF;
        if (this.timer === 0) { this.timerFlag = true; this.timerPending = true; }
      }
    }
  }

  exec(op) {
    const ram = this.ram;
    const lo = op & 0x0F, r = op & 7, i = op & 1;
    const at = (n) => ram[this.reg(n)] & 0x7F;          // @R0 / @R1 address

    // Register forms (low three bits pick R0-R7).
    if (lo >= 8) {
      const rr = this.reg(r);
      switch (op & 0xF8) {
        case 0x18: ram[rr] = (ram[rr] + 1) & 0xFF; return;                 // INC Rr
        case 0x28: { const t = this.a; this.a = ram[rr]; ram[rr] = t; return; } // XCH A,Rr
        case 0x48: this.a |= ram[rr]; return;                                 // ORL A,Rr
        case 0x58: this.a &= ram[rr]; return;                                 // ANL A,Rr
        case 0x68: this.add(ram[rr], false); return;                          // ADD A,Rr
        case 0x78: this.add(ram[rr], true); return;                           // ADDC A,Rr
        case 0xA8: ram[rr] = this.a; return;                                  // MOV Rr,A
        case 0xB8: ram[rr] = this.fetch(); return;                            // MOV Rr,#
        case 0xC8: ram[rr] = (ram[rr] - 1) & 0xFF; return;                 // DEC Rr
        case 0xD8: this.a ^= ram[rr]; return;                                 // XRL A,Rr
        case 0xE8: ram[rr] = (ram[rr] - 1) & 0xFF; this.jumpIf(ram[rr] !== 0); return; // DJNZ
        case 0xF8: this.a = ram[rr]; return;                                  // MOV A,Rr
      }
    }
    // JMP / CALL (address bits 8-10 in the opcode, bit 11 from the bank,
    // which is forced to 0 inside an interrupt routine).
    if ((op & 0x1F) === 0x04 || (op & 0x1F) === 0x14) {
      const target = ((op & 0xE0) << 3) | this.fetch() | (this.inIrq ? 0 : this.a11);
      if (op & 0x10) this.push();
      this.pc = target;
      return;
    }
    if ((op & 0x1F) === 0x12) { this.jumpIf(this.a & (1 << (op >> 5))); return; }   // JBb

    switch (op) {
      case 0x00: return;                                                       // NOP
      case 0x02: this.writeBus(0x100, this.a); return;                         // OUTL BUS,A
      case 0x03: this.add(this.fetch(), false); return;
      case 0x05: this.xirqEnable = true; return;                               // EN I
      case 0x07: this.a = (this.a - 1) & 0xFF; return;
      case 0x08: this.a = this.readBus(0x100); return;                         // INS A,BUS
      case 0x09: this.a = this.portIn(1) & this.p1; return;
      case 0x0A: this.a = this.portIn(2) & this.p2; return;
      case 0x10: case 0x11: ram[at(i)] = (ram[at(i)] + 1) & 0xFF; return;   // INC @Ri
      case 0x13: this.add(this.fetch(), true); return;
      case 0x15: this.xirqEnable = false; return;                              // DIS I
      case 0x16: { const f = this.timerFlag; this.timerFlag = false; this.jumpIf(f); return; } // JTF
      case 0x17: this.a = (this.a + 1) & 0xFF; return;
      case 0x20: case 0x21: { const t = this.a; this.a = ram[at(i)]; ram[at(i)] = t; return; }
      case 0x23: this.a = this.fetch(); return;
      case 0x25: this.tirqEnable = true; return;                               // EN TCNTI
      case 0x26: this.jumpIf(!this.test(0)); return;
      case 0x27: this.a = 0; return;
      case 0x30: case 0x31: {                                                  // XCHD A,@Ri
        const m = ram[at(i)];
        ram[at(i)] = (m & 0xF0) | (this.a & 0x0F);
        this.a = (this.a & 0xF0) | (m & 0x0F);
        return;
      }
      case 0x35: this.tirqEnable = false; this.timerPending = false; return;   // DIS TCNTI
      case 0x36: this.jumpIf(this.test(0)); return;
      case 0x37: this.a ^= 0xFF; return;
      case 0x39: this.setP1(this.a); return;
      case 0x3A: this.setP2(this.a); return;
      case 0x40: case 0x41: this.a |= ram[at(i)]; return;
      case 0x42: this.a = this.timer; return;                                  // MOV A,T
      case 0x43: this.a |= this.fetch(); return;
      case 0x45: this.timerOn = false; return;                                 // STRT CNT (event counter unused here)
      case 0x46: this.jumpIf(!this.test(1)); return;
      case 0x47: this.a = ((this.a << 4) | (this.a >> 4)) & 0xFF; return;      // SWAP A
      case 0x50: case 0x51: this.a &= ram[at(i)]; return;
      case 0x53: this.a &= this.fetch(); return;
      case 0x55: this.timerOn = true; this.prescale = 0; return;               // STRT T
      case 0x56: this.jumpIf(this.test(1)); return;
      case 0x57: {                                                             // DA A
        let a = this.a, c = this.psw & C;
        if ((a & 0x0F) > 9 || (this.psw & AC)) { a += 6; if (a > 0xFF) c = C; }
        if (((a >> 4) & 0x0F) > 9 || c) { a += 0x60; c = C; }
        this.a = a & 0xFF;
        this.psw = (this.psw & ~C) | c;
        return;
      }
      case 0x60: case 0x61: this.add(ram[at(i)], false); return;
      case 0x62: this.timer = this.a; return;                                  // MOV T,A
      case 0x65: this.timerOn = false; return;                                 // STOP TCNT
      case 0x67: { const c = this.psw & C; this.psw = (this.psw & ~C) | ((this.a & 1) ? C : 0); this.a = (this.a >> 1) | (c ? 0x80 : 0); return; } // RRC
      case 0x70: case 0x71: this.add(ram[at(i)], true); return;
      case 0x75: return;                                                       // ENT0 CLK
      case 0x76: this.jumpIf(this.f1); return;
      case 0x77: this.a = ((this.a >> 1) | (this.a << 7)) & 0xFF; return;      // RR A
      case 0x80: case 0x81: this.a = this.readBus(ram[this.reg(i)]); return;   // MOVX A,@Ri
      case 0x83: { const s = this.pull(); this.pc = ((s.hi & 0x0F) << 8) | s.lo; return; } // RET
      case 0x85: this.psw &= ~F0; return;
      case 0x86: this.jumpIf(this.int); return;                                // JNI: /INT low
      case 0x88: this.writeBus(0x100, this.readBus(0x100) | this.fetch()); return;
      case 0x89: this.setP1(this.p1 | this.fetch()); return;
      case 0x8A: this.setP2(this.p2 | this.fetch()); return;
      case 0x90: case 0x91: this.writeBus(ram[this.reg(i)], this.a); return;   // MOVX @Ri,A
      case 0x93: {                                                             // RETR
        const s = this.pull();
        this.pc = ((s.hi & 0x0F) << 8) | s.lo;
        this.psw = (this.psw & 0x0F) | (s.hi & 0xF0);
        this.inIrq = false;
        return;
      }
      case 0x95: this.psw ^= F0; return;
      case 0x96: this.jumpIf(this.a !== 0); return;
      case 0x97: this.psw &= ~C; return;
      case 0x98: this.writeBus(0x100, this.readBus(0x100) & this.fetch()); return;
      case 0x99: this.setP1(this.p1 & this.fetch()); return;
      case 0x9A: this.setP2(this.p2 & this.fetch()); return;
      case 0xA0: case 0xA1: ram[at(i)] = this.a; return;
      case 0xA3: this.a = this.romAt((this.pc & 0xF00) | this.a); return;      // MOVP A,@A
      case 0xA5: this.f1 = 0; return;
      case 0xA7: this.psw ^= C; return;
      case 0xB0: case 0xB1: ram[at(i)] = this.fetch(); return;
      case 0xB3: this.pc = (this.pc & 0xF00) | this.romAt((this.pc & 0xF00) | this.a); return; // JMPP @A
      case 0xB5: this.f1 ^= 1; return;
      case 0xB6: this.jumpIf(this.psw & F0); return;
      case 0xC5: this.psw &= ~BS; return;                                      // SEL RB0
      case 0xC6: this.jumpIf(this.a === 0); return;
      case 0xC7: this.a = this.psw | 0x08; return;                             // MOV A,PSW
      case 0xD0: case 0xD1: this.a ^= ram[at(i)]; return;
      case 0xD3: this.a ^= this.fetch(); return;
      case 0xD5: this.psw |= BS; return;                                       // SEL RB1
      case 0xD7: this.psw = this.a & 0xF7; return;                             // MOV PSW,A
      case 0xE3: this.a = this.romAt(0x300 | this.a); return;                  // MOVP3 A,@A
      case 0xE5: this.a11 = 0; return;                                         // SEL MB0
      case 0xE6: this.jumpIf(!(this.psw & C)); return;
      case 0xE7: this.a = ((this.a << 1) | (this.a >> 7)) & 0xFF; return;      // RL A
      case 0xF0: case 0xF1: this.a = ram[at(i)]; return;
      case 0xF5: this.a11 = 0x800; return;                                     // SEL MB1
      case 0xF6: this.jumpIf(this.psw & C); return;
      case 0xF7: { const c = this.psw & C; this.psw = (this.psw & ~C) | ((this.a & 0x80) ? C : 0); this.a = ((this.a << 1) | (c ? 1 : 0)) & 0xFF; return; } // RLC
      // 8243 expander ports (MOVD/ANLD/ORLD) and undefined opcodes: no effect.
    }
  }
}
