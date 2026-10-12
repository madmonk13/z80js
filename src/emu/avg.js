// Atari's Analog Vector Generator (Tempest, Battlezone, Star Wars, Major
// Havoc): a little processor that walks a display list of 16-bit words and
// steers the beam with analog integrators. Modeled per instruction (the real
// one is a state machine run from a PROM that isn't in the ROM sets).
//
// The opcode is the top three bits:
//   0 VCTR  two words: dy (13-bit two's complement), then the intensity
//           (bits 15-13) and dx (13 bits)
//   1 HALT
//   2 SVEC  one word: dy in bits 12-8 and dx in bits 4-0 (5-bit, doubled),
//           intensity in bits 7-5
//   3 STAT  bit 12 clear: color and intensity (the layout varies by board)
//     SCAL  bit 12 set: binary scale (bits 10-8, each halves) and linear
//           scale (bits 7-0, 0 = full size, 255 = nothing)
//   4 CNTR  beam to the center
//   5 JSRL  call (13-bit word address); four levels of stack
//   6 RTSL  return
//   7 JMPL  jump
//
// A vector's intensity of 1 means "use the STAT intensity". Coordinates are
// relative to the center, y up. Tempest never halts: its list loops back to
// the start, which ends a frame here.

const sx = (v, bits) => (v & (1 << (bits - 1)) ? v - (1 << bits) : v);

export class AVG {
  // readByte(address) -> byte of the display list's address space (byte 0 =
  // word 0). variant: 'tempest' | 'bzone' | 'starwars'. Star Wars (6809) stores
  // words big-endian; the 6502 boards little-endian.
  constructor(readByte, variant) {
    this.readByte = readByte;
    this.variant = variant;
    this.bigEndian = variant === 'starwars';
  }

  word(w) {
    const a = (w & 0x1FFF) * 2, b0 = this.readByte(a), b1 = this.readByte(a + 1);
    return this.bigEndian ? (b0 << 8) | b1 : b0 | (b1 << 8);
  }

  // Run the list from the start; returns segments as [x0, y0, x1, y1, color,
  // brightness 0-255] (color: a palette index for the board to look up;
  // brightness after the monitor's response, see brightness()).
  run() {
    const out = [], stack = [0, 0, 0, 0], v = this.variant;
    let pc = 0, sp = 0, x = 0, y = 0, linear = 0, bin = 0, color = 0, statInt = 0;
    let clip = null, lst = 1, hst = 1;
    const corner = { x0: 0, y0: 0, x1: 0, y1: 0 };
    const draw = (dx, dy, z) => {
      const k = (255 - linear) / 256 / (1 << bin);
      const nx = x + dx * k, ny = y + dy * k;
      let b;
      if (v === 'starwars') b = (z * statInt) >> 3;
      else b = (z === 1 ? statInt : z & 6) << 4;
      if (b) this.segment(out, clip, x, y, nx, ny, color, AVG.brightness(Math.min(255, b)));
      x = nx; y = ny;
    };
    for (let steps = 0; steps < 30000; steps++) {
      const w = this.word(pc), op = w >> 13;
      // Battlezone's window: a STAT arms a corner, the next instruction latches the beam there.
      if (!hst || !lst) {
        if (!hst) { corner.x1 = x; corner.y1 = y; }
        if (!lst) { corner.x0 = x; corner.y0 = y; }
        clip = { ...corner };
        hst = lst = 1;
      }
      switch (op) {
        case 0: {
          const w2 = this.word(pc + 1);
          pc += 2;
          draw(sx(w2 & 0x1FFF, 13), sx(w & 0x1FFF, 13), w2 >> 13);
          break;
        }
        case 1: return out;
        case 2:
          pc++;
          draw(sx(w & 0x1F, 5) * 2, sx((w >> 8) & 0x1F, 5) * 2, (w >> 5) & 7);
          break;
        case 3:
          pc++;
          if (w & 0x1000) { linear = w & 0xFF; bin = (w >> 8) & 7; break; }
          if (v === 'tempest') { if (w & 0x800) color = w & 15; else statInt = (w >> 4) & 15; }
          else if (v === 'starwars') { statInt = w & 0xFF; color = (w >> 8) & 7; }
          else {
            statInt = (w >> 4) & 15;
            if (v === 'bzone' && !(w & 0x400)) { lst = w & 0x200 ? 1 : 0; hst = lst ? 0 : 1; }
          }
          break;
        case 4: pc++; x = y = 0; break;
        case 5: pc++; stack[sp & 3] = pc; sp++; pc = w & 0x1FFF; break;
        case 6: sp--; pc = stack[sp & 3]; break;
        default:
          if (!(w & 0x1FFF)) return out;       // back to the top: the frame is done
          pc = w & 0x1FFF;
      }
    }
    return out;
  }

  // Add a segment, cut to the clip window if there is one (Liang-Barsky).
  segment(out, clip, x0, y0, x1, y1, color, b) {
    if (clip) {
      const dx = x1 - x0, dy = y1 - y0;
      let t0 = 0, t1 = 1;
      const edges = [[-dx, x0 - clip.x0], [dx, clip.x1 - x0], [-dy, y0 - clip.y0], [dy, clip.y1 - y0]];
      for (const [p, q] of edges) {
        if (p === 0) { if (q < 0) return; continue; }
        const t = q / p;
        if (p < 0) { if (t > t1) return; if (t > t0) t0 = t; } else { if (t < t0) return; if (t < t1) t1 = t; }
      }
      [x0, y0, x1, y1] = [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
    }
    out.push(x0, y0, x1, y1, color, b);
  }

  // A vector monitor's phosphor isn't linear: middling beam levels (where the
  // games draw most lines) look far brighter than their share of full scale.
  static brightness(level) { return Math.min(255, Math.sqrt(level / 255) * 1.25 * 255); }
}
