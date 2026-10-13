// Yamaha YM2151 (OPM): eight 4-operator FM channels, an LFO for vibrato and
// tremolo, a noise generator on the last operator of channel 8, and two
// timers whose overflow interrupts usually drive the sound CPU's music
// clock (CPS-1, System 16, Irem M72 and many more).
//
// Registers: 01 test/LFO reset; 08 key on (bits 0-2 channel, 3-6 operators
// M1 C1 M2 C2); 0F noise; 10-12 timer A (10 bits) and B; 14 timer control;
// 18 LFO rate; 19 AM/PM depth; 1B LFO waveform; 20-27 output/feedback/
// algorithm; 28-2F key code (octave and note); 30-37 key fraction; 38-3F
// PM/AM sensitivity; 40-FF operator settings (+ channel, + 8 per operator in
// the order M1 M2 C1 C2): 40 detune/multiple, 60 total level, 80 key scale/
// attack, A0 AM enable/decay 1, C0 detune 2/decay 2, E0 sustain level/release.
//
// Like the YM2203 here, this follows the chip's documented behavior rather
// than its internal arithmetic.

import { RATE } from './mixer.js';
import { capture, apply } from './state.js';

const SINE = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((i / 4096) * Math.PI * 2));
const ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4, OFF = 0;
const FALL_TIME = (r) => (r < 4 ? Infinity : 10.6 / Math.pow(2, (r - 4) / 4));
// Note codes (0-15, four unused) in semitones above the octave's C#.
const NOTE = [0, 1, 2, 2, 3, 4, 5, 5, 6, 7, 8, 8, 9, 10, 11, 11];
const DT2_CENTS = [0, 600, 781, 950];
const PMS_CENTS = [0, 5, 10, 20, 50, 100, 400, 700];
const AMS_DB = [0, 23.9, 47.8, 95.6];
// Operator register slots (M1, M2, C1, C2) to positions in the algorithm order (M1, C1, M2, C2).
const SLOT_POS = [0, 2, 1, 3];

function makeOp() {
  return { dt1: 0, mul: 1, tl: 0, ks: 0, ar: 0, d1r: 0, d2r: 0, d1l: 0, rr: 0, dt2: 0, amOn: 0, phase: 0, att: 96, stage: OFF };
}

const STATE = ['addr', 'ch', 'lfoRate', 'pmd', 'amd', 'wave', 'lfoPhase', 'noiseCtl', 'noise', 'noisePhase',
  'timerA', 'timerB', 'countA', 'countB', 'timerCtl', 'status'];

export class YM2151 {
  constructor(clock, gain = 1) {
    this.clock = clock;
    this.gain = gain;
    this.reset();
  }

  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.addr = 0;
    this.ch = Array.from({ length: 8 }, () => ({ kc: 0, kf: 0, fb: 0, alg: 0, out: 0, pms: 0, ams: 0, ops: [makeOp(), makeOp(), makeOp(), makeOp()], fb1: 0, fb2: 0 }));
    this.lfoRate = 0; this.pmd = 0; this.amd = 0; this.wave = 0; this.lfoPhase = 0;
    this.noiseCtl = 0; this.noise = 1; this.noisePhase = 0;
    this.timerA = 0; this.timerB = 0; this.countA = 0; this.countB = 0; this.timerCtl = 0; this.status = 0;
    this.out = 0;
  }

  get irq() { return (this.status & 3) !== 0; }

  select(v) { this.addr = v & 0xFF; }
  read() { return this.status; }

  write(v) {
    const r = this.addr;
    if (r < 0x20) {
      switch (r) {
        case 0x01: if (v & 2) this.lfoPhase = 0; break;
        case 0x08: {
          const c = this.ch[v & 7];
          for (let i = 0; i < 4; i++) {
            const op = c.ops[i], on = (v >> (3 + i)) & 1;
            if (on && (op.stage === OFF || op.stage === RELEASE)) { op.stage = ATTACK; op.phase = 0; }
            else if (!on && op.stage !== OFF) op.stage = RELEASE;
          }
          break;
        }
        case 0x0F: this.noiseCtl = v; break;
        case 0x10: this.timerA = (this.timerA & 3) | (v << 2); break;
        case 0x11: this.timerA = (this.timerA & 0x3FC) | (v & 3); break;
        case 0x12: this.timerB = v; break;
        case 0x14:
          // Bits 0-1 start the timers (loading their periods), 2-3 enable their interrupts, 4-5 clear their flags.
          if ((v & 1) && !(this.timerCtl & 1)) this.countA = 64 * (1024 - this.timerA) / this.clock;
          if ((v & 2) && !(this.timerCtl & 2)) this.countB = 1024 * (256 - this.timerB) / this.clock;
          if (v & 0x10) this.status &= ~1;
          if (v & 0x20) this.status &= ~2;
          this.timerCtl = v & 0x0F;
          break;
        case 0x18: this.lfoRate = v; break;
        case 0x19: if (v & 0x80) this.pmd = v & 0x7F; else this.amd = v & 0x7F; break;
        case 0x1B: this.wave = v & 3; if (this.onPort) this.onPort(v >> 6); break;   // bits 6-7: the CT1/CT2 output pins
      }
      return;
    }
    const c = this.ch[r & 7];
    if (r < 0x40) {
      switch (r & 0xF8) {
        case 0x20: c.out = v >> 6; c.fb = (v >> 3) & 7; c.alg = v & 7; break;
        case 0x28: c.kc = v & 0x7F; break;
        case 0x30: c.kf = v >> 2; break;
        case 0x38: c.pms = (v >> 4) & 7; c.ams = v & 3; break;
      }
      return;
    }
    const op = c.ops[SLOT_POS[(r >> 3) & 3]];
    switch (r & 0xE0) {
      case 0x40: op.dt1 = (v >> 4) & 7; op.mul = v & 15 ? v & 15 : 0.5; break;
      case 0x60: op.tl = v & 0x7F; break;
      case 0x80: op.ks = v >> 6; op.ar = v & 0x1F; break;
      case 0xA0: op.amOn = v >> 7; op.d1r = v & 0x1F; break;
      case 0xC0: op.dt2 = v >> 6; op.d2r = v & 0x1F; break;
      case 0xE0: op.d1l = v >> 4; op.rr = v & 15; break;
    }
  }

  // Advance the timers by `dt` seconds (the board calls this as the sound CPU runs).
  timers(dt) {
    if (this.timerCtl & 1) {
      this.countA -= dt;
      while (this.countA <= 0) { this.countA += 64 * (1024 - this.timerA) / this.clock; if (this.timerCtl & 4) this.status |= 1; }
    }
    if (this.timerCtl & 2) {
      this.countB -= dt;
      while (this.countB <= 0) { this.countB += 1024 * (256 - this.timerB) / this.clock; if (this.timerCtl & 8) this.status |= 2; }
    }
  }

  sample() {
    const dt = 1 / RATE, scale = this.clock / 3579545;
    // LFO: 0.008 Hz to about 53 Hz.
    this.lfoPhase = (this.lfoPhase + 0.008 * Math.pow(2, this.lfoRate * 12.69 / 255) * scale * dt) % 1;
    const p = this.lfoPhase;
    let pmWave, amWave;
    switch (this.wave) {
      case 0: amWave = 1 - p; pmWave = p < 0.5 ? 2 * p : 2 * p - 2; break;
      case 1: amWave = p < 0.5 ? 1 : 0; pmWave = p < 0.5 ? 1 : -1; break;
      case 2: amWave = p < 0.5 ? 1 - 2 * p : 2 * p - 1; pmWave = p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4; break;
      default: amWave = (this.noise & 0xFF) / 255; pmWave = amWave * 2 - 1;
    }
    // Noise: a 17-bit LFSR clocked at a rate set by register 0F.
    this.noisePhase += (this.clock / 64 / (32 - (this.noiseCtl & 31) || 1)) * dt;
    while (this.noisePhase >= 1) {
      this.noisePhase -= 1;
      this.noise = (this.noise >>> 1) | ((((this.noise) ^ (this.noise >> 3)) & 1) << 16);
    }
    let mix = 0;
    for (let n = 0; n < 8; n++) {
      const c = this.ch[n];
      if (!c.out) { for (const o of c.ops) this.envelope(o, c.kc >> 2, dt); continue; }
      const octave = (c.kc >> 4) & 7, semis = NOTE[c.kc & 15] + c.kf / 64;
      const pmCents = PMS_CENTS[c.pms] * pmWave * (this.pmd / 127);
      const amDb = AMS_DB[c.ams] * amWave * (this.amd / 127);
      const o = c.ops;
      for (let i = 0; i < 4; i++) this.envelope(o[i], c.kc >> 2, dt);
      const op = (k, mod) => {
        const q = o[k];
        const cents = 100 * (semis - 8) + DT2_CENTS[q.dt2] + pmCents;
        let f = 440 * Math.pow(2, octave - 4 + cents / 1200) * scale;
        if (q.dt1 & 3) f += (q.dt1 & 4 ? -1 : 1) * (q.dt1 & 3) * 0.0015 * f;
        q.phase = (q.phase + f * q.mul * dt) % 1;
        if (q.stage === OFF) return 0;
        const att = q.att + q.tl * 0.75 + (q.amOn ? amDb : 0);
        if (att > 90) return 0;
        const amp = Math.pow(10, -att / 20);
        if (n === 7 && k === 3 && (this.noiseCtl & 0x80)) return (this.noise & 1 ? amp : -amp) * 0.5;
        return SINE[((q.phase * 4096 + mod * 652) & 4095)] * amp;   // mod in radians
      };
      const fbIn = c.fb ? (c.fb1 + c.fb2) * Math.PI * Math.pow(2, c.fb - 7) : 0;
      const m1 = op(0, fbIn);
      c.fb2 = c.fb1; c.fb1 = m1;
      const M = 4 * Math.PI;
      let out;
      switch (c.alg) {
        case 0: { const c1 = op(1, m1 * M), m2 = op(2, c1 * M); out = op(3, m2 * M); break; }
        case 1: { const c1 = op(1, 0), m2 = op(2, (m1 + c1) * M); out = op(3, m2 * M); break; }
        case 2: { const c1 = op(1, 0), m2 = op(2, c1 * M); out = op(3, (m1 + m2) * M); break; }
        case 3: { const c1 = op(1, m1 * M), m2 = op(2, 0); out = op(3, (c1 + m2) * M); break; }
        case 4: { const c1 = op(1, m1 * M), m2 = op(2, 0); out = c1 + op(3, m2 * M); break; }
        case 5: out = op(1, m1 * M) + op(2, m1 * M) + op(3, m1 * M); break;
        case 6: out = op(1, m1 * M) + op(2, 0) + op(3, 0); break;
        default: out = m1 + op(1, 0) + op(2, 0) + op(3, 0);
      }
      mix += out;
    }
    this.out = mix * 0.2 * this.gain;
  }

  // Attenuation in dB, moved along by the current stage's rate.
  envelope(p, keycode, dt) {
    if (p.stage === OFF) return;
    const ksr = keycode >> (3 - p.ks);
    const rate = (r) => (r ? Math.min(63, 2 * r + ksr) : 0);
    if (p.stage === ATTACK) {
      const r = rate(p.ar);
      if (r >= 62) { p.att = 0; p.stage = DECAY; return; }
      const t = FALL_TIME(r) / 8;
      if (t === Infinity) return;
      p.att -= (p.att + 4) * (dt / t) * 4;
      if (p.att <= 0) { p.att = 0; p.stage = DECAY; }
      return;
    }
    const sl = p.d1l === 15 ? 93 : p.d1l * 3;
    const r = p.stage === DECAY ? rate(p.d1r) : p.stage === SUSTAIN ? rate(p.d2r) : Math.min(63, 4 * p.rr + 2 + ksr);
    const t = FALL_TIME(r);
    if (t !== Infinity) p.att += (96 * dt) / t;
    if (p.stage === DECAY && p.att >= sl) { p.att = sl; p.stage = SUSTAIN; }
    if (p.att >= 96) { p.att = 96; if (p.stage === RELEASE) p.stage = OFF; }
  }
}
