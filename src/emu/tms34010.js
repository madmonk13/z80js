// Texas Instruments TMS34010 graphics processor (Midway Y-unit and others).
// A 32-bit CPU whose addresses count bits, not bytes: memory is 16-bit words
// (word address = bit address >> 4), and moves transfer "fields" of 1-32 bits
// at any bit position, with two programmable field sizes (F0, F1). Thirty
// registers in two files (A0-A14, B0-B14) plus a shared stack pointer; the B
// file doubles as the graphics registers (pitches, window, colors). Some
// instructions treat a register as an X,Y pair (Y in the high half).
//
// The host supplies read16(wordAddr) and write16(wordAddr, value, mask) for
// the bus (mask = the bits being written), and optionally toShiftReg /
// fromShiftReg for screen-refresh transfers. The I/O registers at
// C0000000-C00001FF are inside the chip, including the video timing; the
// host drives the display with scanline(), which raises the display
// interrupt and steps the display address the way the chip does.
//
// Instruction semantics follow the TMS34010 user's guide; timing is in
// machine cycles (the input clock / 8).

import { capture, apply } from './state.js';

const N = 0x80000000, C = 0x40000000, Z = 0x20000000, V = 0x10000000, IE = 0x00200000;
// I/O registers
const HEBLNK = 1, HSBLNK = 2, HTOTAL = 3, VEBLNK = 5, VSBLNK = 6, VTOTAL = 7, DPYCTL = 8, DPYSTRT = 9, DPYINT = 10,
  CONTROL = 11, HSTCTLL = 15, HSTCTLH = 16, INTENB = 17, INTPEND = 18, CONVSP = 19, CONVDP = 20, PSIZE = 21,
  DPYTAP = 27, HCOUNT = 28, VCOUNT = 29, DPYADR = 30, REFCNT = 31;
export const INT1 = 0x0002, INT2 = 0x0004, HI = 0x0200, DI = 0x0400, WV = 0x0800;

const STATE = ['r', 'pc', 'st', 'io', 'cycles', 'convsp', 'convdp', 'pixelshift', 'shiftreg'];

const s16 = (v) => (v << 16) >> 16;
const fieldSize = (f) => f || 32;

export class TMS34010 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  constructor({ read16, write16, toShiftReg = () => {}, fromShiftReg = () => {} }) {
    this.read16 = read16;
    this.write16 = write16;
    this.toShiftReg = toShiftReg;
    this.fromShiftReg = fromShiftReg;
    // A0-A14 are r[0..14], SP is r[15], B0-B14 are r[30..16] (B n = r[30 - n]).
    this.r = new Int32Array(31);
    this.io = new Uint16Array(32);
    this.shiftreg = new Uint16Array(1024);
    this.cycles = 0;
    this.nextEvent = Infinity;               // the host's event (onEvent) is called when cycles pass this
    this.onEvent = () => {};
    this.reset();
  }

  reset() {
    this.r.fill(0); this.io.fill(0);
    this.st = 0x10;
    this.convsp = this.convdp = 0; this.pixelshift = 0;
    this.pc = (this.rlong(0xFFFFFFE0) & ~15) >>> 0;
  }

  // ---------------------------------------------------------------- memory

  rword(wa) {
    wa >>>= 0;
    if ((wa & 0xFFFFFFE0) === 0x0C000000) return this.ioRead(wa & 31);
    return this.read16(wa) & 0xFFFF;
  }
  wword(wa, v, mask) {
    wa >>>= 0;
    if ((wa & 0xFFFFFFE0) === 0x0C000000) {
      const r = wa & 31;
      this.ioWrite(r, (this.io[r] & ~mask) | (v & mask));
      return;
    }
    this.write16(wa, v & 0xFFFF, mask);
  }

  // Read a field of `w` bits (1-32) at bit address `a`, sign-extended if `sx`.
  rfield(a, w, sx) {
    a >>>= 0;
    const shift = a & 15, wa = a >>> 4;
    let v;
    if (shift + w <= 16) v = (this.rword(wa) >>> shift) & ((1 << w) - 1);
    else {
      const lo = (this.rword(wa) | (this.rword(wa + 1) << 16)) >>> 0;
      v = lo >>> shift;
      if (shift + w > 32) v |= this.rword(wa + 2) << (32 - shift);
      if (w < 32) v &= (w === 31 ? 0x7FFFFFFF : (1 << w) - 1);
    }
    if (sx && w < 32) v = (v << (32 - w)) >> (32 - w);
    return v | 0;
  }

  // Write the low `w` bits of `v` at bit address `a`.
  wfield(a, w, v) {
    a >>>= 0;
    let shift = a & 15, wa = a >>> 4, left = w, data = w === 32 ? v >>> 0 : (v & ((2 ** w) - 1)) >>> 0;
    while (left > 0) {
      const n = Math.min(16 - shift, left);
      const mask = ((1 << n) - 1) << shift;
      this.wword(wa, (data << shift) & 0xFFFF, mask);
      data = n >= 32 ? 0 : Math.floor(data / (1 << n));
      left -= n; shift = 0; wa++;
    }
  }

  rlong(a) { return this.rfield(a, 32, false); }
  wlong(a, v) { this.wfield(a, 32, v); }
  push(v) { this.r[15] -= 0x20; this.wlong(this.r[15], v); }
  pop() { const v = this.rlong(this.r[15]); this.r[15] += 0x20; return v; }

  fetch() { const v = this.rword(this.pc >>> 4); this.pc = (this.pc + 16) >>> 0; return v; }
  paramWord() { return s16(this.fetch()); }
  paramLong() { const lo = this.fetch(); return lo | (this.fetch() << 16); }

  // Field size and sign-extend bit for field 0 or 1.
  fs(f) { return fieldSize((this.st >> (f ? 6 : 0)) & 31); }
  fe(f) { return (this.st >> (f ? 11 : 5)) & 1; }
  rf(f, a) { return this.rfield(a, this.fs(f), this.fe(f)); }
  wf(f, a, v) { this.wfield(a, this.fs(f), v); }

  // ---------------------------------------------------------------- I/O registers

  ioRead(r) {
    switch (r) {
      case HCOUNT: return 0;
      case REFCNT: return (this.cycles / 16) & 0xFFFC;
    }
    return this.io[r];
  }

  ioWrite(r, v) {
    const old = this.io[r];
    this.io[r] = v;
    switch (r) {
      case PSIZE: this.pixelshift = [1, 2, 4, 8, 16].indexOf(v); if (this.pixelshift < 0) this.pixelshift = 0; break;
      case CONVSP: this.convsp = 2 ** (~v & 31); break;
      case CONVDP: this.convdp = 2 ** (~v & 31); break;
      case INTENB: this.checkInterrupts(); break;
      case INTPEND:                                  // only WV and DI can be cleared (by writing 0s)
        this.io[r] = old;
        if (!(v & WV)) this.io[r] &= ~WV;
        if (!(v & DI)) this.io[r] &= ~DI;
        break;
      case HSTCTLL: {
        let n = (old & 0xFF8F) | (v & 0x0070);
        n |= v & 0x0080;
        n &= v | ~0x0008;
        this.io[r] = n;
        if ((old & 0x0008) && !(n & 0x0008)) this.io[INTPEND] &= ~HI;
        break;
      }
      case HSTCTLH:
        if (v & 0x0100) { this.io[r] &= ~0x0100; this.nmi(); }
        break;
    }
  }

  // External interrupt lines (INT1, INT2) from the host.
  setLine(bit, on) {
    if (on) this.io[INTPEND] |= bit; else this.io[INTPEND] &= ~bit;
    if (on) this.checkInterrupts();
  }
  // Internal interrupts (display) are latched.
  raise(bit) { this.io[INTPEND] |= bit; this.checkInterrupts(); }

  nmi() {
    if (!(this.io[HSTCTLH] & 0x0200)) { this.push(this.pc); this.push(this.st); }
    this.st = 0x10;
    this.pc = (this.rlong(0xFFFFFEE0) & ~15) >>> 0;
    this.cycles += 16;
  }

  checkInterrupts() {
    const irq = this.io[INTPEND] & this.io[INTENB];
    if (!(this.st & IE) || !irq) return;
    let vector;
    if (irq & HI) vector = 0xFFFFFEC0;
    else if (irq & DI) vector = 0xFFFFFEA0;
    else if (irq & WV) vector = 0xFFFFFE80;
    else if (irq & INT1) vector = 0xFFFFFFC0;
    else if (irq & INT2) vector = 0xFFFFFFA0;
    else return;
    this.push(this.pc); this.push(this.st);
    this.st = 0x10;
    this.pc = (this.rlong(vector) & ~15) >>> 0;
    this.cycles += 16;
  }

  setSt(v) { this.st = v >>> 0; this.checkInterrupts(); }

  // ---------------------------------------------------------------- video timing

  get vtotal() { return this.io[VTOTAL]; }

  // Called by the host for each scanline (vcount). Returns the display
  // parameters for that line when it's in the visible area, else null.
  scanline(vcount) {
    const io = this.io;
    io[VCOUNT] = vcount;
    if ((io[DPYCTL] & 0x8000) && vcount === io[DPYINT]) this.raise(DI);
    if (vcount === io[VSBLNK]) io[DPYADR] = io[DPYSTRT];
    let params = null;
    if (vcount >= io[VEBLNK] && vcount < io[VSBLNK]) {
      let dpyadr = io[DPYADR];
      if (!(io[DPYCTL] & 0x0400)) dpyadr ^= 0xFFFC;
      params = { enabled: !!(io[DPYCTL] & 0x8000), rowaddr: dpyadr >> 4, coladdr: ((dpyadr & 0x7C) << 4) | (io[DPYTAP] & 0x3FFF),
        heblnk: io[HEBLNK] * 2, hsblnk: io[HSBLNK] * 2, veblnk: io[VEBLNK], vsblnk: io[VSBLNK] };
      let a = io[DPYADR];
      if ((a & 3) === 0) a = ((a & 0xFFFC) - (io[DPYCTL] & 0x03FC)) | (io[DPYSTRT] & 3);
      else a = (a & 0xFFFC) | ((a - 1) & 3);
      io[DPYADR] = a & 0xFFFF;
    }
    return params;
  }

  // ---------------------------------------------------------------- pixels

  get windowChecking() { return (this.io[CONTROL] >> 6) & 3; }

  pixelRead(a) {
    a >>>= 0;
    if (this.io[DPYCTL] & 0x0800) { this.toShiftReg(a, this.shiftreg); return this.shiftreg[0]; }
    const size = 1 << this.pixelshift, word = this.rword(a >>> 4);
    if (size === 16) return word;
    return (word >> (a & (16 - size))) & ((1 << size) - 1);
  }

  pixelWrite(a, data) {
    a >>>= 0;
    if (this.io[DPYCTL] & 0x0800) { this.fromShiftReg(a, this.shiftreg); return; }
    const size = 1 << this.pixelshift, m = size === 16 ? 0xFFFF : (1 << size) - 1;
    const shift = a & (16 - size) & 15, wa = a >>> 4, rop = (this.io[CONTROL] >> 10) & 31, trans = this.io[CONTROL] & 0x20;
    data &= m;
    if (rop) {
      const old = (this.rword(wa) >> shift) & m;
      data = this.rasterOp(rop, data, old, m) & m;
    }
    if (trans && !data) return;
    this.wword(wa, data << shift, m << shift);
  }

  rasterOp(op, n, o, m) {
    switch (op) {
      case 1: return n & o; case 2: return n & ~o; case 3: return 0; case 4: return n | ~o;
      case 5: return ~(n ^ o); case 6: return ~o; case 7: return ~(n | o); case 8: return n | o;
      case 9: return o; case 10: return n ^ o; case 11: return ~n & o; case 12: return 0xFFFF;
      case 13: return ~n | o; case 14: return ~(n & o); case 15: return ~n; case 16: return n + o;
      case 17: return Math.min(n + o, m); case 18: return o - n; case 19: return o > n ? o - n : 0;
      case 20: return Math.max(o, n); case 21: return Math.min(o, n);
    }
    return n;
  }

  // X,Y to linear: y * pitch + (x << pixel size) + OFFSET (B4).
  dxytol(xy) { return (s16(xy >> 16) * this.convdp + (s16(xy) << this.pixelshift) + this.r[26]) | 0; }
  sxytol(xy) { return (s16(xy >> 16) * this.convsp + (s16(xy) << this.pixelshift) + this.r[26]) | 0; }

  // Window check for XY pixel writes: returns true to skip the write.
  windowSkip(xy) {
    const w = this.windowChecking;
    if (!w) return false;
    this.st &= ~V;
    const x = s16(xy), y = xy >> 16, ws = this.r[25], we = this.r[24];
    if (x < s16(ws) || x > s16(we) || y < (ws >> 16) || y > (we >> 16)) { this.st |= V; return true; }
    return w === 1;
  }

  // ---------------------------------------------------------------- flags

  nz(v) { this.st = (this.st & ~(N | Z)) | (v < 0 ? N : 0) | (v === 0 ? Z : 0); }
  addFlags(a, b, r) {
    let s = this.st & ~(N | C | Z | V);
    if (r < 0) s |= N; if (r === 0) s |= Z;
    if ((~(a ^ b) & (a ^ r)) < 0) s |= V;
    if ((~a >>> 0) < (b >>> 0)) s |= C;
    this.st = s >>> 0;
  }
  subFlags(a, b, r) {
    let s = this.st & ~(N | C | Z | V);
    if (r < 0) s |= N; if (r === 0) s |= Z;
    if (((a ^ b) & (a ^ r)) < 0) s |= V;
    if ((b >>> 0) > (a >>> 0)) s |= C;
    this.st = s >>> 0;
  }
  cond(cc) {
    const s = this.st, n = !!(s & N), c = !!(s & C), z = !!(s & Z), v = !!(s & V);
    switch (cc) {
      case 0: return true; case 1: return !n && !z; case 2: return c || z; case 3: return !c && !z;
      case 4: return n !== v; case 5: return n === v; case 6: return n !== v || z; case 7: return n === v && !z;
      case 8: return c; case 9: return !c; case 10: return z; case 11: return !z;
      case 12: return v; case 13: return !v; case 14: return n; default: return !n;
    }
  }

  // ---------------------------------------------------------------- run

  run(n) {
    if (this.io[HSTCTLH] & 0x8000) { this.cycles += n; return; }
    const end = this.cycles + n;
    this.checkInterrupts();
    while (this.cycles < end) {
      if (this.cycles >= this.nextEvent) this.onEvent();
      this.step();
    }
  }

  unimpl() {
    this.push(this.pc); this.push(this.st);
    this.st = 0x10;
    this.pc = (this.rlong(0xFFFFFC20) & ~15) >>> 0;
    this.cycles += 16;
  }

  step() {
    const op = this.fetch();
    const r = this.r, B = op & 0x10, rd = B ? 30 - (op & 15) : op & 15, rs = B ? 30 - ((op >> 5) & 15) : (op >> 5) & 15;
    const k = (op >> 5) & 31;
    this.cycles += 1;
    switch (op >> 12) {
      case 0x0: this.op0(op, rd, rs); return;
      case 0x1:
        switch ((op >> 10) & 3) {
          case 0: { const a = k || 32, b = r[rd], v = (a + b) | 0; r[rd] = v; this.addFlags(a, b, v); return; }   // ADDK
          case 1: { const t = k || 32, d = r[rd], v = (d - t) | 0; r[rd] = v; this.subFlags(d, t, v); return; }  // SUBK
          case 2: r[rd] = k || 32; return;                                                                         // MOVK
          default: { const bit = 31 - k; this.st = (this.st & ~Z) | (((r[rd] >>> bit) & 1) ? 0 : Z); return; }     // BTST k
        }
      case 0x2: case 0x3: {
        const sel = (op >> 10) & 7;
        if (sel === 0) this.sla(rd, k);
        else if (sel === 1) this.sll(rd, k);
        else if (sel === 2) this.sra(rd, k);
        else if (sel === 3) this.srl(rd, k);
        else if (sel === 4) this.rl(rd, k);
        else if (sel === 5) this.unimpl();                                                                        // CMPK (34020)
        else {                                                                                                    // DSJS
          const v = (r[rd] - 1) | 0; r[rd] = v;
          if (v) { this.pc = (op & 0x0400 ? this.pc - (k << 4) : this.pc + (k << 4)) >>> 0; this.cycles += 1; } else this.cycles += 2;
        }
        return;
      }
      case 0x4: case 0x5: case 0x6: case 0x7: this.alu(op, rd, rs); return;
      case 0x8: case 0x9: case 0xA: case 0xB: case 0xD: this.moves(op, rd, rs); return;
      case 0xC: {                                                                                                // JRcc / JAcc
        const take = this.cond((op >> 8) & 15), lo = op & 0xFF;
        if (lo === 0) {
          if (take) { this.pc = (this.pc + (s16(this.rword(this.pc >>> 4)) << 4) + 16) >>> 0; this.cycles += 2; } else { this.pc = (this.pc + 16) >>> 0; this.cycles += 1; }
        } else if (lo === 0x80) {
          if (take) { const t = this.paramLong(); this.pc = (t & ~15) >>> 0; this.cycles += 2; } else { this.pc = (this.pc + 32) >>> 0; this.cycles += 3; }
        } else if (take) { this.pc = (this.pc + (((lo << 24) >> 24) << 4)) >>> 0; this.cycles += 1; }
        return;
      }
      case 0xE: this.xyOps(op, rd, rs); return;
      default: this.pixOps(op, rd, rs);
    }
  }

  // ---------------------------------------------------------------- shifts

  sla(rd, k) {
    const r = this.r; let res = r[rd] >>> 0;
    let s = this.st & ~(N | C | Z | V);
    if (k) {
      const mask = ((0xFFFFFFFF << (31 - k)) & 0x7FFFFFFF) >>> 0;
      const res2 = (res & 0x80000000) ? (res ^ mask) >>> 0 : res;
      if ((res2 & mask) >>> 0) s |= V;
      if ((res >>> (32 - k)) & 1) s |= C;
      res = (res << k) >>> 0;
      r[rd] = res;
    }
    res |= 0;
    if (res < 0) s |= N; if (res === 0) s |= Z;
    this.st = s >>> 0; this.cycles += 2;
  }
  sll(rd, k) {
    const r = this.r; let res = r[rd] >>> 0, s = this.st & ~(C | Z);
    if (k) { if ((res >>> (32 - k)) & 1) s |= C; res = (res << k) >>> 0; r[rd] = res; }
    if (!res) s |= Z;
    this.st = s >>> 0;
  }
  sra(rd, kk) {
    const r = this.r, k = (-kk) & 31; let res = r[rd], s = this.st & ~(N | C | Z);
    if (k) { if ((res >> (k - 1)) & 1) s |= C; res >>= k; r[rd] = res; }
    if (res < 0) s |= N; if (res === 0) s |= Z;
    this.st = s >>> 0;
  }
  srl(rd, kk) {
    const r = this.r, k = (-kk) & 31; let res = r[rd] >>> 0, s = this.st & ~(C | Z);
    if (k) { if ((res >>> (k - 1)) & 1) s |= C; res >>>= k; r[rd] = res; }
    if (!res) s |= Z;
    this.st = s >>> 0;
  }
  rl(rd, k) {
    const r = this.r; let res = r[rd] >>> 0, s = this.st & ~(C | Z);
    if (k) { if ((res >>> (32 - k)) & 1) s |= C; res = ((res << k) | (res >>> (32 - k))) >>> 0; r[rd] = res; }
    if (!res) s |= Z;
    this.st = s >>> 0;
  }

  // ---------------------------------------------------------------- 0000-0FFF

  op0(op, rd, rs) {
    const r = this.r, sub = op >> 4;
    switch (sub & 0xFE) {
      case 0x002: r[rd] = 8; return;                                                       // REV
      case 0x010: this.cycles += 5; return;                                                // EMU
      case 0x012: { const t = r[rd]; r[rd] = this.pc; this.pc = (t & ~15) >>> 0; this.cycles += 1; return; }   // EXGPC
      case 0x014: r[rd] = this.pc; return;                                                 // GETPC
      case 0x016: this.pc = (r[rd] & ~15) >>> 0; this.cycles += 1; return;                 // JUMP
      case 0x018: r[rd] = this.st; return;                                                 // GETST
      case 0x01A: this.setSt(r[rd]); this.cycles += 2; return;                             // PUTST
      case 0x01C: this.setSt(this.pop()); this.cycles += 7; return;                        // POPST
      case 0x01E: this.push(this.st); this.cycles += 1; return;                            // PUSHST
      case 0x030: if (sub === 0x030) return; break;                                        // NOP
      case 0x032: if (sub === 0x032) { this.st &= ~C; return; } break;                     // CLRC
      case 0x034: if (sub === 0x034) { const src = this.paramLong(); this.wfield(this.paramLong(), 8, this.rfield(src, 8, false)); this.cycles += 5; return; } break;   // MOVB @,@
      case 0x036: if (sub === 0x036) { this.st &= ~IE; this.cycles += 2; return; } break;  // DINT
      case 0x038: { const v = (0 - r[rd]) | 0; this.st &= ~(N | Z | V); if (v > 0) r[rd] = v; this.nz(v); if (v === -0x80000000) this.st |= V; return; }   // ABS
      case 0x03A: { const d = r[rd], v = (0 - d) | 0; this.subFlags(0, d, v); r[rd] = v; return; }   // NEG
      case 0x03C: { const t = (r[rd] + (this.st & C ? 1 : 0)) | 0, v = (0 - t) | 0; this.subFlags(0, t, v); r[rd] = v; return; }   // NEGB
      case 0x03E: { const v = ~r[rd]; r[rd] = v; this.st = (this.st & ~Z) | (v ? 0 : Z); return; }   // NOT
      case 0x050: case 0x070: {                                                            // SEXT
        const w = this.fs(sub >= 0x070 ? 1 : 0); let v = r[rd];
        if (w < 32) v = (v << (32 - w)) >> (32 - w);
        r[rd] = v; this.st &= ~(N | Z); this.nz(v); this.cycles += 2; return;
      }
      case 0x052: case 0x072: {                                                            // ZEXT
        const w = this.fs(sub >= 0x070 ? 1 : 0); let v = r[rd];
        if (w < 32) v &= (2 ** w) - 1;
        r[rd] = v; this.st = (this.st & ~Z) | (v ? 0 : Z); return;
      }
      case 0x054: case 0x056: case 0x074: case 0x076: {                                    // SETF
        const f = sub >= 0x070, shift = f ? 6 : 0;
        this.st = ((this.st & ~(0x3F << shift)) | ((op & 0x3F) << shift)) >>> 0;
        if (f) this.cycles += 1;
        return;
      }
      case 0x058: case 0x078: this.wf(sub >= 0x070 ? 1 : 0, this.paramLong(), r[rd]); this.cycles += 2; return;   // MOVE Rs,@L
      case 0x05A: case 0x07A: { const v = this.rf(sub >= 0x070 ? 1 : 0, this.paramLong()); r[rd] = v; this.st &= ~V; this.nz(v); this.cycles += 4; return; }   // MOVE @L,Rd
      case 0x05C: case 0x07C: if (!(sub & 1)) { const f = sub >= 0x070 ? 1 : 0, src = this.paramLong(); this.wf(f, this.paramLong(), this.rf(f, src)); this.cycles += 6; return; } break;   // MOVE @,@
      case 0x05E: this.wfield(this.paramLong(), 8, r[rd]); return;                          // MOVB Rs,@L
      case 0x07E: { const v = this.rfield(this.paramLong(), 8, true); r[rd] = v; this.st &= ~V; this.nz(v); this.cycles += 4; return; }   // MOVB @L,Rd
      case 0x090: {                                                                        // TRAP
        const t = op & 31;
        if (t) { this.push(this.pc); this.push(this.st); }
        this.st = 0x10; this.pc = (this.rlong((0xFFFFFFE0 - (t << 5)) >>> 0) & ~15) >>> 0; this.cycles += 15; return;
      }
      case 0x092: this.push(this.pc); this.pc = (r[rd] & ~15) >>> 0; this.cycles += 2; return;   // CALL
      case 0x094: if (sub === 0x094) { const st = this.pop(); this.pc = (this.pop() & ~15) >>> 0; this.setSt(st); this.cycles += 10; return; } break;   // RETI
      case 0x096: this.pc = (this.pop() & ~15) >>> 0; if (op & 31) r[15] += (op & 31) << 4; this.cycles += 6; return;   // RETS
      case 0x098: {                                                                        // MMTM
        let l = this.fetch(); const base = (op & 0x10) ? 1 : 0; this.cycles += 1;
        for (let i = 0; i < 16; i++) {
          if (l & 0x8000) { r[rd] -= 0x20; this.wlong(r[rd], r[base ? 30 - i : i]); this.cycles += 4; }
          l <<= 1;
        }
        return;
      }
      case 0x09A: {                                                                        // MMFM
        let l = this.fetch(); const base = (op & 0x10) ? 1 : 0; this.cycles += 2;
        for (let i = 15; i >= 0; i--) {
          if (l & 0x8000) { r[base ? 30 - i : i] = this.rlong(r[rd]); r[rd] += 0x20; this.cycles += 4; }
          l <<= 1;
        }
        return;
      }
      case 0x09C: { const v = this.paramWord(); r[rd] = v; this.st &= ~V; this.nz(v); this.cycles += 1; return; }   // MOVI W
      case 0x09E: { const v = this.paramLong(); r[rd] = v; this.st &= ~V; this.nz(v); this.cycles += 2; return; }   // MOVI L
      case 0x0B0: { const a = this.paramWord(), b = r[rd], v = (a + b) | 0; r[rd] = v; this.addFlags(a, b, v); this.cycles += 1; return; }   // ADDI W
      case 0x0B2: { const a = this.paramLong(), b = r[rd], v = (a + b) | 0; r[rd] = v; this.addFlags(a, b, v); this.cycles += 2; return; }   // ADDI L
      case 0x0B4: { const t = s16(~this.fetch()), d = r[rd], v = (d - t) | 0; this.subFlags(d, t, v); this.cycles += 1; return; }   // CMPI W
      case 0x0B6: { const t = ~this.paramLong(), d = r[rd], v = (d - t) | 0; this.subFlags(d, t, v); this.cycles += 2; return; }   // CMPI L
      case 0x0B8: { const v = r[rd] & ~this.paramLong(); r[rd] = v; this.st = (this.st & ~Z) | (v ? 0 : Z); this.cycles += 2; return; }   // ANDI
      case 0x0BA: { const v = r[rd] | this.paramLong(); r[rd] = v; this.st = (this.st & ~Z) | (v ? 0 : Z); this.cycles += 2; return; }    // ORI
      case 0x0BC: { const v = r[rd] ^ this.paramLong(); r[rd] = v; this.st = (this.st & ~Z) | (v ? 0 : Z); this.cycles += 2; return; }    // XORI
      case 0x0BE: { const t = ~this.paramWord(), d = r[rd], v = (d - t) | 0; this.subFlags(d, t, v); r[rd] = v; this.cycles += 1; return; }   // SUBI W
      case 0x0D0: { const t = ~this.paramLong(), d = r[rd], v = (d - t) | 0; this.subFlags(d, t, v); r[rd] = v; this.cycles += 2; return; }   // SUBI L
      case 0x0D2: if (sub === 0x0D3) { const d = s16(this.rword(this.pc >>> 4)); this.push((this.pc + 16) >>> 0); this.pc = (this.pc + (d << 4) + 16) >>> 0; this.cycles += 2; return; } break;   // CALLR
      case 0x0D4: if (sub === 0x0D5) { const t = this.rlong(this.pc); this.push((this.pc + 32) >>> 0); this.pc = (t & ~15) >>> 0; this.cycles += 3; return; } break;   // CALLA
      case 0x0D6: if (sub === 0x0D6) { this.st |= IE; this.checkInterrupts(); this.cycles += 2; return; } break;   // EINT
      case 0x0D8: case 0x0DA: case 0x0DC: {                                                // DSJ / DSJEQ / DSJNE
        const kind = (sub >> 1) & 3, z = !!(this.st & Z);
        const go = kind === 0 || (kind === 1 ? z : !z);
        if (go) {
          const v = (r[rd] - 1) | 0; r[rd] = v;
          if (v) { this.pc = (this.pc + (s16(this.rword(this.pc >>> 4)) << 4) + 16) >>> 0; this.cycles += 2; return; }
        }
        this.pc = (this.pc + 16) >>> 0; this.cycles += 1; return;
      }
      case 0x0DE: if (sub === 0x0DE) { this.st |= C; return; } break;                      // SETC
      case 0x0F0: case 0x0F2: case 0x0F4: case 0x0F6: case 0x0F8: case 0x0FA: case 0x0FC: case 0x0FE:
        if (!(sub & 1)) { this.graphics(op); return; }
        break;
    }
    this.unimpl();
  }

  // ---------------------------------------------------------------- 4000-7FFF

  alu(op, rd, rs) {
    const r = this.r;
    switch ((op >> 9) & 31) {
      case 0x00: { const a = r[rs], b = r[rd], v = (a + b) | 0; r[rd] = v; this.addFlags(a, b, v); return; }   // ADD
      case 0x01: { const a = r[rs], b = r[rd], v = (a + b + (this.st & C ? 1 : 0)) | 0; r[rd] = v; this.addFlags(a, b, v); return; }   // ADDC
      case 0x02: { const a = r[rs], d = r[rd], v = (d - a) | 0; this.subFlags(d, a, v); r[rd] = v; return; }   // SUB
      case 0x03: { const a = r[rs], d = r[rd], v = (d - a - (this.st & C ? 1 : 0)) | 0; this.subFlags(d, a, v); r[rd] = v; return; }   // SUBB
      case 0x04: { const a = r[rs], d = r[rd], v = (d - a) | 0; this.subFlags(d, a, v); return; }   // CMP
      case 0x05: { const bit = r[rs] & 31; this.st = (this.st & ~Z) | (((r[rd] >>> bit) & 1) ? 0 : Z); this.cycles += 1; return; }   // BTST Rs
      case 0x06: { const v = r[rs]; r[rd] = v; this.st &= ~V; this.nz(v); return; }           // MOVE Rs,Rd
      case 0x07: {                                                                         // MOVE across files
        const s = (op & 0x10) ? 30 - ((op >> 5) & 15) : (op >> 5) & 15, d = (op & 0x10) ? op & 15 : 30 - (op & 15);
        const v = r[s]; r[d] = v; this.st &= ~V; this.nz(v); return;
      }
      case 0x08: { const v = r[rd] & r[rs]; r[rd] = v; this.st = (this.st & ~Z) | (v ? 0 : Z); return; }   // AND
      case 0x09: { const v = r[rd] & ~r[rs]; r[rd] = v; this.st = (this.st & ~Z) | (v ? 0 : Z); return; }  // ANDN
      case 0x0A: { const v = r[rd] | r[rs]; r[rd] = v; this.st = (this.st & ~Z) | (v ? 0 : Z); return; }   // OR
      case 0x0B: { const v = r[rd] ^ r[rs]; r[rd] = v; this.st = (this.st & ~Z) | (v ? 0 : Z); return; }   // XOR
      case 0x0C: this.divs(op, rd, rs); return;
      case 0x0D: this.divu(op, rd, rs); return;
      case 0x0E: {                                                                         // MPYS
        let m = r[rs]; const w = this.fs(1); if (w < 32) m = (m << (32 - w)) >> (32 - w);
        const p = BigInt(m) * BigInt(r[rd]);
        this.st &= ~(N | Z); if (p === 0n) this.st |= Z; if (p < 0n) this.st |= N;
        r[rd] = Number(BigInt.asIntN(32, p >> 32n)); r[this.pair(op, true)] = Number(BigInt.asIntN(32, p));
        this.cycles += 19; return;
      }
      case 0x0F: {                                                                         // MPYU
        let m = r[rs] >>> 0; const w = this.fs(1); if (w < 32) m &= (2 ** w) - 1;
        const p = BigInt(m) * BigInt(r[rd] >>> 0);
        this.st &= ~Z; if (p === 0n) this.st |= Z;
        r[rd] = Number(BigInt.asIntN(32, p >> 32n)); r[this.pair(op, true)] = Number(BigInt.asIntN(32, p));
        this.cycles += 20; return;
      }
      case 0x10: this.sla(rd, r[rs] & 31); return;
      case 0x11: this.sll(rd, r[rs] & 31); return;
      case 0x12: this.sra(rd, r[rs]); return;
      case 0x13: this.srl(rd, r[rs]); return;
      case 0x14: this.rl(rd, r[rs] & 31); return;
      case 0x15: {                                                                         // LMO
        const v = r[rs] >>> 0; this.st = (this.st & ~Z) | (v ? 0 : Z);
        r[rd] = v ? Math.clz32(v) : 0; return;
      }
      case 0x16: {                                                                         // MODS
        this.st &= ~(N | Z | V);
        if (r[rs]) { const v = (r[rd] % r[rs]) | 0; r[rd] = v; this.nz(v); } else this.st |= V;
        this.cycles += 39; return;
      }
      case 0x17: {                                                                         // MODU
        this.st &= ~(Z | V);
        if (r[rs]) { const v = ((r[rd] >>> 0) % (r[rs] >>> 0)) | 0; r[rd] = v; if (!v) this.st |= Z; } else this.st |= V;
        this.cycles += 34; return;
      }
    }
    this.unimpl();
  }

  // The register paired with Rd for 64-bit results: Rd|1 (MPYS/MPYU) or Rd+1 (DIVS/DIVU), same file.
  pair(op, or) { const n = or ? (op & 15) | 1 : (op & 15) + 1; return op & 0x10 ? 30 - n : n; }

  divs(op, rd, rs) {
    const r = this.r, d = op & 15; this.st &= ~(N | Z | V);
    if (!r[rs]) { this.st |= V; this.cycles += 39; return; }
    if (!(d & 1)) {
      const dividend = (BigInt(r[rd]) << 32n) | BigInt(r[this.pair(op)] >>> 0), div = BigInt(r[rs]);
      const q = dividend / div, rem = dividend % div;
      if (q > 0x7FFFFFFFn || q < -0x80000000n) this.st |= V;
      else { r[rd] = Number(q); r[this.pair(op)] = Number(rem); this.nz(r[rd]); }
      this.cycles += 39;
    } else {
      const v = (r[rd] / r[rs]) | 0;                 // truncates toward zero, like C
      r[rd] = v; this.nz(v); this.cycles += 38;
    }
  }

  divu(op, rd, rs) {
    const r = this.r, d = op & 15; this.st &= ~(Z | V);
    if (!r[rs]) { this.st |= V; this.cycles += 36; return; }
    if (!(d & 1)) {
      const dividend = (BigInt(r[rd] >>> 0) << 32n) | BigInt(r[this.pair(op)] >>> 0), div = BigInt(r[rs] >>> 0);
      const q = dividend / div, rem = dividend % div;
      if (q > 0xFFFFFFFFn) this.st |= V;
      else { r[rd] = Number(BigInt.asIntN(32, q)); r[this.pair(op)] = Number(BigInt.asIntN(32, rem)); if (!r[rd]) this.st |= Z; }
    } else {
      const v = Math.floor((r[rd] >>> 0) / (r[rs] >>> 0)) | 0;
      r[rd] = v; if (!v) this.st |= Z;
    }
    this.cycles += 36;
  }

  // ---------------------------------------------------------------- moves (8000-BFFF, D000-DFFF)

  moves(op, rd, rs) {
    const r = this.r, f = (op >> 9) & 1, inc = () => this.fs(f);
    const ldr = (v) => { r[rd] = v; this.st &= ~V; this.nz(v); };
    switch (op >> 10) {
      case 0x20: this.wf(f, r[rd], r[rs]); return;                                          // MOVE Rs,*Rd
      case 0x21: ldr(this.rf(f, r[rs])); this.cycles += 2; return;                          // MOVE *Rs,Rd
      case 0x22: this.wf(f, r[rd], this.rf(f, r[rs])); this.cycles += 2; return;            // MOVE *Rs,*Rd
      case 0x23:
        if (!f) { this.wfield(r[rd], 8, r[rs]); return; }                                  // MOVB Rs,*Rd
        ldr(this.rfield(r[rs], 8, true)); this.cycles += 2; return;                        // MOVB *Rs,Rd
      case 0x24: this.wf(f, r[rd], r[rs]); r[rd] += inc(); return;                          // MOVE Rs,*Rd+
      case 0x25: { const v = this.rf(f, r[rs]); r[rs] += inc(); ldr(v); this.cycles += 2; return; }   // MOVE *Rs+,Rd
      case 0x26: { const v = this.rf(f, r[rs]); r[rs] += inc(); this.wf(f, r[rd], v); r[rd] += inc(); this.cycles += 3; return; }   // MOVE *Rs+,*Rd+
      case 0x27:
        if (!f) { this.wfield(r[rd], 8, this.rfield(r[rs], 8, false)); this.cycles += 2; return; }   // MOVB *Rs,*Rd
        break;
      case 0x28: r[rd] -= inc(); this.wf(f, r[rd], r[rs]); this.cycles += 1; return;        // MOVE Rs,-*Rd
      case 0x29: { r[rs] -= inc(); const v = this.rf(f, r[rs]); ldr(v); this.cycles += 3; return; }   // MOVE -*Rs,Rd
      case 0x2A: { r[rs] -= inc(); const v = this.rf(f, r[rs]); r[rd] -= inc(); this.wf(f, r[rd], v); this.cycles += 3; return; }   // MOVE -*Rs,-*Rd
      case 0x2B:
        if (!f) { const o = this.paramWord(); this.wfield(r[rd] + o, 8, r[rs]); this.cycles += 2; return; }   // MOVB Rs,*Rd(n)
        { const o = this.paramWord(); ldr(this.rfield(r[rs] + o, 8, true)); this.cycles += 4; return; }      // MOVB *Rs(n),Rd
      case 0x2C: { const o = this.paramWord(); this.wf(f, r[rd] + o, r[rs]); this.cycles += 2; return; }    // MOVE Rs,*Rd(n)
      case 0x2D: { const o = this.paramWord(); ldr(this.rf(f, r[rs] + o)); this.cycles += 4; return; }      // MOVE *Rs(n),Rd
      case 0x2E: { const o1 = this.paramWord(), o2 = this.paramWord(); this.wf(f, r[rd] + o2, this.rf(f, r[rs] + o1)); this.cycles += 4; return; }   // MOVE *Rs(n),*Rd(n)
      case 0x2F:
        if (!f) { const o1 = this.paramWord(), o2 = this.paramWord(); this.wfield(r[rd] + o2, 8, this.rfield(r[rs] + o1, 8, false)); this.cycles += 4; return; }   // MOVB *Rs(n),*Rd(n)
        break;
      case 0x34: { const o = this.paramWord(), v = this.rf(f, r[rs] + o); this.wf(f, r[rd], v); r[rd] += inc(); this.cycles += 4; return; }   // MOVE *Rs(n),*Rd+
      case 0x35: {
        const sub = (op >> 5) & 15;
        if ((op & 0x0100) === 0 && sub === 0) {                                            // MOVE @L,*Rd+ (D400/D600)
          const v = this.rf(f, this.paramLong()); this.wf(f, r[rd], v); r[rd] += inc(); this.cycles += 4; return;
        }
        if ((op & 0x0100) && sub === 8) {                                                  // EXGF Rd,F (D500/D700)
          const shift = f ? 6 : 0, t = (this.st >> shift) & 0x3F;
          this.st = ((this.st & ~(0x3F << shift)) | ((r[rd] & 0x3F) << shift)) >>> 0;
          r[rd] = t; return;
        }
        break;
      }
    }
    this.unimpl();
  }

  // ---------------------------------------------------------------- XY (E000-EFFF)

  xyOps(op, rd, rs) {
    const r = this.r;
    switch ((op >> 9) & 7) {
      case 0: {                                                                            // ADD XY
        const a = r[rs], b = r[rd], x = s16(b + a), y = s16((b >> 16) + (a >> 16));
        r[rd] = (y << 16) | (x & 0xFFFF);
        this.st = (this.st & ~(N | C | Z | V)) | (x === 0 ? N : 0) | (y < 0 ? C : 0) | (y === 0 ? Z : 0) | (x < 0 ? V : 0);
        return;
      }
      case 1: {                                                                            // SUB XY
        const a = r[rs], b = r[rd], ax = s16(a), ay = a >> 16, bx = s16(b), by = b >> 16;
        this.st = (this.st & ~(N | C | Z | V)) | (ax === bx ? N : 0) | (ay > by ? C : 0) | (ay === by ? Z : 0) | (ax > bx ? V : 0);
        r[rd] = (s16(by - ay) << 16) | (s16(bx - ax) & 0xFFFF);
        return;
      }
      case 2: {                                                                            // CMP XY
        const a = r[rd], b = r[rs], dx = s16(s16(a) - s16(b)), dy = s16((a >> 16) - (b >> 16));
        this.st = (this.st & ~(N | C | Z | V)) | (dx === 0 ? N : 0) | (dx < 0 ? V : 0) | (dy === 0 ? Z : 0) | (dy < 0 ? C : 0);
        return;
      }
      case 3: {                                                                            // CPW
        const x = s16(r[rs]), y = r[rs] >> 16, ws = r[25], we = r[24];
        let res = 0;
        if (s16(ws) > x) res |= 0x20; if (x > s16(we)) res |= 0x40;
        if ((ws >> 16) > y) res |= 0x80; if (y > (we >> 16)) res |= 0x100;
        r[rd] = res; this.st = (this.st & ~V) | (res ? V : 0); return;
      }
      case 4: r[rd] = this.dxytol(r[rs]); this.cycles += 2; return;                        // CVXYL
      case 6: r[rd] = (r[rd] & 0xFFFF0000) | (r[rs] & 0xFFFF); return;                     // MOVX
      case 7: r[rd] = (r[rs] & 0xFFFF0000) | (r[rd] & 0xFFFF); return;                     // MOVY
    }
    this.unimpl();
  }

  // ---------------------------------------------------------------- PIXT (F000-FFFF)

  pixOps(op, rd, rs) {
    const r = this.r;
    switch ((op >> 9) & 7) {
      case 0: if (!this.windowSkip(r[rd])) this.pixelWrite(this.dxytol(r[rd]), r[rs]); this.cycles += 3; return;   // PIXT Rs,*Rd.XY
      case 1: { const v = this.pixelRead(this.sxytol(r[rs])); r[rd] = v; this.st = (this.st & ~V) | (v ? V : 0); this.cycles += 5; return; }   // PIXT *Rs.XY,Rd
      case 2: if (!this.windowSkip(r[rd])) this.pixelWrite(this.dxytol(r[rd]), this.pixelRead(this.sxytol(r[rs]))); this.cycles += 6; return;   // PIXT *Rs.XY,*Rd.XY
      case 3: {                                                                            // DRAV
        if (!this.windowSkip(r[rd])) this.pixelWrite(this.dxytol(r[rd]), r[21]);
        const a = r[rs], b = r[rd];
        r[rd] = (s16((b >> 16) + (a >> 16)) << 16) | (s16(b + a) & 0xFFFF);
        this.cycles += 3; return;
      }
      case 4: this.pixelWrite(r[rd], r[rs]); this.cycles += 1; return;                     // PIXT Rs,*Rd
      case 5: { const v = this.pixelRead(r[rs]); r[rd] = v; this.st = (this.st & ~V) | (v ? V : 0); this.cycles += 3; return; }   // PIXT *Rs,Rd
      case 6: this.pixelWrite(r[rd], this.pixelRead(r[rs])); this.cycles += 3; return;     // PIXT *Rs,*Rd
    }
    this.unimpl();
  }

  // ---------------------------------------------------------------- graphics (0F00-0FFF)
  //
  // FILL and PIXBLT, done all at once (the real chip can be interrupted
  // part way; these finish before the next instruction). B registers:
  // B0 SADDR, B1 SPTCH, B2 DADDR, B3 DPTCH, B4 OFFSET, B5/B6 window,
  // B7 DYDX, B8 COLOR0, B9 COLOR1.

  graphics(op) {
    const r = this.r, kind = (op >> 5) & 7;
    const dydx = r[23], w = s16(dydx), h = dydx >> 16;
    const psize = 1 << this.pixelshift;
    if (w <= 0 || h <= 0) return;
    const daddrXY = kind & 1;                                                 // destination given as X,Y
    let dst = daddrXY ? this.dxytol(r[28]) : r[28];
    const dptch = r[27];
    if (kind === 6 || kind === 7) {                                           // FILL L / FILL XY
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) this.pixelWrite(dst + x * psize, r[22]);
        dst += dptch;
      }
      this.cycles += (w * h) >> 2;
      return;
    }
    let src = kind === 2 || kind === 3 ? this.sxytol(r[30]) : r[30];
    const sptch = r[29];
    const binary = kind === 4 || kind === 5;                                  // PIXBLT B: 1 bit per pixel, expanded to COLOR0/COLOR1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v;
        if (binary) v = this.rfield(src + x, 1, false) ? r[21] : r[22];
        else v = this.pixelRead(src + x * psize);
        this.pixelWrite(dst + x * psize, v);
      }
      src += sptch; dst += dptch;
    }
    this.cycles += (w * h) >> 1;
  }
}
