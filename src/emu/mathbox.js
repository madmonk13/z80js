// Atari's math box (Battlezone, Red Baron, Tempest): bit-slice ALUs that
// do the 3D games' rotations, projections and distances in 16-bit signed
// arithmetic. The CPU writes operands and commands to 32 addresses (each
// command also loads or computes a result) and reads the 16-bit result back.
// Modeled by function, after Eric Smith's description of the microcode.
//
//   00-0B, 0C, 0D-10, 15-16, 1A-1B   load registers (low / high bytes)
//   0B  R7 = R0*(R4-R2) - R1*(R5-R3)
//   11  R7 = R0*R4 - R1*R5 + R2, R8 = R1*R4 + R0*R5 + R3, then R8:R9 / R7
//   12, 13, 14  the second rotation term; divide R7 by R8 or Rb by Ra
//   1C  window search (halves an interval R6+1 times)
//   1D, 1E  distance estimate: max(|dx|, |dy|) + 3/8 min(...)

const s16 = (v) => (v << 16) >> 16;

export class MathBox {
  constructor() { this.reset(); }
  saveState() { return { r: [...this.r], result: this.result }; }
  loadState(s) { this.r.set(s.r); this.result = s.result; }
  reset() { this.r = new Int16Array(16); this.result = 0; }

  status() { return 0; }                       // always done
  lo() { return this.result & 0xFF; }
  hi() { return (this.result >> 8) & 0xFF; }

  // Load the low or high byte of register n; the result echoes it.
  load(n, v, high) {
    const r = this.r;
    r[n] = high ? (r[n] & 0xFF) | (v << 8) : (r[n] & 0xFF00) | v;
    this.result = r[n];
  }

  // Two signed 16x16 products summed, rounded on the dropped low halves:
  // returns the high word of a*b + c*d.
  static mulAdd(a, b, c, d) {
    const p = a * b, q = c * d;
    let hi = s16(Math.floor(p / 65536) + Math.floor(q / 65536));
    const lo = s16(((p & 0xFFFF) >> 1) + ((q & 0xFFFF) >> 1));
    if (lo < 0) hi = s16(hi + 1);
    return { hi, lo };
  }

  go(cmd, v) {
    const r = this.r;
    const LOADS = { 0x00: [0, 0], 0x01: [0, 1], 0x02: [1, 0], 0x03: [1, 1], 0x04: [2, 0], 0x05: [2, 1],
      0x06: [3, 0], 0x07: [3, 1], 0x08: [4, 0], 0x09: [4, 1], 0x0A: [5, 0], 0x0D: [10, 0], 0x0E: [10, 1],
      0x0F: [11, 0], 0x10: [11, 1], 0x15: [7, 0], 0x16: [7, 1], 0x1A: [8, 0], 0x1B: [8, 1] };
    if (cmd in LOADS) { this.load(LOADS[cmd][0], v, LOADS[cmd][1]); return; }
    switch (cmd) {
      case 0x0C: r[6] = v; this.result = r[6]; return;
      case 0x17: this.result = r[7]; return;
      case 0x18: this.result = r[9]; return;
      case 0x19: this.result = r[8]; return;
      case 0x0B: case 0x11: {
        // 0B: offset by (R2, R3) and stop after the first term. 11: the whole chain.
        r[5] = (r[5] & 0xFF) | (v << 8);
        r[15] = cmd === 0x0B ? -1 : 0;
        if (cmd === 0x0B) { r[4] = s16(r[4] - r[2]); r[5] = s16(r[5] - r[3]); }
        r[7] = MathBox.mulAdd(r[0], r[4], -r[1], r[5]).hi;
        this.result = r[7];
        if (r[15] < 0) return;
        r[7] = s16(r[7] + r[2]);
        this.term2();
        return;
      }
      case 0x12: this.term2(); return;
      case 0x13: this.divide(r[7], r[8], r[9]); return;
      case 0x14: this.divide(r[7], r[11], r[10]); return;
      case 0x1C: {
        r[5] = (r[5] & 0xFF) | (v << 8);
        do {
          const e = s16((r[4] + r[7]) >> 1), f = s16((r[5] + r[8]) >> 1);
          if (r[11] < e && f < e && e + f >= 0) { r[7] = e; r[8] = f; } else { r[4] = e; r[5] = f; }
          r[6] = s16(r[6] - 1);
        } while (r[6] >= 0);
        this.result = r[8];
        return;
      }
      case 0x1D:
        r[3] = (r[3] & 0xFF) | (v << 8);
        r[2] = Math.abs(s16(r[2] - r[0]));
        r[3] = Math.abs(s16(r[3] - r[1]));
        // falls through
      case 0x1E: {
        const lo = Math.min(r[2], r[3]), hi = Math.max(r[2], r[3]);
        r[13] = s16(hi + (lo >> 2) + (lo >> 3));
        this.result = r[13];
        return;
      }
    }
  }

  // R8 = R1*R4 + R0*R5 (high word; R9 keeps the doubled low word). Unless
  // the step register R15 is negative, it goes on to add R3 and divide.
  term2() {
    const r = this.r, { hi, lo } = MathBox.mulAdd(r[1], r[4], r[0], r[5]);
    r[8] = hi; r[9] = s16(lo << 1);
    this.result = r[8];
    if (r[15] < 0) return;
    r[8] = s16(r[8] + r[3]);
    r[9] = s16(r[9] & 0xFF00);
    this.divide(r[7], r[8], r[9]);
  }

  // Signed divide: numerator (hi:lo) by the divisor's magnitude, R6+1
  // quotient bits, then the sign of divisor ^ numerator.
  divide(divisor, numHi, numLo) {
    const r = this.r, sign = s16(divisor ^ numHi);
    let rem = numHi, q = numLo;
    if (numHi < 0) {
      rem = s16(-numHi - 1);
      q = s16(-numLo - 1);
      if (q < 0 && s16(q + 1) < 0) rem = s16(rem + 1);
      q = s16(q + 1);
    }
    const d = s16(Math.abs(divisor));
    r[15] = r[6];                              // the step counter, left at -1
    do {
      rem = s16(rem - d);
      const msb = (q >> 15) & 1;
      q = s16(q << 1);
      if (rem >= 0) q = s16(q + 1); else rem = s16(rem + d);
      rem = s16((rem << 1) + msb);
      r[15]--;
    } while (r[15] >= 0);
    this.result = sign >= 0 ? q : s16(-q);
  }
}
