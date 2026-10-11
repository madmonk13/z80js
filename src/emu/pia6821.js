// Motorola 6821 PIA (Peripheral Interface Adapter): two 8-bit ports, each
// with a data-direction register and a control register, plus two control
// lines per side. C1 is an input that sets an interrupt flag on its active
// edge; C2 is either another such input or an output.
//
// Registers (offset): 0 port A data or DDR A, 1 control A, 2 port B data or
// DDR B, 3 control B. Control register bits: 0 C1 interrupt enable, 1 C1
// active edge (1 = rising), 2 data (1) or DDR (0) at offset 0/2, 3-5 C2 mode
// (bit 5 set: output, then bit 4 set: C2 = bit 3), 6 C2 flag, 7 C1 flag.
// Reading a port's data clears its flags.
//
// The board supplies inA()/inB() for the input pins, outA(v)/outB(v) for the
// outputs, ca2(v)/cb2(v) for C2 outputs, and irqA(on)/irqB(on).

import { capture, apply } from './state.js';

const STATE = ['ddrA', 'ddrB', 'outRegA', 'outRegB', 'crA', 'crB', 'c1A', 'c1B', 'c2A', 'c2B'];

export class PIA6821 {
  constructor({ inA = () => 0xFF, inB = () => 0xFF, outA = () => {}, outB = () => {}, ca2 = () => {}, cb2 = () => {}, irqA = () => {}, irqB = () => {} } = {}) {
    Object.assign(this, { inA, inB, outA, outB, ca2Out: ca2, cb2Out: cb2, irqAOut: irqA, irqBOut: irqB });
    this.reset();
  }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.ddrA = this.ddrB = 0; this.outRegA = this.outRegB = 0;
    this.crA = this.crB = 0;
    this.c1A = this.c1B = 0; this.c2A = this.c2B = 0;
  }

  irqA() { const c = this.crA; return !!((c & 0x80 && c & 0x01) || (c & 0x40 && c & 0x08 && !(c & 0x20))); }
  irqB() { const c = this.crB; return !!((c & 0x80 && c & 0x01) || (c & 0x40 && c & 0x08 && !(c & 0x20))); }
  updateIrq() { this.irqAOut(this.irqA()); this.irqBOut(this.irqB()); }

  read(r) {
    switch (r & 3) {
      case 0:
        if (!(this.crA & 4)) return this.ddrA;
        this.crA &= 0x3F; this.updateIrq();
        return (this.inA() & ~this.ddrA) | (this.outRegA & this.ddrA);
      case 1: return this.crA;
      case 2:
        if (!(this.crB & 4)) return this.ddrB;
        this.crB &= 0x3F; this.updateIrq();
        return (this.inB() & ~this.ddrB) | (this.outRegB & this.ddrB);
      default: return this.crB;
    }
  }

  write(r, v) {
    switch (r & 3) {
      case 0:
        if (this.crA & 4) { this.outRegA = v; this.outA(v & this.ddrA | (~this.ddrA & 0xFF & this.inA())); } else this.ddrA = v;
        break;
      case 1: this.crA = (this.crA & 0xC0) | (v & 0x3F); this.c2Output('A'); this.updateIrq(); break;
      case 2:
        if (this.crB & 4) { this.outRegB = v; this.outB(v & this.ddrB); } else this.ddrB = v;
        break;
      default: this.crB = (this.crB & 0xC0) | (v & 0x3F); this.c2Output('B'); this.updateIrq(); break;
    }
  }

  // C2 as a manual output: bit 5 and bit 4 set, level from bit 3.
  c2Output(side) {
    const cr = side === 'A' ? this.crA : this.crB;
    if ((cr & 0x30) === 0x30) (side === 'A' ? this.ca2Out : this.cb2Out)((cr >> 3) & 1);
  }

  // C1/C2 input lines: set the flag on the selected edge.
  setC1(side, v) {
    v = v ? 1 : 0;
    const key = side === 'A' ? 'c1A' : 'c1B', crKey = side === 'A' ? 'crA' : 'crB';
    const old = this[key]; this[key] = v;
    if (old === v) return;
    const rising = !!(this[crKey] & 0x02);
    if (rising ? v : !v) { this[crKey] |= 0x80; this.updateIrq(); }
  }
  setC2(side, v) {
    v = v ? 1 : 0;
    const key = side === 'A' ? 'c2A' : 'c2B', crKey = side === 'A' ? 'crA' : 'crB';
    const old = this[key]; this[key] = v;
    if (old === v || (this[crKey] & 0x20)) return;
    const rising = !!(this[crKey] & 0x10);
    if (rising ? v : !v) { this[crKey] |= 0x40; this.updateIrq(); }
  }
}
