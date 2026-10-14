// ARM2 (26-bit address bus), as used by Data East's ARM boards (Captain
// America and the Avengers). R15 holds the program counter in bits 2-25
// together with the flags (N Z C V in 31-28), the interrupt masks (I 27,
// F 26) and the mode (bits 1-0: user, FIQ, IRQ, supervisor); FIQ, IRQ and
// supervisor modes bank R13-R14 (FIQ also R8-R12). Instructions: data
// processing with the barrel shifter, MUL/MLA, single and block loads and
// stores, branches and SWI; no coprocessors.
//
// The edge cases follow MAME's ARM core, which these games are known to run
// on: R15 read as an operand is the instruction's address + 8, a register-
// specified shift uses the low five bits of Rs, and an unaligned word load
// rotates the word. IRQ and FIQ are requests the core clears when it takes
// them (the board raises them; HOLD_LINE).
//
// The host supplies read32/read8/write32/write8 (little-endian bus).

import { capture, apply } from './state.js';

const ADDR = 0x03FFFFFC, PSR = 0xF0000000, IRQS = 0x0C000000, MODE = 3;
const N = 0x80000000, Z = 0x40000000, C = 0x20000000, V = 0x10000000, I = 0x08000000, F = 0x04000000;
const S_CYC = 1, N_CYC = 2, I_CYC = 1;
// Register banks: which physical register each mode sees for R0-R15.
const BANK = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 15],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23, 24, 15],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 25, 26, 15],
];
const STATE = ['regs', 'irq', 'fiq', 'cycles'];
const u = (v) => v >>> 0;

export class ARM2 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor(bus) {
    this.bus = bus;
    this.regs = new Uint32Array(27);
    this.cycles = 0;
    this.reset();
  }

  reset() {
    this.regs.fill(0);
    this.regs[15] = 3 | I | F;                     // supervisor mode, interrupts masked, PC 0
    this.irq = 0; this.fiq = 0;
  }

  get r15() { return this.regs[15]; }
  set r15(v) { this.regs[15] = v; }
  get(n) { return this.regs[BANK[this.regs[15] & MODE][n]]; }
  set(n, v) { this.regs[BANK[this.regs[15] & MODE][n]] = v; }

  read32(a) {
    const w = this.bus.read32(a & ADDR);
    const r = a & 3;
    return r ? u((w >>> (8 * r)) | (w << (32 - 8 * r))) : w;   // unaligned: rotated
  }

  run(n) {
    const end = this.cycles + n;
    while (this.cycles < end) this.step();
    return this.cycles - (end - n);
  }

  step() {
    const pc = this.regs[15];
    const insn = this.bus.read32(pc & ADDR);
    if (!this.cond(insn >>> 28, pc)) { this.cycles += S_CYC; this.regs[15] = u(pc + 4); this.checkIrq(); return; }
    if ((insn & 0x0FC000F0) === 0x00000090) { this.mul(insn); this.regs[15] = u(this.regs[15] + 4); }
    else if (!(insn & 0x0C000000)) this.alu(insn);
    else if ((insn & 0x0C000000) === 0x04000000) { this.single(insn); this.regs[15] = u(this.regs[15] + 4); }
    else if ((insn & 0x0E000000) === 0x08000000) { this.block(insn); this.regs[15] = u(this.regs[15] + 4); }
    else if ((insn & 0x0E000000) === 0x0A000000) this.branch(insn);
    else if ((insn & 0x0F000000) === 0x0F000000) {           // SWI
      const ret = u(this.regs[15] + 4);
      this.regs[15] = 3;
      this.set(14, ret);
      this.regs[15] = u((ret & PSR) | (ret & IRQS) | 0x08 | 3 | I);
      this.cycles += 2 * S_CYC + N_CYC;
    } else { this.cycles += S_CYC; this.regs[15] = u(this.regs[15] + 4); }   // coprocessor / undefined: skipped
    this.checkIrq();
  }

  cond(c, f) {
    const n = !!(f & N), z = !!(f & Z), cy = !!(f & C), v = !!(f & V);
    switch (c) {
      case 0: return z; case 1: return !z; case 2: return cy; case 3: return !cy;
      case 4: return n; case 5: return !n; case 6: return v; case 7: return !v;
      case 8: return cy && !z; case 9: return !cy || z; case 10: return n === v; case 11: return n !== v;
      case 12: return !z && n === v; case 13: return z || n !== v; case 14: return true;
    }
    return false;
  }

  checkIrq() {
    const pc = u(this.regs[15] + 4);
    if (this.fiq && !(pc & F)) {
      this.regs[15] = 1; this.set(14, pc);
      this.regs[15] = u((pc & PSR) | (pc & IRQS) | 0x1C | 1 | I | F);
      this.fiq = 0;
      return;
    }
    if (this.irq && !(pc & I)) {
      this.regs[15] = 2; this.set(14, pc);
      this.regs[15] = u((pc & PSR) | (pc & IRQS) | 0x18 | 2 | I | (pc & F));
      this.irq = 0;
    }
  }

  branch(insn) {
    if (insn & 0x01000000) this.set(14, u(this.regs[15] + 4));
    let off = (insn & 0x00FFFFFF) << 2;
    if (off & 0x02000000) off -= 0x04000000;
    this.regs[15] = u(this.regs[15] + off + 8);
    this.cycles += 2 * S_CYC + N_CYC;
  }

  // The shifted-register second operand; sets this.sc (shifter carry, 0 or not) when wanted.
  shift(insn, wantCarry) {
    let k = (insn >>> 7) & 31;
    let rm = this.get(insn & 15);
    const t = (insn >>> 4) & 7;                 // bit 0: shift by register; bits 1-2: type
    if ((insn & 15) === 15) rm = u(rm + 8);
    const cf = this.regs[15] & C;
    if (t & 1) {
      k = this.get((insn >>> 8) & 15) & 0x1F;
      this.cycles += S_CYC;
      if (!k) { if (wantCarry) this.sc = cf; return rm; }
    }
    switch (t >> 1) {
      case 0:
        if (wantCarry) this.sc = k ? rm & (1 << (32 - k)) : cf;
        return k ? u(rm << k) : rm;
      case 1:
        if (k === 0 || k === 32) { if (wantCarry) this.sc = rm & N; return 0; }
        if (wantCarry) this.sc = rm & (1 << (k - 1));
        return rm >>> k;
      case 2:
        if (k === 0 || k > 32) k = 32;
        if (wantCarry) this.sc = rm & (2 ** (k - 1));
        if (k >= 32) return rm & N ? 0xFFFFFFFF : 0;
        return u((rm | 0) >> k);
      default:
        if (k) {
          if (wantCarry) this.sc = rm & N;
          return u((rm >>> k) | (rm << (32 - k)));
        }
        if (wantCarry) this.sc = rm & 1;
        return u((rm >>> 1) | (cf << 2));
    }
  }

  alu(insn) {
    const op = (insn >>> 21) & 15, s = insn & 0x00100000;
    this.cycles += S_CYC;
    let op2;
    this.sc = 0;
    if (insn & 0x02000000) {
      const by = (insn >>> 8) & 15, imm = insn & 0xFF;
      if (by) { op2 = u((imm >>> (2 * by)) | (imm << (32 - 2 * by))); this.sc = op2 & N; }
      else { op2 = imm; this.sc = this.regs[15] & C; }
    } else {
      op2 = this.shift(insn, !!s);
      if (!s) this.sc = 0;
    }
    let rn = 0;
    if ((op & 0xD) !== 0xD) {
      const n = (insn >>> 16) & 15;
      rn = n === 15 ? u(u(this.regs[15] + 8) & ADDR) : this.get(n);
    }
    let rd = 0, kind;                               // kind: 0 logical, 1 add, 2 sub
    const cin = this.regs[15] & C ? 1 : 0;
    switch (op) {
      case 0: case 8: rd = rn & op2; kind = 0; break;                    // AND, TST
      case 1: case 9: rd = rn ^ op2; kind = 0; break;                    // EOR, TEQ
      case 2: case 10: rd = u(rn - op2); kind = 2; break;               // SUB, CMP
      case 3: rd = u(op2 - rn); kind = 3; break;                        // RSB
      case 4: case 11: rd = u(rn + op2); kind = 1; break;               // ADD, CMN
      case 5: rd = u(rn + op2 + cin); kind = 1; break;                  // ADC
      case 6: rd = u(rn - op2 - (1 - cin)); kind = 2; break;            // SBC
      case 7: rd = u(op2 - rn - (1 - cin)); kind = 3; break;            // RSC
      case 12: rd = rn | op2; kind = 0; break;                           // ORR
      case 13: rd = op2; kind = 0; break;                                // MOV
      case 14: rd = rn & ~op2; kind = 0; break;                          // BIC
      case 15: rd = ~op2; kind = 0; break;                               // MVN
    }
    rd = u(rd);
    let r15 = this.regs[15];
    if (s) {
      let f = (rd & N) | (rd ? 0 : Z);
      if (kind === 0) f |= (this.sc ? C : 0) | (r15 & V);
      else {
        const a = kind === 3 ? op2 : rn, b = kind === 3 ? rn : op2;
        if (kind === 1) {
          f |= ((~(a ^ b) & (a ^ rd)) & N ? V : 0) | (u(~a) < b ? C : 0);
        } else {
          f |= (((a ^ b) & (a ^ rd)) & N ? V : 0);
          const an = a >>> 31, bn = b >>> 31, dn = rd >>> 31;
          if ((an & (1 - bn)) | (an & (1 - dn)) | ((1 - bn) & (1 - dn))) f |= C;
        }
      }
      r15 = u((r15 & ~(N | Z | C | V)) | f);
    }
    this.regs[15] = u(r15 + 4);
    const dn = (insn >>> 12) & 15;
    if ((op & 0xC) !== 0x8) {
      if (dn === 15) {
        this.cycles += S_CYC + N_CYC;
        const cur = this.regs[15];
        if (!s) this.regs[15] = u((rd & ADDR) | (cur & PSR) | (cur & IRQS) | (cur & MODE));
        else if (cur & MODE) this.regs[15] = rd;
        else this.regs[15] = u((rd & ADDR) | (rd & PSR) | (cur & IRQS) | (cur & MODE));
      } else this.set(dn, rd);
    } else if (dn === 15 && s) {                    // TSTP/TEQP etc.: set the PSR
      this.cycles += S_CYC + N_CYC;
      if (insn === 0xE33FF003) rd = u(rd - 4);
      const cur = this.regs[15];
      if (cur & MODE) this.regs[15] = rd;
      else this.regs[15] = u((rd & ADDR) | (rd & PSR) | (cur & IRQS) | (cur & MODE));
    }
  }

  mul(insn) {
    this.cycles += S_CYC + I_CYC;
    let r = Math.imul(this.get(insn & 15), this.get((insn >>> 8) & 15));
    if (insn & 0x00200000) r += this.get((insn >>> 12) & 15);
    r = u(r);
    this.set((insn >>> 16) & 15, r);
    if (insn & 0x00100000) this.regs[15] = u((this.regs[15] & ~(N | Z)) | (r & N) | (r ? 0 : Z));
  }

  single(insn) {
    const off = insn & 0x02000000 ? this.shift(insn, false) : insn & 0xFFF;
    const rn = (insn >>> 16) & 15, rd = (insn >>> 12) & 15;
    const up = insn & 0x00800000, pre = insn & 0x01000000, wb = insn & 0x00200000;
    let addr;
    if (pre) {
      addr = u(up ? this.get(rn) + off : this.get(rn) - off);
      if (wb) this.set(rn, addr);
      else if (rn === 15) addr = u((addr & ADDR) + 8);
    } else addr = rn === 15 ? u((this.regs[15] & ADDR) + 8) : this.get(rn);
    if (insn & 0x00100000) {                      // load
      this.cycles += S_CYC + I_CYC + N_CYC;
      if (insn & 0x00400000) this.set(rd, this.bus.read8(addr & 0x03FFFFFF));
      else if (rd === 15) {
        const v = this.read32(addr), cur = this.regs[15];
        this.regs[15] = u((v & ADDR) | (cur & PSR) | (cur & MODE));
        if (!(v & 3)) this.regs[15] = u(this.regs[15] - 4);
        this.cycles += S_CYC + N_CYC;
      } else this.set(rd, this.read32(addr));
    } else {                                       // store
      this.cycles += 2 * N_CYC;
      if (insn & 0x00400000) this.bus.write8(addr & 0x03FFFFFF, this.get(rd) & 0xFF);
      else this.bus.write32(addr & ADDR, rd === 15 ? u(this.regs[15] + 8) : this.get(rd));
    }
    if (!pre && rd !== rn) this.set(rn, u(up ? addr + off : addr - off));   // post-indexed: always written back
  }

  block(insn) {
    const rb = (insn >>> 16) & 15, list = insn & 0xFFFF, sbit = insn & 0x00400000;
    const up = insn & 0x00800000, pre = insn & 0x01000000, wb = insn & 0x00200000;
    let base = this.get(rb), count = 0;
    if (insn & 0x00100000) {                      // load
      if (up) {
        if (!pre) base = u(base - 4);
        for (let i = 0; i < 16; i++) {
          if (!((list >> i) & 1)) continue;
          base = u(base + 4);
          const v = this.bus.read32(base & ADDR);
          if (i === 15) { const cur = this.regs[15]; this.regs[15] = sbit ? v : u((cur & PSR) | (cur & IRQS) | (cur & MODE) | (v & ADDR)); }
          else this.set(i, v);
          count++;
        }
        if (list & 0x8000) { this.regs[15] = u(this.regs[15] - 4); this.cycles += S_CYC + N_CYC; }
        if (wb && !((list >> rb) & 1)) this.set(rb, u(this.get(rb) + count * 4));
      } else {
        if (!pre) base = u(base + 4);
        let deferred = null;
        for (let i = 15; i >= 0; i--) {
          if (!((list >> i) & 1)) continue;
          base = u(base - 4);
          const v = this.bus.read32(base & ADDR);
          if (i === 15) { const cur = this.regs[15]; deferred = sbit ? v : u((cur & PSR) | (cur & IRQS) | (cur & MODE) | (v & ADDR)); }
          else this.set(i, v);
          count++;
        }
        if (wb) this.set(rb, u(this.get(rb) - count * 4));
        if (deferred !== null) this.regs[15] = deferred;
        if (list & 0x8000) { this.cycles += S_CYC + N_CYC; this.regs[15] = u(this.regs[15] - 4); }
      }
      this.cycles += count * S_CYC + N_CYC + I_CYC;
    } else {                                       // store
      if (list & 0x8000) this.regs[15] = u(this.regs[15] + 12);
      if (up) {
        if (!pre) base = u(base - 4);
        for (let i = 0; i < 16; i++) if ((list >> i) & 1) { base = u(base + 4); this.bus.write32(base & ADDR, this.get(i)); count++; }
        if (wb) this.set(rb, u(this.get(rb) + count * 4));
      } else {
        if (!pre) base = u(base + 4);
        for (let i = 15; i >= 0; i--) if ((list >> i) & 1) { base = u(base - 4); this.bus.write32(base & ADDR, this.get(i)); count++; }
        if (wb) this.set(rb, u(this.get(rb) - count * 4));
      }
      if (list & 0x8000) this.regs[15] = u(this.regs[15] - 12);
      this.cycles += (count - 1) * S_CYC + 2 * N_CYC;
    }
  }
}
