// Helpers shared by the board video code.

// 32-bit pixel for a canvas ImageData (little-endian RGBA).
export const rgba = (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;

// Bit `b` of a ROM, most significant bit of each byte first.
export const bitAt = (rom, b) => (rom[b >> 3] >> (7 - (b & 7))) & 1;

// Decode tiles or sprites described the way graphics are usually documented:
// bit offsets of each plane (first plane = most significant bit of the pen),
// of each x and y position within a tile, and the size of one tile in bits.
// Returns one pen value per pixel, tile after tile.
export function decodeTiles(rom, { count, width, height, planes, xs, ys, size, base = 0 }) {
  const out = new Uint8Array(count * width * height);
  let o = 0;
  for (let t = 0; t < count; t++) {
    const start = base + t * size;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let pen = 0;
        for (const p of planes) pen = (pen << 1) | bitAt(rom, start + p + ys[y] + xs[x]);
        out[o++] = pen;
      }
    }
  }
  return out;
}

// Resistor-weighted color PROM (the common Namco/Midway hookup): 3 bits red,
// 3 bits green, 2 bits blue. `blue` gives the two blue weights.
export function promPalette(prom, count, blue = [0x51, 0xAE]) {
  const w3 = [0x21, 0x47, 0x97];
  const pal = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const v = prom[i];
    const r = (v & 1 ? w3[0] : 0) + (v & 2 ? w3[1] : 0) + (v & 4 ? w3[2] : 0);
    const g = (v & 8 ? w3[0] : 0) + (v & 16 ? w3[1] : 0) + (v & 32 ? w3[2] : 0);
    const b = (v & 64 ? blue[0] : 0) + (v & 128 ? blue[1] : 0);
    pal[i] = rgba(r, g, b);
  }
  return pal;
}

// Rotate a w x h picture 90 degrees clockwise into `dst` (h wide, w tall),
// for games on a vertically mounted monitor.
export function rotate90(src, w, h, dst) {
  for (let y = 0; y < h; y++) {
    const dx = h - 1 - y;
    for (let x = 0; x < w; x++) dst[x * h + dx] = src[y * w + x];
  }
}

// Helper for x/y offset tables: n consecutive values from `start` in `step`s.
export const run = (start, n, step = 1) => Array.from({ length: n }, (_, i) => start + i * step);

// Rotate a w x h picture 90 degrees counter-clockwise into `dst` (h wide, w
// tall), for vertical monitors mounted the other way round.
export function rotate270(src, w, h, dst) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) dst[(w - 1 - x) * h + y] = src[y * w + x];
  }
}
