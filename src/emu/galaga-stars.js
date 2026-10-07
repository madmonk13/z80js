// Starfield for the 05xx star generator: 4 sets of 63 stars as
// [x, y, color, set] quadruples. The real chip derives its stars from a
// pseudo-random sequence; this generates a comparable field from a seeded
// LFSR (positions spread over the 256x256 star plane, 64 possible colors),
// not the exact arcade pattern.

function lfsr(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

const rand = lfsr(0x05C0FFEE);
const stars = [];
for (let set = 0; set < 4; set++) {
  for (let n = 0; n < 63; n++) {
    // One star per band of rows keeps them evenly spread down the screen.
    const y = Math.floor((n * 256) / 63) + (rand() % 4);
    stars.push(rand() & 0xFF, y & 0xFF, 1 + (rand() % 63), set);   // never color 0 (black)
  }
}

export const STARS = new Uint8Array(stars);
