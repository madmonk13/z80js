// CPS-2 program decryption. The board's security chip decrypts the 68000's
// instruction fetches (data reads pass through untouched) with two 4-round
// Feistel networks: the first turns the word's address into a 16-bit seed,
// which (spread to 64 bits and XORed with the game's 64-bit key) keys the
// second, which decrypts the word itself. Each round has four substitution
// boxes of six inputs and two outputs.
//
// The s-box contents, key bit orders and per-game keys were worked out by
// Andreas Naive, Nicola Salmoria, Charles MacDonald and Razoola (as
// documented in MAME's cps2crpt.c); they're reproduced here as data.
//
// decryptCps2(rom, key, limit) returns a Uint16Array of decrypted opcode words
// for the big-endian program `rom`, covering addresses below `limit`.

// [table of 64 two-bit outputs, input bit positions (-1: key only), output bit positions]
const SBOXES = {
  fn1_r1: [
    ['0220101132030312111213222332111222003131113001001221232223132013', [3, 4, 5, 6, -1, -1], [3, 6]],
    ['3022211112100023231300021223033301323331111201213231132223132300', [0, 1, 2, 4, 7, -1], [2, 7]],
    ['3031102231203323010123020201001023121020210102103123131112022000', [0, 1, 2, 3, 6, 7], [0, 1]],
    ['3203022112321321221332101013000221010101311223203320213300301133', [0, 1, 3, 5, 6, 7], [4, 5]],
  ],
  fn1_r2: [
    ['3320303103010213130331333232231202210120330132123013012212120130', [0, 1, 2, 3, 6, -1], [1, 6]],
    ['1232130110200232330122101012321322201023212121030123121320323020', [2, 4, 5, 6, 7, -1], [5, 7]],
    ['0102110102221300113122231033322211303130133211001222111220032313', [1, 2, 3, 4, 5, 7], [0, 3]],
    ['2103332012111031133012100030303013330320212221130101011113101233', [0, 1, 3, 4, 6, 7], [2, 4]],
  ],
  fn1_r3: [
    ['0003311020200032012322103000002330011233013201332001020003133333', [0, 1, 5, 6, 7, -1], [0, 5]],
    ['2323023022303202102311100102122130212330323102101223021313021113', [2, 3, 4, 6, 7, -1], [6, 7]],
    ['3021131221222001231020023120003021120012311201303110023000032000', [0, 2, 3, 4, 5, 6], [1, 4]],
    ['0100213233210111110331100221033213303021123222100333223102303110', [0, 1, 2, 3, 5, 7], [2, 3]],
  ],
  fn1_r4: [
    ['1111101332301202330121230323201201032132312320122000213031301330', [1, 2, 3, 4, 5, 7], [0, 4]],
    ['3000010233130312223100201022330011302303030202010301311001332210', [0, 1, 2, 3, 5, 6], [1, 3]],
    ['0112013120320030301223323201001030230222110220012111230312331130', [0, 2, 4, 5, 6, 7], [2, 6]],
    ['0122010322113202013302233200213311131211033232303100300022212300', [0, 1, 3, 4, 6, 7], [5, 7]],
  ],
  fn2_r1: [
    ['2020300311013201201202022230213001012233030230121102031122131131', [0, 3, 4, 5, 7, -1], [6, 7]],
    ['1103020130201100132202222013331113132222220101123112033322311130', [1, 2, 3, 4, 6, -1], [3, 5]],
    ['1022333312210121123120012312000220110020002323013000232013213113', [1, 2, 4, 5, 6, 7], [1, 4]],
    ['1330323132113321230310023000330123000121300102223312130003013220', [0, 2, 3, 5, 6, 7], [0, 2]],
  ],
  fn2_r2: [
    ['3130303130011303110123233122202322211330312111020330020011212110', [0, 2, 4, 6, -1, -1], [4, 6]],
    ['0303321231112023031221333212201023012011202120233102330311300120', [1, 3, 4, 5, 6, 7], [0, 3]],
    ['0021321012221103122321103001123133221011120123033032202212321021', [0, 1, 3, 4, 5, 7], [1, 7]],
    ['0212022013203230332312312200221223331100032032311110101300122320', [1, 2, 3, 5, 6, 7], [2, 5]],
  ],
  fn2_r3: [
    ['2121231322133001020331001102321211211322022333200000333012102331', [2, 3, 4, 6, -1, -1], [3, 5]],
    ['3233103020111030313101232232011230021002201002001313203310222300', [0, 1, 3, 5, 7, -1], [0, 2]],
    ['2210233000131232231303033221000212220012013023213222313020210331', [0, 1, 2, 3, 5, 7], [1, 6]],
    ['1232021331011220011121120133111233102111210022323220223302302211', [0, 2, 4, 5, 6, 7], [4, 7]],
  ],
  fn2_r4: [
    ['2011213311120102012023023322320130202313200112311101203311133110', [0, 1, 3, 6, 7, -1], [0, 3]],
    ['1221033102221010110102102102323322122313330101300012033232132102', [0, 1, 2, 4, 5, 6], [4, 7]],
    ['2321323002110032310122213221021203100311332010130012123210032113', [0, 2, 3, 4, 5, 7], [1, 2]],
    ['2003222133112003103210203223203013022133010311320302321323001321', [2, 3, 4, 5, 6, 7], [5, 6]],
  ],
};
const KEY1_BITS = [33, 58, 49, 36, 0, 31, 22, 30, 3, 16, 5, 53, 10, 41, 23, 19, 27, 39, 43, 6, 34, 12, 61, 21, 48, 13, 32, 35, 6, 42, 43, 14, 21, 41, 52, 25, 18, 47, 46, 37, 57, 53, 20, 8, 55, 54, 59, 60, 27, 33, 35, 18, 8, 15, 63, 1, 50, 44, 16, 46, 5, 4, 45, 51, 38, 25, 13, 11, 62, 29, 48, 2, 59, 61, 62, 56, 51, 57, 54, 9, 24, 63, 22, 7, 26, 42, 45, 40, 23, 14, 2, 31, 52, 28, 44, 17];
const KEY2_BITS = [34, 9, 32, 24, 44, 54, 38, 61, 47, 13, 28, 7, 29, 58, 18, 1, 20, 60, 15, 6, 11, 43, 39, 19, 63, 23, 16, 62, 54, 40, 31, 3, 56, 61, 17, 25, 47, 38, 55, 57, 5, 4, 15, 42, 22, 7, 2, 19, 46, 37, 29, 39, 12, 30, 49, 57, 31, 41, 26, 27, 24, 36, 11, 63, 33, 16, 56, 62, 48, 60, 59, 32, 12, 30, 53, 48, 10, 0, 50, 35, 3, 59, 14, 49, 51, 45, 44, 2, 21, 33, 55, 52, 23, 28, 8, 26];
const SUBKEY_BITS = [5, 10, 14, 9, 4, 0, 15, 6, 1, 8, 3, 2, 12, 7, 13, 11, 5, 12, 7, 2, 13, 11, 9, 14, 4, 1, 6, 10, 8, 0, 15, 3, 4, 10, 2, 0, 6, 9, 12, 1, 11, 7, 15, 8, 13, 5, 14, 3, 14, 11, 12, 7, 4, 5, 2, 10, 1, 15, 0, 9, 8, 6, 13, 3];

const FN1_A = [10, 4, 6, 7, 2, 13, 15, 14], FN1_B = [0, 1, 3, 5, 8, 9, 11, 12];
const FN2_A = [6, 0, 2, 13, 1, 4, 14, 7], FN2_B = [3, 5, 9, 10, 8, 15, 12, 11];

const bit = (v, n) => (v >>> n) & 1;

// Precompute each box: input byte -> its 6-bit box input, and box output -> bits of the result byte.
function prepare(list) {
  return list.map(([table, inputs, outputs]) => {
    const inLut = new Uint8Array(256), outLut = new Uint8Array(64);
    for (let i = 0; i < 256; i++) {
      let r = 0;
      inputs.forEach((p, k) => { if (p >= 0) r |= bit(i, p) << k; });
      inLut[i] = r;
    }
    for (let i = 0; i < 64; i++) {
      const o = +table[i];
      outLut[i] = (o & 1 ? 1 << outputs[0] : 0) | (o & 2 ? 1 << outputs[1] : 0);
    }
    return [inLut, outLut];
  });
}

// One round: four boxes, each keyed by six bits of a 24-bit round key.
function round(v, boxes, key) {
  let r = 0;
  for (let b = 0; b < 4; b++) r |= boxes[b][1][boxes[b][0][v] ^ ((key >>> (6 * b)) & 0x3F)];
  return r;
}

function feistel(val, bitsA, bitsB, rounds, keys) {
  let l = 0, r = 0;
  for (let i = 0; i < 8; i++) { l |= bit(val, bitsB[i]) << i; r |= bit(val, bitsA[i]) << i; }
  l ^= round(r, rounds[0], keys[0]);
  r ^= round(l, rounds[1], keys[1]);
  l ^= round(r, rounds[2], keys[2]);
  r ^= round(l, rounds[3], keys[3]);
  let out = 0;
  for (let i = 0; i < 8; i++) out |= (bit(l, i) << bitsA[i]) | (bit(r, i) << bitsB[i]);
  return out;
}

// Spread 64 key bits (two 32-bit halves) into four 24-bit round keys.
function expand(src, order) {
  const k = [0, 0, 0, 0];
  for (let i = 0; i < 96; i++) k[(i / 24) | 0] |= bit(src[order[i] >> 5], order[i] & 31) << (i % 24);
  return k;
}

export function decryptCps2(rom, masterKey, limit) {
  const words = rom.length >> 1, dec = new Uint16Array(words);
  for (let i = 0; i < words; i++) dec[i] = (rom[2 * i] << 8) | rom[2 * i + 1];
  const fn1 = ['fn1_r1', 'fn1_r2', 'fn1_r3', 'fn1_r4'].map((n) => prepare(SBOXES[n]));
  const fn2 = ['fn2_r1', 'fn2_r2', 'fn2_r3', 'fn2_r4'].map((n) => prepare(SBOXES[n]));
  const key1 = expand(masterKey, KEY1_BITS);
  // Boxes with fewer than six inputs take copies of key bits in the unused places.
  key1[0] ^= bit(key1[0], 1) << 4; key1[0] ^= bit(key1[0], 2) << 5; key1[0] ^= bit(key1[0], 8) << 11;
  key1[1] ^= bit(key1[1], 0) << 5; key1[1] ^= bit(key1[1], 8) << 11;
  key1[2] ^= bit(key1[2], 1) << 5; key1[2] ^= bit(key1[2], 8) << 11;
  const end = Math.min(words, limit >> 1);
  for (let i = 0; i < 0x10000; i++) {
    const seed = feistel(i, FN1_A, FN1_B, fn1, key1);
    const sub = [0, 0];
    for (let k = 0; k < 64; k++) sub[k >> 5] |= bit(seed, SUBKEY_BITS[k]) << (k & 31);
    const key2 = expand([(sub[0] ^ masterKey[0]) >>> 0, (sub[1] ^ masterKey[1]) >>> 0], KEY2_BITS);
    key2[0] ^= bit(key2[0], 0) << 5; key2[0] ^= bit(key2[0], 6) << 11;
    key2[1] ^= bit(key2[1], 0) << 5; key2[1] ^= bit(key2[1], 1) << 4;
    key2[2] ^= bit(key2[2], 2) << 5; key2[2] ^= bit(key2[2], 3) << 4; key2[2] ^= bit(key2[2], 7) << 11;
    key2[3] ^= bit(key2[3], 1) << 5;
    for (let a = i; a < end; a += 0x10000) dec[a] = feistel(dec[a], FN2_A, FN2_B, fn2, key2);
  }
  return dec;
}

// Per-game keys: [key words, end of the encrypted range].
export const CPS2_KEYS = {
  msh: [[0x1A11EE26, 0xE7955D17], 0x100000],
};
