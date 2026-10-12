// Yamaha YM2203 (OPN): three 4-operator FM channels plus an SSG (an
// AY-3-8910-compatible tone and noise generator) on one chip. Used by
// Ghosts'n Goblins, 1943, Commando and many mid-80s boards.
//
// FM: each channel's four operators are sine oscillators (frequency from the
// channel's F-number and block, times the operator's multiple), shaped by an
// attack / decay / sustain / release envelope and a total level, and wired
// together by one of eight algorithms; operator 1 can feed back into itself.
//
// Registers: 00-0F SSG; 27 mode/timers; 28 key on/off (bits 0-1 channel,
// 4-7 operators); 30-9F operator settings (register + channel + slot offset
// 0/4/8/C for operators 1/3/2/4): 30 detune/multiple, 40 total level, 50 key
// scale/attack, 60 decay, 70 sustain rate, 80 sustain level/release;
// A0-A2 F-number low, A4-A6 block / F-number high, B0-B2 feedback/algorithm.
//
// This is modeled from the chip's documented behavior, not cycle for cycle;
// envelope rates follow the published timings (each 4 rate steps doubles
// the speed).

import { AY8910 } from './ay8910.js';
import { RATE } from './mixer.js';
import { capture, apply } from './state.js';

const SINE = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((i / 4096) * Math.PI * 2));
const TWO_PI = Math.PI * 2;
const SLOT_OF = [0, 2, 1, 3];                 // register offset 0/4/8/C -> operators 1, 3, 2, 4
const ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4, OFF = 0;

// Seconds for an envelope to fall by the full 96 dB at a rate of 0-63 (each
// 4 steps doubles the speed; rates below 4 hardly move).
const FALL_TIME = (r) => (r < 4 ? Infinity : 10.6 / Math.pow(2, (r - 4) / 4));

function makeOp() {
  return { dt: 0, mul: 1, tl: 0, ks: 0, ar: 0, dr: 0, sr: 0, sl: 0, rr: 0, phase: 0, att: 96, stage: OFF, out: 0 };
}

export class YM2203 {
  constructor(clock, gain = 1) {
    this.clock = clock;
    this.gain = gain;
    this.ssg = new AY8910(clock / 4, () => 0xFF, 1);   // the SSG runs at a quarter of the input clock
    this.reset();
  }

  saveState() { return { fm: capture(this, ['addr', 'ch']), ssg: this.ssg.saveState() }; }
  loadState(s) { apply(this, ['addr', 'ch'], s.fm); this.ssg.loadState(s.ssg); }

  reset() {
    this.addr = 0;
    this.ch = [0, 1, 2].map(() => ({ fnum: 0, block: 0, fb: 0, alg: 0, ops: [makeOp(), makeOp(), makeOp(), makeOp()], fb1: 0, fb2: 0 }));
    this.ssg.reset();
    this.out = 0;
  }

  select(v) { this.addr = v & 0xFF; }
  status() { return 0; }                     // never busy, timers unused
  read() { return this.addr < 16 ? (this.ssg.select(this.addr), this.ssg.read()) : 0; }

  write(v) {
    const r = this.addr;
    if (r < 0x10) { this.ssg.select(r); this.ssg.write(v); return; }
    if (r === 0x28) {                        // key on/off
      const c = this.ch[v & 3];
      if (!c) return;
      for (let i = 0; i < 4; i++) {
        const op = c.ops[i], on = (v >> (4 + i)) & 1;
        if (on && (op.stage === OFF || op.stage === RELEASE)) { op.stage = ATTACK; op.phase = 0; }
        else if (!on && op.stage !== OFF) op.stage = RELEASE;
      }
      return;
    }
    if (r >= 0x30 && r < 0xA0) {
      const chn = r & 3;
      if (chn === 3) return;
      const op = this.ch[chn].ops[SLOT_OF[(r >> 2) & 3]];
      switch (r & 0xF0) {
        case 0x30: op.dt = (v >> 4) & 7; op.mul = v & 15 ? v & 15 : 0.5; break;
        case 0x40: op.tl = v & 0x7F; break;
        case 0x50: op.ks = v >> 6; op.ar = v & 0x1F; break;
        case 0x60: op.dr = v & 0x1F; break;
        case 0x70: op.sr = v & 0x1F; break;
        case 0x80: op.sl = v >> 4; op.rr = v & 15; break;
      }
      return;
    }
    const chn = r & 3;
    if (chn === 3) return;
    const c = this.ch[chn];
    if (r >= 0xA0 && r < 0xA3) c.fnum = (c.fnum & 0x700) | v;
    else if (r >= 0xA4 && r < 0xA7) { c.fnum = (c.fnum & 0xFF) | ((v & 7) << 8); c.block = (v >> 3) & 7; }
    else if (r >= 0xB0 && r < 0xB3) { c.fb = (v >> 3) & 7; c.alg = v & 7; }
  }

  // One output sample at RATE.
  sample() {
    const dt = 1 / RATE, fs = this.clock / 72;
    let fm = 0;
    for (const c of this.ch) {
      // Base frequency: F-number x 2^(block-1) x (FM sample rate) / 2^20.
      const base = (c.fnum * Math.pow(2, c.block - 1) * fs) / 1048576;
      const keycode = (c.block << 2) | ((c.fnum >> 10) & 1) << 1 | ((c.fnum >> 9) & 1);
      const o = c.ops;
      for (let i = 0; i < 4; i++) this.envelope(o[i], keycode, dt);
      // Operator 1 with feedback, then the algorithm's connections.
      const fbIn = c.fb ? (c.fb1 + c.fb2) * Math.PI * 2 * Math.pow(2, c.fb - 7) : 0;
      const op = (k, mod) => {
        const p = o[k];
        p.phase = (p.phase + base * p.mul * dt) % 1;
        if (p.stage === OFF) return 0;
        const amp = Math.pow(10, -(p.att + p.tl * 0.75) / 20);
        if (amp < 1e-4) return 0;
        return SINE[((p.phase * 4096 + (mod / TWO_PI) * 4096) & 4095)] * amp;
      };
      const o1 = op(0, fbIn);
      c.fb2 = c.fb1; c.fb1 = o1;
      const M = 4 * Math.PI;                 // full-scale modulation: two cycles either way
      let out;
      switch (c.alg) {
        case 0: { const o2 = op(1, o1 * M), o3 = op(2, o2 * M); out = op(3, o3 * M); break; }
        case 1: { const o2 = op(1, 0), o3 = op(2, (o1 + o2) * M); out = op(3, o3 * M); break; }
        case 2: { const o2 = op(1, 0), o3 = op(2, o2 * M); out = op(3, (o1 + o3) * M); break; }
        case 3: { const o2 = op(1, o1 * M), o3 = op(2, 0); out = op(3, (o2 + o3) * M); break; }
        case 4: { const o2 = op(1, o1 * M), o3 = op(2, 0); out = o2 + op(3, o3 * M); break; }
        case 5: out = op(1, o1 * M) + op(2, o1 * M) + op(3, o1 * M); break;
        case 6: out = op(1, o1 * M) + op(2, 0) + op(3, 0); break;
        default: out = o1 + op(1, 0) + op(2, 0) + op(3, 0);
      }
      fm += out;
    }
    this.ssg.sample();
    this.out = (fm * 0.25 + this.ssg.out * 0.5) * this.gain;
  }

  // Attenuation in dB, moved along by the current stage's rate.
  envelope(p, keycode, dt) {
    if (p.stage === OFF) return;
    const ksr = keycode >> (3 - p.ks);
    const rate = (r) => (r ? Math.min(63, 2 * r + ksr) : 0);
    if (p.stage === ATTACK) {
      const r = rate(p.ar);
      if (r >= 62) { p.att = 0; p.stage = DECAY; return; }
      // Attack is exponential and much quicker than the falls.
      const t = FALL_TIME(r) / 8;
      p.att -= (p.att + 4) * (dt / t) * 4;
      if (p.att <= 0) { p.att = 0; p.stage = DECAY; }
      return;
    }
    const sl = p.sl === 15 ? 96 : p.sl * 3;
    const r = p.stage === DECAY ? rate(p.dr) : p.stage === SUSTAIN ? rate(p.sr) : Math.min(63, 4 * p.rr + 2 + ksr);
    const t = FALL_TIME(r);
    if (t !== Infinity) p.att += (96 * dt) / t;
    if (p.stage === DECAY && p.att >= sl) { p.att = sl; p.stage = SUSTAIN; }
    if (p.att >= 96) { p.att = 96; if (p.stage === RELEASE) p.stage = OFF; }
  }
}
