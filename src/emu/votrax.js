// Votrax SC-01 speech chip (Gorf, Wizard of Wor, Q*bert), approximated: the
// host sends phonemes one at a time (6 bits, plus 2 bits of inflection) and
// waits for the chip to be ready for the next. The real chip is an analog
// formant synthesizer whose internals are only partly documented; this
// models the same idea from published phonetics instead of the chip's own
// parameter ROM: each phoneme is a target for three vocal-tract resonances,
// voicing, and frication noise, held for the phoneme's documented duration,
// with the parameters gliding from one phoneme to the next.

import { capture, apply } from './state.js';
import { RATE } from './mixer.js';

// [name, duration ms, kind, F1, F2, F3, noise center Hz, level]. The formants
// and levels of the vowels, glides and nasals were measured (LPC) from
// recordings of the real chip in Gorf; the consonants are textbook values.
// Kinds: v vowel, a approximant, n nasal, f voiceless fricative, z voiced
// fricative, p voiceless stop, b voiced stop, h aspiration, x silence.
const PHONEMES = [
  ['EH3', 59, 'v', 592, 1905, 2644, 0, 0.315], ['EH2', 71, 'v', 458, 2180, 2750, 0, 0.268], ['EH1', 121, 'v', 608, 1903, 2645, 0, 0.354], ['PA0', 47, 'x', 0, 0, 0, 0, 0.3],
  ['DT', 47, 'b', 300, 1700, 2600, 3500, 0.2], ['A1', 71, 'v', 482, 2301, 2782, 0, 0.352], ['A2', 103, 'v', 517, 2209, 2696, 0, 0.309], ['ZH', 90, 'z', 300, 1800, 2500, 2500, 0.12],
  ['AH2', 71, 'v', 667, 1416, 2725, 0, 0.372], ['I3', 55, 'v', 431, 2310, 2815, 0, 0.244], ['I2', 80, 'v', 470, 2200, 2780, 0, 0.26], ['I1', 121, 'v', 494, 2099, 2741, 0, 0.275],
  ['M', 103, 'n', 334, 1978, 2753, 0, 0.129], ['N', 80, 'n', 366, 2788, 4435, 0, 0.149], ['B', 71, 'b', 250, 800, 2200, 900, 0.25], ['V', 71, 'z', 300, 1100, 2400, 5000, 0.07],
  ['CH', 71, 'f', 300, 1800, 2500, 2800, 0.07], ['SH', 121, 'f', 300, 1800, 2500, 2500, 0.154], ['Z', 71, 'z', 300, 1600, 2600, 5500, 0.052], ['AW1', 146, 'v', 749, 1156, 2762, 0, 0.464],
  ['NG', 121, 'n', 346, 2602, 4511, 0, 0.136], ['AH1', 146, 'v', 777, 1325, 2807, 0, 0.413], ['OO1', 103, 'v', 536, 1293, 2417, 0, 0.398], ['OO', 185, 'v', 536, 1293, 2417, 0, 0.398],
  ['L', 103, 'a', 521, 1202, 2990, 0, 0.263], ['K', 80, 'p', 300, 1900, 2500, 2000, 0.3], ['J', 47, 'z', 300, 1800, 2500, 2600, 0.2], ['H', 71, 'h', 600, 1500, 2500, 0, 0.233],
  ['G', 71, 'b', 250, 1900, 2400, 1800, 0.25], ['F', 103, 'f', 300, 1100, 2400, 6000, 0.07], ['D', 55, 'b', 300, 1700, 2600, 3800, 0.17], ['S', 90, 'f', 300, 1600, 2600, 5500, 0.175],
  ['A', 185, 'v', 521, 2211, 2688, 0, 0.314], ['AY', 65, 'v', 392, 2422, 2930, 0, 0.194], ['Y1', 80, 'a', 380, 2305, 2809, 0, 0.172], ['UH3', 47, 'v', 562, 1391, 2829, 0, 0.332],
  ['AH', 250, 'v', 777, 1325, 2807, 0, 0.413], ['P', 103, 'p', 300, 800, 2200, 900, 0.25], ['O', 185, 'v', 582, 1007, 2704, 0, 0.352], ['I', 185, 'v', 493, 2125, 2781, 0, 0.363],
  ['U', 185, 'v', 396, 1056, 2506, 0, 0.405], ['Y', 103, 'v', 386, 2411, 2819, 0, 0.164], ['T', 71, 'p', 300, 1700, 2600, 4000, 0.16], ['R', 90, 'a', 524, 1465, 2127, 0, 0.307],
  ['E', 185, 'v', 397, 2453, 2922, 0, 0.308], ['W', 80, 'a', 463, 1021, 2476, 0, 0.294], ['AE', 185, 'v', 723, 1987, 2619, 0, 0.356], ['AE1', 103, 'v', 692, 1979, 2663, 0, 0.341],
  ['AW2', 90, 'v', 760, 1160, 2770, 0, 0.46], ['UH2', 71, 'v', 600, 1380, 2700, 0, 0.3], ['UH1', 103, 'v', 687, 1328, 2627, 0, 0.335], ['UH', 185, 'v', 696, 1305, 2944, 0, 0.398],
  ['O2', 80, 'v', 544, 1049, 2796, 0, 0.308], ['O1', 121, 'v', 585, 1106, 2393, 0, 0.438], ['IU', 59, 'v', 458, 1985, 2734, 0, 0.23], ['U1', 90, 'v', 404, 1022, 2587, 0, 0.309],
  ['THV', 80, 'z', 300, 1300, 2500, 4500, 0.064], ['TH', 71, 'f', 300, 1300, 2500, 4500, 0.084], ['ER', 146, 'v', 534, 1475, 1870, 0, 0.391], ['EH', 185, 'v', 610, 1901, 2666, 0, 0.34],
  ['E1', 121, 'v', 390, 2446, 2909, 0, 0.187], ['AW', 250, 'v', 780, 1171, 2782, 0, 0.475], ['PA1', 185, 'x', 0, 0, 0, 0, 0.3], ['STOP', 47, 'x', 0, 0, 0, 0, 0.3],
];

// Per kind: voicing amplitude, noise amplitude through the tract, frication amplitude.
const KIND = {
  v: [1, 0, 0], a: [0.75, 0, 0], n: [0.9, 0, 0], f: [0, 0, 0.55], z: [0.45, 0, 0.3],
  p: [0, 0, 0.6], b: [0.4, 0, 0.35], h: [0, 0.6, 0.1], x: [0, 0, 0],
};

const STATE = ['phoneme', 'inflection', 'remaining', 'cur', 'res', 'pitchPhase', 'glottal', 'rng', 'acc', 'lp1', 'lp2', 'out'];

const BANDWIDTH = [80, 100, 120, 250];

// The voice path's gain at a phoneme's first formant (source tilt times the
// four resonators); each voiced phoneme is scaled by its inverse so loudness
// follows the measured levels rather than the filter arithmetic.
function chainGain(f, formants) {
  let g = 1 / Math.hypot(1, f / 155);                    // the source's low-pass
  formants.forEach((fc, i) => {
    const bw = BANDWIDTH[i], w = 2 * Math.PI * f / RATE, r = Math.exp(-Math.PI * bw / RATE), th = 2 * Math.PI * fc / RATE;
    const re = 1 - 2 * r * Math.cos(th) * Math.cos(w) + r * r * Math.cos(2 * w);
    const im = 2 * r * Math.cos(th) * Math.sin(w) - r * r * Math.sin(2 * w);
    g *= (2 * (1 - r)) / Math.hypot(re, im);
  });
  return g;
}
const REF_GAIN = chainGain(777, [777, 1325, 2807, 3600]);   // AH1
const VOICE_NORM = PHONEMES.map((p) => (p[2] === 'x' ? 1 : REF_GAIN / chainGain(p[3], [p[3], p[4], p[5], 3600])));
const FRICATION = 0.025;                                   // hiss against the vowels: S about 0.4 of a vowel, as measured

// A two-pole resonator's coefficients for a center frequency and bandwidth.
function coeffs(f, bw) {
  const r = Math.exp(-Math.PI * bw / RATE);
  return [2 * r * Math.cos(2 * Math.PI * f / RATE), -r * r, 1 - r];
}

export class Votrax {
  constructor(gain = 1) { this.gain = gain; this.reset(); }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.phoneme = 63; this.inflection = 0; this.remaining = 0;
    // Current (gliding) parameters: F1, F2, F3, voice, aspiration, frication, noise center.
    this.cur = new Float64Array([500, 1500, 2500, 0, 0, 0, 3000]);
    this.res = new Float64Array(10);            // resonator histories (4 tract + 1 frication) x 2
    this.pitchPhase = 0; this.rng = 0x1234; this.acc = 0; this.out = 0;
    this.lp1 = this.lp2 = 0; this.glottal = 0; this.voiceNorm = 1;
    this.lpK = 1 - Math.exp(-2 * Math.PI * 5000 / RATE);
    this.norm = 32;                            // brings vowels to about 0.6
  }

  // Ready for the next phoneme once the current one has run its length.
  ready() { return this.remaining <= 0; }

  write(v) {
    this.phoneme = v & 0x3F;
    this.inflection = v >> 6;
    this.remaining = Math.round(PHONEMES[this.phoneme][1] * RATE / 1000);
    this.voiceNorm = VOICE_NORM[this.phoneme];
  }

  sample() {
    const p = PHONEMES[this.phoneme], kind = p[2];
    const [voice, asp, fric] = KIND[kind];
    const elapsed = Math.round(p[1] * RATE / 1000) - this.remaining;
    if (this.remaining > 0) this.remaining--;
    const cur = this.cur;
    // Stops: silent closure for the first half, then the burst.
    let v = voice, f = fric;
    if (kind === 'p' || kind === 'b') {
      const closure = elapsed < p[1] * RATE / 2000;
      if (closure) { v = kind === 'b' ? 0.15 : 0; f = 0; } else f = fric * Math.max(0, 1 - (elapsed - p[1] * RATE / 2000) / (0.03 * RATE));
    }
    // Loudness per phoneme (vowels around 0.35 on the measured scale).
    const lv = p[7] / 0.35;
    v *= lv * this.voiceNorm;
    f *= lv * FRICATION;
    // Glide toward the target: about 12 ms for the formants, 6 ms for the sources.
    const kF = 1 / (0.012 * RATE), kA = 1 / (0.006 * RATE);
    if (kind !== 'x') for (let i = 0; i < 3; i++) cur[i] += (p[3 + i] - cur[i]) * kF;
    cur[3] += (v - cur[3]) * kA;
    cur[4] += (asp - cur[4]) * kA;
    cur[5] += (f - cur[5]) * kA;
    if (p[6]) cur[6] = p[6];
    // Sources: a glottal pulse train (pitch rises with inflection) and white noise.
    const f0 = 118 * (1 + 0.06 * this.inflection);     // the real chip speaks around 120 Hz
    // The voice source: a pulse each pitch period through a gentle low-pass
    // (about -6 dB an octave overall), as in standard formant synthesis.
    this.pitchPhase += f0 / RATE;
    let pulse = 0;
    if (this.pitchPhase >= 1) { this.pitchPhase -= 1; pulse = 1; }
    this.glottal = this.glottal * 0.98 + pulse;
    const glottal = this.glottal - 0.05;
    this.rng = (this.rng * 1103515245 + 12345) >>> 0;
    const noise = ((this.rng >>> 16) & 0xFFFF) / 32768 - 1;
    // The vocal tract: three resonators in series.
    let x = glottal * cur[3] + noise * cur[4] * 0.5;
    const res = this.res;
    for (let i = 0; i < 4; i++) {
      const [a1, a2, g] = coeffs(i < 3 ? cur[i] : 3600, BANDWIDTH[i]);   // plus a fixed fourth formant
      const y = g * 2 * x + a1 * res[i * 2] + a2 * res[i * 2 + 1];
      res[i * 2 + 1] = res[i * 2]; res[i * 2] = y;
      x = y;
    }
    // Frication: noise through one wide resonance, added after the tract.
    const [b1, b2, gf] = coeffs(cur[6], cur[6] * 0.35);
    const yf = gf * 2 * noise * cur[5] + b1 * res[8] + b2 * res[9];
    res[9] = res[8]; res[8] = yf;
    // The chip's output is band-limited (its filters run at a few tens of kHz): one pole at about 5 kHz.
    const k = this.lpK;
    this.lp1 += (x * 0.9 + yf * 1.4 - this.lp1) * k;
    this.out = Math.max(-1, Math.min(1, this.lp1 * this.norm)) * this.gain;
  }
}
