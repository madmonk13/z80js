// Yamaha YM3812 (OPL2): nine 2-operator FM channels, or six plus five
// rhythm voices. Used by Tecmo (Silkworm, Rygar), Data East (RoboCop) and
// many late-80s boards, often beside a YM2203.
//
// Each channel's two operators are oscillators (one of four waveforms: sine,
// half sine, absolute sine, quarter pulses) shaped by an attack / decay /
// sustain / release envelope; operator 1 either modulates operator 2 or is
// mixed beside it, and can feed back into itself. Optional tremolo (3.7 Hz)
// and vibrato (6.1 Hz) per operator.
//
// Registers: 01 waveform enable (bit 5); 02/03 timers; 04 timer control;
// 08 note select; 20-35 tremolo/vibrato/sustain/key scale rate/multiple;
// 40-55 key scale level/total level; 60-75 attack/decay; 80-95 sustain
// level/release; A0-A8 F-number low; B0-B8 key on/block/F-number high;
// BD tremolo/vibrato depth, rhythm mode and drum keys; C0-C8 feedback and
// connection; E0-F5 waveform. Operator registers are numbered by slot
// offsets 00-05, 08-0D, 10-15.
//
// Modeled from the chip's documented behavior (rates, levels, tables), not
// cycle for cycle. The rhythm voices are approximations.

import { RATE } from './mixer.js';
import { capture, apply } from './state.js';

const N = 4096, TWO_PI = Math.PI * 2;
const WAVES = [0, 1, 2, 3].map((w) => Float32Array.from({ length: N }, (_, i) => {
  const s = Math.sin((i / N) * TWO_PI);
  if (w === 0) return s;
  if (w === 1) return s > 0 ? s : 0;
  if (w === 2) return Math.abs(s);
  return (i & (N / 2 - 1)) < N / 4 ? Math.abs(s) : 0;    // rising quarters only
}));
const MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
// Key scale level at block 7, by the top four F-number bits (dB).
const KSL_DB = [0, 9, 12, 13.875, 15, 16.125, 16.875, 17.625, 18, 18.75, 19.125, 19.5, 19.875, 20.25, 20.625, 21];
const KSL_SCALE = [0, 0.5, 0.25, 1];
// Register offset (00-15) -> [channel, operator], or null.
const SLOT = Array.from({ length: 0x16 }, (_, o) => {
  const col = o & 7, row = o >> 3;
  if (col > 5) return null;
  return [row * 3 + (col % 3), col < 3 ? 0 : 1];
});
const ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4, OFF = 0;
// Seconds for a full 96 dB fall, and for a full attack, at envelope rate r (0-63).
const FALL = (r) => (r < 4 ? Infinity : 39.28 / Math.pow(2, (r - 4) / 4));
const RISE = (r) => (r < 4 ? Infinity : 2.826 / Math.pow(2, (r - 4) / 4));

function makeOp() {
  return { am: 0, vib: 0, egt: 0, ksr: 0, mul: 1, ksl: 0, tl: 0, ar: 0, dr: 0, sl: 0, rr: 0, wave: 0,
    phase: 0, att: 96, stage: OFF, key: 0 };
}
const STATE = ['addr', 'regs', 'ch', 'waveEnable', 'nts', 'depthAm', 'depthVib', 'rhythm', 'drums', 't1', 't2', 'count1',
  'count2', 'timerCtl', 'flags', 'lfoAm', 'lfoVib', 'noise'];

export class YM3812 {
  constructor(clock, gain = 1) {
    this.clock = clock;
    this.gain = gain;
    this.reset();
  }
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  reset() {
    this.addr = 0;
    this.regs = new Uint8Array(256);
    this.ch = Array.from({ length: 9 }, () => ({ fnum: 0, block: 0, key: 0, fb: 0, con: 0, ops: [makeOp(), makeOp()], fb1: 0, fb2: 0 }));
    this.waveEnable = 0; this.nts = 0; this.depthAm = 0; this.depthVib = 0; this.rhythm = 0; this.drums = 0;
    this.t1 = 0; this.t2 = 0; this.count1 = 0; this.count2 = 0; this.timerCtl = 0; this.flags = 0;
    this.lfoAm = 0; this.lfoVib = 0; this.noise = 1;
    this.out = 0;
  }

  select(v) { this.addr = v & 0xFF; }
  // Status: bit 7 an interrupt, bit 6 timer 1, bit 5 timer 2.
  status() { return this.flags ? 0x80 | this.flags : 0; }
  get irq() { return this.flags !== 0; }

  // Timer 1 counts 288 clocks a step from its 8-bit value, timer 2 1152.
  period1() { return (288 * (256 - this.t1)) / this.clock; }
  period2() { return (1152 * (256 - this.t2)) / this.clock; }
  timers(dt) {
    if (this.timerCtl & 1) {
      this.count1 -= dt;
      while (this.count1 <= 0) { this.count1 += this.period1(); if (!(this.timerCtl & 0x40)) this.flags |= 0x40; }
    }
    if (this.timerCtl & 2) {
      this.count2 -= dt;
      while (this.count2 <= 0) { this.count2 += this.period2(); if (!(this.timerCtl & 0x20)) this.flags |= 0x20; }
    }
  }

  write(v) {
    const r = this.addr;
    this.regs[r] = v;
    if (r === 0x01) { this.waveEnable = v & 0x20; return; }
    if (r === 0x02) { this.t1 = v; return; }
    if (r === 0x03) { this.t2 = v; return; }
    if (r === 0x04) {
      if (v & 0x80) { this.flags = 0; return; }        // reset the flags; the rest of the write is ignored
      if ((v & 1) && !(this.timerCtl & 1)) this.count1 = this.period1();
      if ((v & 2) && !(this.timerCtl & 2)) this.count2 = this.period2();
      this.timerCtl = v & 0x63;
      this.flags &= ~(v & 0x60);                       // masked timers can't raise a flag
      return;
    }
    if (r === 0x08) { this.nts = (v >> 6) & 1; return; }
    if (r >= 0x20 && r < 0xA0) {
      const s = SLOT[r & 0x1F];
      if (!s || (r & 0x1F) > 0x15) return;
      const op = this.ch[s[0]].ops[s[1]];
      switch (r & 0xE0) {
        case 0x20: op.am = v >> 7; op.vib = (v >> 6) & 1; op.egt = (v >> 5) & 1; op.ksr = (v >> 4) & 1; op.mul = MULT[v & 15]; break;
        case 0x40: op.ksl = v >> 6; op.tl = v & 0x3F; break;
        case 0x60: op.ar = v >> 4; op.dr = v & 15; break;
        case 0x80: op.sl = v >> 4; op.rr = v & 15; break;
      }
      return;
    }
    if (r >= 0xE0 && r < 0xF6) {
      const s = SLOT[r & 0x1F];
      if (s) this.ch[s[0]].ops[s[1]].wave = v & 3;
      return;
    }
    if (r === 0xBD) {
      this.depthAm = v >> 7; this.depthVib = (v >> 6) & 1; this.rhythm = (v >> 5) & 1;
      const old = this.drums;
      this.drums = this.rhythm ? v & 0x1F : 0;
      // Drum keys: 10 bass drum (ch 6), 08 snare (7.2), 04 tom (8.1), 02 cymbal (8.2), 01 hi-hat (7.1).
      const hit = this.drums & ~old, rel = old & ~this.drums;
      const each = (bit, ch, op) => {
        if (hit & bit) this.keyOn(this.ch[ch].ops[op]);
        if ((rel & bit) && !this.ch[ch].key) this.ch[ch].ops[op].stage = this.ch[ch].ops[op].stage === OFF ? OFF : RELEASE;
      };
      each(0x10, 6, 0); each(0x10, 6, 1); each(0x08, 7, 1); each(0x04, 8, 0); each(0x02, 8, 1); each(0x01, 7, 0);
      return;
    }
    const n = r & 0x0F;
    if (n > 8) return;
    const c = this.ch[n];
    if ((r & 0xF0) === 0xA0) c.fnum = (c.fnum & 0x300) | v;
    else if ((r & 0xF0) === 0xB0) {
      c.fnum = (c.fnum & 0xFF) | ((v & 3) << 8);
      c.block = (v >> 2) & 7;
      const key = (v >> 5) & 1;
      if (key && !c.key) { this.keyOn(c.ops[0]); this.keyOn(c.ops[1]); }
      else if (!key && c.key) for (const op of c.ops) if (op.stage !== OFF) op.stage = RELEASE;
      c.key = key;
    } else if ((r & 0xF0) === 0xC0) { c.fb = (v >> 1) & 7; c.con = v & 1; }
  }

  keyOn(op) { op.stage = ATTACK; op.phase = 0; }

  // One output sample at RATE.
  sample() {
    const dt = 1 / RATE, fs = this.clock / 72;
    this.lfoAm = (this.lfoAm + 3.7 * dt) % 1;
    this.lfoVib = (this.lfoVib + 6.1 * dt) % 1;
    const tri = this.lfoAm < 0.5 ? this.lfoAm * 2 : 2 - this.lfoAm * 2;
    const tremDb = tri * (this.depthAm ? 4.8 : 1);
    const vibMul = Math.pow(2, (Math.sin(this.lfoVib * TWO_PI) * (this.depthVib ? 14 : 7)) / 1200);
    for (let i = 0; i < 3; i++) {
      const bit = ((this.noise >> 22) ^ (this.noise >> 8)) & 1;   // 23-bit noise for the drums
      this.noise = ((this.noise << 1) | bit) & 0x7FFFFF;
    }
    const white = this.noise & 1 ? 1 : -1;
    let sum = 0;
    const last = this.rhythm ? 6 : 9;
    for (let n = 0; n < 9; n++) {
      const c = this.ch[n], o = c.ops;
      const base = (c.fnum * Math.pow(2, c.block) * fs) / 1048576;
      const keycode = (c.block << 1) | ((c.fnum >> (this.nts ? 8 : 9)) & 1);
      const kslDb = KSL_DB[c.fnum >> 6] - 6 * (7 - c.block);
      for (const op of o) {
        this.envelope(op, keycode, dt);
        op.phase = (op.phase + base * op.mul * (op.vib ? vibMul : 1) * dt) % 1;
      }
      if (n >= last) continue;
      const level = (op) => {
        if (op.stage === OFF) return 0;
        const db = op.att + op.tl * 0.75 + Math.max(0, kslDb) * KSL_SCALE[op.ksl] + (op.am ? tremDb : 0);
        return db >= 96 ? 0 : Math.pow(10, -db / 20);
      };
      const wave = (op, mod) => WAVES[this.waveEnable ? op.wave : 0][(op.phase * N + (mod / TWO_PI) * N) & (N - 1)];
      const a1 = level(o[0]);
      const fbIn = c.fb ? (c.fb1 + c.fb2) * Math.PI * Math.pow(2, c.fb - 7) : 0;
      const out1 = a1 ? wave(o[0], fbIn) * a1 : 0;
      c.fb2 = c.fb1; c.fb1 = out1;
      const a2 = level(o[1]);
      const out2 = a2 ? wave(o[1], c.con ? 0 : out1 * 4 * Math.PI) * a2 : 0;
      sum += c.con ? out1 + out2 : out2;
    }
    if (this.rhythm) sum += this.drumMix(white);
    this.out = sum * 0.22 * this.gain;
  }

  // Rhythm mode: the bass drum is channel 6 played twice as loud; the others
  // borrow channel 7 and 8's operators, mixing in noise and square tones.
  drumMix(white) {
    const c6 = this.ch[6], c7 = this.ch[7], c8 = this.ch[8];
    const lvl = (op) => (op.stage === OFF || op.att + op.tl * 0.75 >= 96 ? 0 : Math.pow(10, -(op.att + op.tl * 0.75) / 20));
    let s = 0;
    const b1 = lvl(c6.ops[0]), b2 = lvl(c6.ops[1]);
    if (b2) {
      const m = b1 ? WAVES[0][(c6.ops[0].phase * N) & (N - 1)] * b1 : 0;
      s += 2 * WAVES[0][(c6.ops[1].phase * N + (c6.con ? 0 : m * 2 * N)) & (N - 1)] * b2;
    }
    const sq = (p) => (p < 0.5 ? 1 : -1);
    const hh = lvl(c7.ops[0]);                          // hi-hat: metallic square pair plus noise
    if (hh) s += (sq(c7.ops[0].phase) * sq(c8.ops[1].phase) * 0.5 + white * 0.5) * hh;
    const sd = lvl(c7.ops[1]);                          // snare: tone plus noise
    if (sd) s += (WAVES[0][(c7.ops[0].phase * 2 * N) & (N - 1)] * 0.5 + white * 0.5) * sd;
    const tt = lvl(c8.ops[0]);                          // tom: plain sine
    if (tt) s += WAVES[0][(c8.ops[0].phase * N) & (N - 1)] * tt;
    const cy = lvl(c8.ops[1]);                          // cymbal: the metallic pair
    if (cy) s += sq(c7.ops[0].phase) * sq(c8.ops[1].phase) * 0.7 * cy;
    return s;
  }

  // Attenuation in dB, moved along by the current stage's rate.
  envelope(op, keycode, dt) {
    if (op.stage === OFF) return;
    const rof = op.ksr ? keycode : keycode >> 2;
    const rate = (r) => (r ? Math.min(63, 4 * r + rof) : 0);
    if (op.stage === ATTACK) {
      const r = rate(op.ar);
      if (r >= 60) { op.att = 0; op.stage = DECAY; return; }
      const t = RISE(r);
      if (t === Infinity) return;
      op.att -= (op.att + 6) * (dt / t) * 3.5;         // exponential rise toward full level
      if (op.att <= 0) { op.att = 0; op.stage = DECAY; }
      return;
    }
    const sl = op.sl === 15 ? 93 : op.sl * 3;
    let r;
    if (op.stage === DECAY) r = rate(op.dr);
    else if (op.stage === SUSTAIN) r = op.egt ? 0 : rate(op.rr);   // percussive sounds keep falling at the release rate
    else r = rate(op.rr);
    const t = FALL(r);
    if (t !== Infinity) op.att += (96 * dt) / t;
    if (op.stage === DECAY && op.att >= sl) { op.att = sl; op.stage = SUSTAIN; }
    if (op.att >= 96) { op.att = 96; if (op.stage !== DECAY) op.stage = OFF; }
  }
}
