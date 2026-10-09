// MOS 6502/6507 core with decimal mode and the common "illegal" opcodes.
// Shared with 6502js (which runs it as the 2600's 6507); here it also takes
// IRQ and NMI for arcade boards (Centipede).
//
// Timing model: every bus access made by an instruction's operation (load,
// store, read-modify-write) is stamped with the cycle on which it happens on
// real hardware, which for these instructions is the instruction's last cycle.
// The bus reads `cpu.busCycle` to catch the TIA/RIOT up before the access, so
// mid-scanline register writes land on the right color clock.

import { capture, apply } from './state.js';

const IMP = 0, ACC = 1, IMM = 2, ZP = 3, ZPX = 4, ZPY = 5, ABS = 6, ABX = 7,
  ABY = 8, IND = 9, IZX = 10, IZY = 11, REL = 12;

const MODE_LEN = [1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 2, 2, 2];

// [mnemonic, mode, cycles, pageCrossPenalty]
const OPS = new Array(256);
function def(m, list) {
  for (const [op, mode, cyc, pen] of list) OPS[op] = [m, mode, cyc, !!pen];
}

// Shared shape for the 8 "group one" ALU instructions.
function alu(m, base) {
  def(m, [
    [base + 0x09, IMM, 2], [base + 0x05, ZP, 3], [base + 0x15, ZPX, 4],
    [base + 0x0D, ABS, 4], [base + 0x1D, ABX, 4, 1], [base + 0x19, ABY, 4, 1],
    [base + 0x01, IZX, 6], [base + 0x11, IZY, 5, 1],
  ]);
}
alu('ORA', 0x00); alu('AND', 0x20); alu('EOR', 0x40); alu('ADC', 0x60);
alu('LDA', 0xA0); alu('CMP', 0xC0); alu('SBC', 0xE0);
def('STA', [[0x85, ZP, 3], [0x95, ZPX, 4], [0x8D, ABS, 4], [0x9D, ABX, 5],
  [0x99, ABY, 5], [0x81, IZX, 6], [0x91, IZY, 6]]);

function shift(m, base) {
  def(m, [[base + 0x0A, ACC, 2], [base + 0x06, ZP, 5], [base + 0x16, ZPX, 6],
    [base + 0x0E, ABS, 6], [base + 0x1E, ABX, 7]]);
}
shift('ASL', 0x00); shift('ROL', 0x20); shift('LSR', 0x40); shift('ROR', 0x60);

def('DEC', [[0xC6, ZP, 5], [0xD6, ZPX, 6], [0xCE, ABS, 6], [0xDE, ABX, 7]]);
def('INC', [[0xE6, ZP, 5], [0xF6, ZPX, 6], [0xEE, ABS, 6], [0xFE, ABX, 7]]);
def('LDX', [[0xA2, IMM, 2], [0xA6, ZP, 3], [0xB6, ZPY, 4], [0xAE, ABS, 4], [0xBE, ABY, 4, 1]]);
def('LDY', [[0xA0, IMM, 2], [0xA4, ZP, 3], [0xB4, ZPX, 4], [0xAC, ABS, 4], [0xBC, ABX, 4, 1]]);
def('STX', [[0x86, ZP, 3], [0x96, ZPY, 4], [0x8E, ABS, 4]]);
def('STY', [[0x84, ZP, 3], [0x94, ZPX, 4], [0x8C, ABS, 4]]);
def('CPX', [[0xE0, IMM, 2], [0xE4, ZP, 3], [0xEC, ABS, 4]]);
def('CPY', [[0xC0, IMM, 2], [0xC4, ZP, 3], [0xCC, ABS, 4]]);
def('BIT', [[0x24, ZP, 3], [0x2C, ABS, 4]]);
def('JMP', [[0x4C, ABS, 3], [0x6C, IND, 5]]);
def('JSR', [[0x20, ABS, 6]]);
for (const [op, m] of [[0x10, 'BPL'], [0x30, 'BMI'], [0x50, 'BVC'], [0x70, 'BVS'],
  [0x90, 'BCC'], [0xB0, 'BCS'], [0xD0, 'BNE'], [0xF0, 'BEQ']]) def(m, [[op, REL, 2]]);
for (const [op, m, c] of [[0x00, 'BRK', 7], [0x40, 'RTI', 6], [0x60, 'RTS', 6],
  [0x08, 'PHP', 3], [0x28, 'PLP', 4], [0x48, 'PHA', 3], [0x68, 'PLA', 4],
  [0x18, 'CLC', 2], [0x38, 'SEC', 2], [0x58, 'CLI', 2], [0x78, 'SEI', 2],
  [0xB8, 'CLV', 2], [0xD8, 'CLD', 2], [0xF8, 'SED', 2], [0xEA, 'NOP', 2],
  [0xAA, 'TAX', 2], [0xA8, 'TAY', 2], [0xBA, 'TSX', 2], [0x8A, 'TXA', 2],
  [0x9A, 'TXS', 2], [0x98, 'TYA', 2], [0xCA, 'DEX', 2], [0x88, 'DEY', 2],
  [0xE8, 'INX', 2], [0xC8, 'INY', 2]]) def(m, [[op, IMP, c]]);

// --- Illegal opcodes used by real 2600 software ---
for (const op of [0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA]) def('NOP', [[op, IMP, 2]]);
for (const op of [0x80, 0x82, 0x89, 0xC2, 0xE2]) def('NOP', [[op, IMM, 2]]);
for (const op of [0x04, 0x44, 0x64]) def('NOP', [[op, ZP, 3]]);
for (const op of [0x14, 0x34, 0x54, 0x74, 0xD4, 0xF4]) def('NOP', [[op, ZPX, 4]]);
def('NOP', [[0x0C, ABS, 4]]);
for (const op of [0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC]) def('NOP', [[op, ABX, 4, 1]]);
def('LAX', [[0xA7, ZP, 3], [0xB7, ZPY, 4], [0xAF, ABS, 4], [0xBF, ABY, 4, 1],
  [0xA3, IZX, 6], [0xB3, IZY, 5, 1], [0xAB, IMM, 2]]);
def('SAX', [[0x87, ZP, 3], [0x97, ZPY, 4], [0x8F, ABS, 4], [0x83, IZX, 6]]);
function rmwIllegal(m, base) {
  def(m, [[base + 0x07, ZP, 5], [base + 0x17, ZPX, 6], [base + 0x0F, ABS, 6],
    [base + 0x1F, ABX, 7], [base + 0x1B, ABY, 7], [base + 0x03, IZX, 8], [base + 0x13, IZY, 8]]);
}
rmwIllegal('SLO', 0x00); rmwIllegal('RLA', 0x20); rmwIllegal('SRE', 0x40);
rmwIllegal('RRA', 0x60); rmwIllegal('DCP', 0xC0); rmwIllegal('ISB', 0xE0);
def('ANC', [[0x0B, IMM, 2], [0x2B, IMM, 2]]);
def('ALR', [[0x4B, IMM, 2]]);
def('ARR', [[0x6B, IMM, 2]]);
def('SBX', [[0xCB, IMM, 2]]);
def('SBC', [[0xEB, IMM, 2]]);
def('ANE', [[0x8B, IMM, 2]]);
def('SHA', [[0x9F, ABY, 5], [0x93, IZY, 6]]);
def('SHX', [[0x9E, ABY, 5]]);
def('SHY', [[0x9C, ABX, 5]]);
def('TAS', [[0x9B, ABY, 5]]);
def('LAS', [[0xBB, ABY, 4, 1]]);
for (let op = 0; op < 256; op++) if (!OPS[op]) OPS[op] = ['JAM', IMP, 2, false];

const CPU_STATE = ['a', 'x', 'y', 'sp', 'pc', 'n', 'v', 'd', 'i', 'z', 'c', 'cycles', 'busCycle', 'jammed', 'irq', 'nmiPending'];
export class CPU6502 {
  saveState() { return capture(this, CPU_STATE); }
  loadState(s) { apply(this, CPU_STATE, s); }

  constructor(bus) {
    this.bus = bus;
    this.cycles = 0;      // total cycles executed
    this.busCycle = 0;    // cycle stamp of the current operation's bus access
    this.jammed = false;
    this.a = 0; this.x = 0; this.y = 0; this.sp = 0xFD; this.pc = 0;
    this.n = 0; this.v = 0; this.d = 0; this.i = 1; this.z = 0; this.c = 0;
    this.irq = false;       // IRQ line (level): taken while the I flag is clear
    this.nmiPending = false;
  }

  nmi() { this.nmiPending = true; }

  // Run at least `n` cycles; returns how many were run.
  run(n) {
    const start = this.cycles, end = start + n;
    while (this.cycles < end) this.step();
    return this.cycles - start;
  }

  // Push PC and P (B clear) and jump through a vector.
  interrupt(vector) {
    this.push(this.pc >> 8); this.push(this.pc & 0xFF);
    this.push(this.getP() & ~0x10);
    this.i = 1;
    this.pc = this.bus.read(vector) | (this.bus.read(vector + 1) << 8);
    this.cycles += 7;
  }

  reset() {
    this.a = this.x = this.y = 0;
    this.sp = 0xFD;
    this.d = 0; this.i = 1;
    this.jammed = false;
    this.pc = this.bus.read(0xFFFC) | (this.bus.read(0xFFFD) << 8);
  }

  getP() {
    return (this.n << 7) | (this.v << 6) | 0x20 | (this.d << 3) | (this.i << 2) | (this.z << 1) | this.c;
  }
  setP(p) {
    this.n = (p >> 7) & 1; this.v = (p >> 6) & 1; this.d = (p >> 3) & 1;
    this.i = (p >> 2) & 1; this.z = (p >> 1) & 1; this.c = p & 1;
  }

  push(v) { this.bus.write(0x100 | this.sp, v); this.sp = (this.sp - 1) & 0xFF; }
  pull() { this.sp = (this.sp + 1) & 0xFF; return this.bus.read(0x100 | this.sp); }

  nz(v) { this.n = (v >> 7) & 1; this.z = v === 0 ? 1 : 0; return v; }

  // Operation accesses: stamped with the instruction's final cycle.
  rd(addr) { this.busCycle = this.start + this.cyc - 1; return this.bus.read(addr); }
  wr(addr, v) { this.busCycle = this.start + this.cyc - 1; this.bus.write(addr, v & 0xFF); }

  adc(v) {
    const a = this.a, c = this.c;
    if (this.d) {
      let al = (a & 0x0F) + (v & 0x0F) + c;
      if (al >= 0x0A) al = ((al + 0x06) & 0x0F) + 0x10;
      let r = (a & 0xF0) + (v & 0xF0) + al;
      this.z = ((a + v + c) & 0xFF) === 0 ? 1 : 0;
      this.n = (r >> 7) & 1;
      this.v = (~(a ^ v) & (a ^ r) & 0x80) ? 1 : 0;
      if (r >= 0xA0) r += 0x60;
      this.c = r >= 0x100 ? 1 : 0;
      this.a = r & 0xFF;
    } else {
      const r = a + v + c;
      this.v = (~(a ^ v) & (a ^ r) & 0x80) ? 1 : 0;
      this.c = r > 0xFF ? 1 : 0;
      this.a = this.nz(r & 0xFF);
    }
  }

  sbc(v) {
    const a = this.a, b = this.c ? 0 : 1;
    const r = a - v - b;
    this.v = ((a ^ v) & (a ^ r) & 0x80) ? 1 : 0;
    this.c = r >= 0 ? 1 : 0;
    this.nz(r & 0xFF);
    if (this.d) {
      let al = (a & 0x0F) - (v & 0x0F) - b;
      if (al < 0) al = ((al - 0x06) & 0x0F) - 0x10;
      let ad = (a & 0xF0) - (v & 0xF0) + al;
      if (ad < 0) ad -= 0x60;
      this.a = ad & 0xFF;
    } else {
      this.a = r & 0xFF;
    }
  }

  cmp(reg, v) { const r = reg - v; this.c = r >= 0 ? 1 : 0; this.nz(r & 0xFF); }

  asl(v) { this.c = (v >> 7) & 1; return this.nz((v << 1) & 0xFF); }
  lsr(v) { this.c = v & 1; return this.nz(v >> 1); }
  rol(v) { const r = ((v << 1) | this.c) & 0xFF; this.c = (v >> 7) & 1; return this.nz(r); }
  ror(v) { const r = (v >> 1) | (this.c << 7); this.c = v & 1; return this.nz(r); }

  branch(cond) {
    const off = this.bus.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF;
    if (!cond) return;
    const target = (this.pc + ((off << 24) >> 24)) & 0xFFFF;
    this.cyc += ((target ^ this.pc) & 0xFF00) ? 2 : 1;
    this.pc = target;
  }

  // Resolve the effective address for the opcode's addressing mode.
  addr(mode, pen) {
    const bus = this.bus;
    let pc = this.pc, a, base, zp;
    switch (mode) {
      case IMM: a = pc; this.pc = (pc + 1) & 0xFFFF; return a;
      case ZP: a = bus.read(pc); this.pc = (pc + 1) & 0xFFFF; return a;
      case ZPX: a = (bus.read(pc) + this.x) & 0xFF; this.pc = (pc + 1) & 0xFFFF; return a;
      case ZPY: a = (bus.read(pc) + this.y) & 0xFF; this.pc = (pc + 1) & 0xFFFF; return a;
      case ABS: a = bus.read(pc) | (bus.read((pc + 1) & 0xFFFF) << 8); this.pc = (pc + 2) & 0xFFFF; return a;
      case ABX: case ABY:
        base = bus.read(pc) | (bus.read((pc + 1) & 0xFFFF) << 8); this.pc = (pc + 2) & 0xFFFF;
        a = (base + (mode === ABX ? this.x : this.y)) & 0xFFFF;
        if (pen && ((a ^ base) & 0xFF00)) this.cyc++;
        return a;
      case IND:
        base = bus.read(pc) | (bus.read((pc + 1) & 0xFFFF) << 8); this.pc = (pc + 2) & 0xFFFF;
        return bus.read(base) | (bus.read((base & 0xFF00) | ((base + 1) & 0xFF)) << 8);
      case IZX:
        zp = (bus.read(pc) + this.x) & 0xFF; this.pc = (pc + 1) & 0xFFFF;
        return bus.read(zp) | (bus.read((zp + 1) & 0xFF) << 8);
      case IZY:
        zp = bus.read(pc); this.pc = (pc + 1) & 0xFFFF;
        base = bus.read(zp) | (bus.read((zp + 1) & 0xFF) << 8);
        a = (base + this.y) & 0xFFFF;
        if (pen && ((a ^ base) & 0xFF00)) this.cyc++;
        return a;
    }
    return 0;
  }

  // Execute one instruction; returns cycles taken.
  step() {
    if (this.jammed) { this.cycles += 2; return 2; }
    if (this.nmiPending) { this.nmiPending = false; this.interrupt(0xFFFA); return 7; }
    if (this.irq && !this.i) { this.interrupt(0xFFFE); return 7; }
    this.start = this.cycles;
    const opcode = this.bus.read(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    const [m, mode, cyc, pen] = OPS[opcode];
    this.cyc = cyc;
    const ea = (mode === IMP || mode === ACC || mode === REL) ? 0 : this.addr(mode, pen);
    let v, t;

    switch (m) {
      case 'LDA': this.a = this.nz(this.rd(ea)); break;
      case 'LDX': this.x = this.nz(this.rd(ea)); break;
      case 'LDY': this.y = this.nz(this.rd(ea)); break;
      case 'STA': this.wr(ea, this.a); break;
      case 'STX': this.wr(ea, this.x); break;
      case 'STY': this.wr(ea, this.y); break;
      case 'ORA': this.a = this.nz(this.a | this.rd(ea)); break;
      case 'AND': this.a = this.nz(this.a & this.rd(ea)); break;
      case 'EOR': this.a = this.nz(this.a ^ this.rd(ea)); break;
      case 'ADC': this.adc(this.rd(ea)); break;
      case 'SBC': this.sbc(this.rd(ea)); break;
      case 'CMP': this.cmp(this.a, this.rd(ea)); break;
      case 'CPX': this.cmp(this.x, this.rd(ea)); break;
      case 'CPY': this.cmp(this.y, this.rd(ea)); break;
      case 'BIT':
        v = this.rd(ea);
        this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; this.z = (this.a & v) === 0 ? 1 : 0;
        break;
      case 'ASL': if (mode === ACC) this.a = this.asl(this.a); else this.wr(ea, this.asl(this.rd(ea))); break;
      case 'LSR': if (mode === ACC) this.a = this.lsr(this.a); else this.wr(ea, this.lsr(this.rd(ea))); break;
      case 'ROL': if (mode === ACC) this.a = this.rol(this.a); else this.wr(ea, this.rol(this.rd(ea))); break;
      case 'ROR': if (mode === ACC) this.a = this.ror(this.a); else this.wr(ea, this.ror(this.rd(ea))); break;
      case 'INC': this.wr(ea, this.nz((this.rd(ea) + 1) & 0xFF)); break;
      case 'DEC': this.wr(ea, this.nz((this.rd(ea) - 1) & 0xFF)); break;
      case 'INX': this.x = this.nz((this.x + 1) & 0xFF); break;
      case 'INY': this.y = this.nz((this.y + 1) & 0xFF); break;
      case 'DEX': this.x = this.nz((this.x - 1) & 0xFF); break;
      case 'DEY': this.y = this.nz((this.y - 1) & 0xFF); break;
      case 'TAX': this.x = this.nz(this.a); break;
      case 'TAY': this.y = this.nz(this.a); break;
      case 'TXA': this.a = this.nz(this.x); break;
      case 'TYA': this.a = this.nz(this.y); break;
      case 'TSX': this.x = this.nz(this.sp); break;
      case 'TXS': this.sp = this.x; break;
      case 'CLC': this.c = 0; break;
      case 'SEC': this.c = 1; break;
      case 'CLI': this.i = 0; break;
      case 'SEI': this.i = 1; break;
      case 'CLV': this.v = 0; break;
      case 'CLD': this.d = 0; break;
      case 'SED': this.d = 1; break;
      case 'NOP': if (mode !== IMP) this.rd(ea); break;
      case 'BPL': this.branch(!this.n); break;
      case 'BMI': this.branch(this.n); break;
      case 'BVC': this.branch(!this.v); break;
      case 'BVS': this.branch(this.v); break;
      case 'BCC': this.branch(!this.c); break;
      case 'BCS': this.branch(this.c); break;
      case 'BNE': this.branch(!this.z); break;
      case 'BEQ': this.branch(this.z); break;
      case 'JMP': this.pc = ea; break;
      case 'JSR':
        t = (this.pc - 1) & 0xFFFF;
        this.push(t >> 8); this.push(t & 0xFF);
        this.pc = ea;
        break;
      case 'RTS': this.pc = ((this.pull() | (this.pull() << 8)) + 1) & 0xFFFF; break;
      case 'RTI': this.setP(this.pull()); this.pc = this.pull() | (this.pull() << 8); break;
      case 'BRK':
        t = (this.pc + 1) & 0xFFFF;
        this.push(t >> 8); this.push(t & 0xFF);
        this.push(this.getP() | 0x10);
        this.i = 1;
        this.pc = this.bus.read(0xFFFE) | (this.bus.read(0xFFFF) << 8);
        break;
      case 'PHA': this.push(this.a); break;
      case 'PHP': this.push(this.getP() | 0x10); break;
      case 'PLA': this.a = this.nz(this.pull()); break;
      case 'PLP': this.setP(this.pull()); break;

      // Illegal opcodes
      case 'LAX': this.a = this.x = this.nz(mode === IMM ? (this.rd(ea) & (this.a | 0xEE)) : this.rd(ea)); break;
      case 'SAX': this.wr(ea, this.a & this.x); break;
      case 'DCP': v = (this.rd(ea) - 1) & 0xFF; this.wr(ea, v); this.cmp(this.a, v); break;
      case 'ISB': v = (this.rd(ea) + 1) & 0xFF; this.wr(ea, v); this.sbc(v); break;
      case 'SLO': v = this.asl(this.rd(ea)); this.wr(ea, v); this.a = this.nz(this.a | v); break;
      case 'RLA': v = this.rol(this.rd(ea)); this.wr(ea, v); this.a = this.nz(this.a & v); break;
      case 'SRE': v = this.lsr(this.rd(ea)); this.wr(ea, v); this.a = this.nz(this.a ^ v); break;
      case 'RRA': v = this.ror(this.rd(ea)); this.wr(ea, v); this.adc(v); break;
      case 'ANC': this.a = this.nz(this.a & this.rd(ea)); this.c = this.n; break;
      case 'ALR': this.a = this.lsr(this.a & this.rd(ea)); break;
      case 'ARR':
        this.a = this.ror(this.a & this.rd(ea));
        this.c = (this.a >> 6) & 1;
        this.v = ((this.a >> 6) ^ (this.a >> 5)) & 1;
        break;
      case 'SBX':
        v = (this.a & this.x) - this.rd(ea);
        this.c = v >= 0 ? 1 : 0;
        this.x = this.nz(v & 0xFF);
        break;
      case 'ANE': this.a = this.nz((this.a | 0xEE) & this.x & this.rd(ea)); break;
      case 'SHA': this.wr(ea, this.a & this.x & (((ea >> 8) + 1) & 0xFF)); break;
      case 'SHX': this.wr(ea, this.x & (((ea >> 8) + 1) & 0xFF)); break;
      case 'SHY': this.wr(ea, this.y & (((ea >> 8) + 1) & 0xFF)); break;
      case 'TAS': this.sp = this.a & this.x; this.wr(ea, this.sp & (((ea >> 8) + 1) & 0xFF)); break;
      case 'LAS': this.a = this.x = this.sp = this.nz(this.rd(ea) & this.sp); break;
      case 'JAM': this.jammed = true; this.pc = (this.pc - 1) & 0xFFFF; break;
    }

    this.cycles += this.cyc;
    return this.cyc;
  }
}

export const OPCODE_TABLE = OPS;
export const ADDR_MODE_LEN = MODE_LEN;
