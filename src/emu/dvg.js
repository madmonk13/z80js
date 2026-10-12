// Atari's Digital Vector Generator (Asteroids, Lunar Lander): a little
// processor that walks a display list of 16-bit words in vector RAM / ROM
// and moves the beam.
//
//   0-9  VCTR  two words: dy (10 bits + sign bit 10), then intensity
//              (bits 15-12) and dx; the opcode is the scale
//   A    LABS  two words: absolute y, then global scale (bits 15-12) and x
//   B    HALT
//   C    JSRL  call (12-bit word address); four levels of stack
//   D    RTSL  return
//   E    JMPL  jump
//   F    SVEC  one word: a short vector with 2-bit dx/dy, intensity in
//              bits 7-4 and a 2-bit scale split across bits 11 and 3
//
// A vector's length is its delta shifted by its scale plus the global scale:
// delta >> (9 - scale), where a combined scale past 9 wraps around.
// Coordinates are 10 bits, y up.

export class DVG {
  // readWord(address) -> 16-bit display-list word at a word address.
  constructor(readWord) { this.readWord = readWord; this.lines = []; }

  // Run the display list from the start; returns the segments drawn as
  // [x0, y0, x1, y1, intensity 0-15] in DVG coordinates.
  run() {
    const lines = [];
    let pc = 0, sp = 0, x = 0, y = 0, gs = 0;
    const stack = [0, 0, 0, 0];
    for (let steps = 0; steps < 20000; steps++) {
      const w = this.readWord(pc), op = w >> 12;
      if (op <= 9 || op === 0xF) {
        let dx, dy, z, scale;
        if (op <= 9) {
          const w2 = this.readWord((pc + 1) & 0xFFF);
          pc = (pc + 2) & 0xFFF;
          dy = w & 0x3FF; if (w & 0x400) dy = -dy;
          dx = w2 & 0x3FF; if (w2 & 0x400) dx = -dx;
          z = w2 >> 12; scale = op;
        } else {
          pc = (pc + 1) & 0xFFF;
          dy = (w & 0x300); if (w & 0x400) dy = -dy;
          dx = (w & 3) << 8; if (w & 4) dx = -dx;
          z = (w >> 4) & 15; scale = 2 + (((w >> 2) & 2) | ((w >> 11) & 1));
        }
        let s = (gs + scale) & 15;
        if (s > 9) s = -1;
        const nx = x + Math.trunc(dx / Math.pow(2, 9 - s)), ny = y + Math.trunc(dy / Math.pow(2, 9 - s));
        if (z) lines.push(x, y, nx, ny, z);
        x = nx; y = ny;
        continue;
      }
      switch (op) {
        case 0xA: {
          const w2 = this.readWord((pc + 1) & 0xFFF);
          pc = (pc + 2) & 0xFFF;
          y = w & 0x3FF; x = w2 & 0x3FF; gs = w2 >> 12;
          break;
        }
        case 0xB: return lines;
        case 0xC: stack[sp & 3] = (pc + 1) & 0xFFF; sp++; pc = w & 0xFFF; break;
        case 0xD: sp--; pc = stack[sp & 3]; break;
        default: pc = w & 0xFFF; break;      // E: JMPL
      }
    }
    return lines;
  }
}
