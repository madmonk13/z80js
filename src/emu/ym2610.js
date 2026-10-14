// Yamaha YM2610 (OPNB), the Neo Geo's sound chip: four FM channels (the
// OPN's channels 2, 3, 5 and 6), an SSG (AY-3-8910-style tones and noise),
// six ADPCM-A channels playing fixed-rate drum and voice samples, one
// ADPCM-B channel at a programmable rate, and two timers for the sound CPU.
// Samples come from the cartridge's V ROMs.
//
// Two register ports. Port A: 00-0F SSG, 10-1B ADPCM-B, 1C ADPCM flag
// reset, 22 LFO, 24-27 timers, 28 key on, 30-B6 FM channels 1-3. Port B:
// 00-2D ADPCM-A, 30-B6 FM channels 4-6. Status A: timer flags; status B:
// ADPCM end-of-sample flags.
//
// The FM side follows the same documented-behavior model as the YM2203 and
// YM2151 here; the ADPCM decoders follow the chips' published algorithms.

import { AY8910 } from './ay8910.js';
import { RATE } from './mixer.js';
import { capture, apply } from './state.js';

const SINE = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((i / 4096) * Math.PI * 2));
const ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4, OFF = 0;
const FALL_TABLE = Float64Array.from({ length: 64 }, (_, r) => (r < 4 ? Infinity : 10.6 / Math.pow(2, (r - 4) / 4)));
const FALL_TIME = (r) => FALL_TABLE[r];
const LN10_20 = Math.LN10 / 20;
const SLOT_OF = [0, 2, 1, 3];                 // register offset 0/4/8/C -> operators 1, 3, 2, 4
const LFO_HZ = [3.98, 5.56, 6.02, 6.37, 6.88, 9.63, 48.1, 72.2];
const PMS_CENTS = [0, 3.4, 6.7, 10, 14, 20, 40, 80];
const AMS_DB = [0, 1.4, 5.9, 11.8];

// ADPCM-A: step sizes and the per-nibble differences.
const STEPS = [16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190,
  209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552];
const STEP_INC = [-16, -16, -16, -16, 32, 80, 112, 144];
const JEDI = new Int16Array(49 * 16);
for (let s = 0; s < 49; s++) {
  for (let n = 0; n < 16; n++) {
    const v = Math.trunc(((2 * (n & 7) + 1) * STEPS[s]) / 8);
    JEDI[s * 16 + n] = n & 8 ? -v : v;
  }
}
// ADPCM-B: the delta's multipliers (/64) and the nibble weights.
const B1 = [1, 3, 5, 7, 9, 11, 13, 15, -1, -3, -5, -7, -9, -11, -13, -15];
const B2 = [57, 57, 57, 57, 77, 102, 128, 153, 57, 57, 57, 57, 77, 102, 128, 153];

function makeOp() {
  return { dt: 0, mul: 1, tl: 0, ks: 0, ar: 0, dr: 0, sr: 0, sl: 0, rr: 0, am: 0, phase: 0, att: 96, stage: OFF };
}

const STATE = ['addrA', 'addrB', 'ch', 'lfo', 'lfoPhase', 'timerA', 'timerB', 'countA', 'countB', 'timerCtl', 'status',
  'endFlags', 'aTL', 'a', 'b', 'regB', 'accA', 'held'];

export class YM2610 {
  // rom: the V ROM samples (ADPCM-A and B share it on the boards here)
  constructor(clock, rom, gain = 1) {
    this.clock = clock;
    this.rom = rom;
    this.gain = gain;
    this.ssg = new AY8910(clock / 4, () => 0xFF, 1);
    this.reset();
  }

  saveState() { return { chip: capture(this, STATE), ssg: this.ssg.saveState() }; }
  loadState(s) { apply(this, STATE, s.chip); this.ssg.loadState(s.ssg); }

  reset() {
    this.addrA = 0; this.addrB = 0;
    this.ch = Array.from({ length: 6 }, () => ({ fnum: 0, block: 0, fb: 0, alg: 0, pan: 3, ams: 0, pms: 0, ops: [makeOp(), makeOp(), makeOp(), makeOp()], fb1: 0, fb2: 0 }));
    this.lfo = 0; this.lfoPhase = 0;
    this.timerA = 0; this.timerB = 0; this.countA = 0; this.countB = 0; this.timerCtl = 0; this.status = 0;
    this.endFlags = 0;
    this.aTL = 0x3F;
    // ADPCM-A channels: playing, address (nibbles), end, accumulator, step index, level, pan.
    this.a = Array.from({ length: 6 }, () => ({ on: 0, addr: 0, end: 0, start: 0, stop: 0, acc: 0, step: 0, il: 0x1F, pan: 3 }));
    this.b = { on: 0, repeat: 0, addr: 0, start: 0, end: 0, acc: 0, prev: 0, delta: 127, pos: 0, rate: 0, vol: 0, pan: 3 };
    this.regB = new Uint8Array(16);
    this.accA = 0; this.held = 0;
    this.ssg.reset();
    this.out = 0;
  }

  get irq() { return (this.status & 3) !== 0; }

  // ---------------------------------------------------------------- ports

  selectA(v) { this.addrA = v; }
  selectB(v) { this.addrB = v; }
  statusA() { return this.status; }
  statusB() { return this.endFlags; }
  readData() { if (this.addrA < 0x10) { this.ssg.select(this.addrA); return this.ssg.read(); } return 0; }

  writeA(v) {
    const r = this.addrA;
    if (r < 0x10) { this.ssg.select(r); this.ssg.write(v); return; }
    if (r < 0x1C) { this.writeB(r - 0x10, v); return; }
    if (r === 0x1C) { this.endFlags &= ~v; return; }
    switch (r) {
      case 0x22: this.lfo = v; return;
      case 0x24: this.timerA = (this.timerA & 3) | (v << 2); return;
      case 0x25: this.timerA = (this.timerA & 0x3FC) | (v & 3); return;
      case 0x26: this.timerB = v; return;
      case 0x27:
        if ((v & 1) && !(this.timerCtl & 1)) this.countA = this.periodA();
        if ((v & 2) && !(this.timerCtl & 2)) this.countB = this.periodB();
        if (v & 0x10) this.status &= ~1;
        if (v & 0x20) this.status &= ~2;
        this.timerCtl = v & 0x0F;
        return;
      case 0x28: {
        const n = (v & 3) + (v & 4 ? 3 : 0);
        if ((v & 3) === 3 || n > 5) return;
        const c = this.ch[n];
        for (let i = 0; i < 4; i++) {
          const op = c.ops[i], on = (v >> (4 + i)) & 1;
          if (on && (op.stage === OFF || op.stage === RELEASE)) { op.stage = ATTACK; op.phase = 0; }
          else if (!on && op.stage !== OFF) op.stage = RELEASE;
        }
        return;
      }
    }
    if (r >= 0x30) this.writeFM(0, r, v);
  }

  writeDataB(v) {
    const r = this.addrB;
    if (r >= 0x30) { this.writeFM(3, r, v); return; }
    this.writeA_PCM(r, v);
  }

  periodA() { return (144 * (1024 - this.timerA)) / this.clock; }
  periodB() { return (144 * 16 * (256 - this.timerB)) / this.clock; }

  timers(dt) {
    if (this.timerCtl & 1) {
      this.countA -= dt;
      while (this.countA <= 0) { this.countA += this.periodA(); if (this.timerCtl & 4) this.status |= 1; }
    }
    if (this.timerCtl & 2) {
      this.countB -= dt;
      while (this.countB <= 0) { this.countB += this.periodB(); if (this.timerCtl & 8) this.status |= 2; }
    }
  }

  writeFM(base, r, v) {
    const chn = r & 3;
    if (chn === 3) return;
    const c = this.ch[base + chn];
    if (r < 0xA0) {
      const op = c.ops[SLOT_OF[(r >> 2) & 3]];
      switch (r & 0xF0) {
        case 0x30: op.dt = (v >> 4) & 7; op.mul = v & 15 ? v & 15 : 0.5; break;
        case 0x40: op.tl = v & 0x7F; break;
        case 0x50: op.ks = v >> 6; op.ar = v & 0x1F; break;
        case 0x60: op.am = v >> 7; op.dr = v & 0x1F; break;
        case 0x70: op.sr = v & 0x1F; break;
        case 0x80: op.sl = v >> 4; op.rr = v & 15; break;
      }
      return;
    }
    if (r < 0xA4) c.fnum = (c.fnum & 0x700) | v;
    else if (r < 0xA8) { c.fnum = (c.fnum & 0xFF) | ((v & 7) << 8); c.block = (v >> 3) & 7; }
    else if (r >= 0xB0 && r < 0xB4) { c.fb = (v >> 3) & 7; c.alg = v & 7; }
    else if (r >= 0xB4 && r < 0xB8) { c.pan = v >> 6; c.ams = (v >> 4) & 3; c.pms = v & 7; }
  }

  // ---------------------------------------------------------------- ADPCM

  writeA_PCM(r, v) {
    if (r === 0x00) {
      for (let i = 0; i < 6; i++) {
        if (!((v >> i) & 1)) continue;
        const ch = this.a[i];
        if (v & 0x80) { ch.on = 0; continue; }       // dump (stop)
        ch.on = 1; ch.addr = ch.start * 2; ch.end = (ch.stop + 255) * 2; ch.acc = 0; ch.step = 0;
      }
      return;
    }
    if (r === 0x01) { this.aTL = v & 0x3F; return; }
    const i = r & 7;
    if (i > 5) return;
    const ch = this.a[i];
    switch (r & 0x38) {
      case 0x08: ch.il = v & 0x1F; ch.pan = v >> 6; break;
      case 0x10: ch.start = (ch.start & 0xFF0000) | (v << 8); break;
      case 0x18: ch.start = (ch.start & 0x00FF00) | (v << 16); break;
      case 0x20: ch.stop = (ch.stop & 0xFF0000) | (v << 8); break;
      case 0x28: ch.stop = (ch.stop & 0x00FF00) | (v << 16); break;
    }
  }

  writeB(r, v) {
    const b = this.b, reg = this.regB;
    reg[r] = v;
    switch (r) {
      case 0x00:
        if (v & 1) { b.on = 0; return; }           // reset
        if (v & 0x80) {
          b.on = 1; b.repeat = (v >> 4) & 1;
          b.addr = b.start * 2; b.acc = 0; b.prev = 0; b.delta = 127; b.pos = 0;
          if (b.start >= this.rom.length) b.on = 0;
        } else b.on = 0;
        break;
      case 0x01: b.pan = v >> 6; break;
      case 0x02: case 0x03: b.start = ((reg[3] << 8) | reg[2]) << 8; break;
      case 0x04: case 0x05: b.end = (((reg[5] << 8) | reg[4]) << 8) + 255; break;
      case 0x09: case 0x0A: b.rate = (reg[0x0A] << 8) | reg[0x09]; break;
      case 0x0B: b.vol = v; break;
    }
  }

  // One ADPCM-A sample period (clock / 432) for all six channels.
  tickA() {
    let s = 0;
    for (let i = 0; i < 6; i++) {
      const ch = this.a[i];
      if (!ch.on) continue;
      if ((ch.addr & 0x1FFFFF) === (ch.end & 0x1FFFFF) || (ch.addr >> 1) >= this.rom.length) { ch.on = 0; this.endFlags |= 1 << i; continue; }
      const byte = this.rom[ch.addr >> 1], nib = ch.addr & 1 ? byte & 15 : byte >> 4;
      ch.addr++;
      let acc = ch.acc + JEDI[ch.step + nib];
      acc = acc & 0x800 ? acc | ~0xFFF : acc & 0xFFF;        // wraps as a 12-bit value
      ch.acc = acc;
      ch.step = Math.max(0, Math.min(48 * 16, ch.step + STEP_INC[nib & 7]));
      if (!ch.pan) continue;
      const vol = (this.aTL ^ 0x3F) + (ch.il ^ 0x1F);
      if (vol >= 63) continue;
      s += ((acc * (15 - (vol & 7))) >> (1 + (vol >> 3))) & ~3;
    }
    this.held = s;
  }

  tickB(dt) {
    const b = this.b;
    if (!b.on) return 0;
    b.pos += (b.rate / 65536) * (this.clock / 144) * dt;
    while (b.pos >= 1) {
      b.pos -= 1;
      if (b.addr === b.end * 2) {
        if (b.repeat) { b.addr = b.start * 2; b.acc = 0; b.prev = 0; b.delta = 127; }
        else { b.on = 0; this.endFlags |= 0x80; return 0; }
      }
      const byte = this.rom[(b.addr >> 1) % this.rom.length], nib = b.addr & 1 ? byte & 15 : byte >> 4;
      b.addr++;
      b.prev = b.acc;
      b.acc = Math.max(-32768, Math.min(32767, b.acc + Math.trunc((B1[nib] * b.delta) / 8)));
      b.delta = Math.max(127, Math.min(24576, Math.trunc((b.delta * B2[nib]) / 64)));
    }
    const v = b.prev + (b.acc - b.prev) * b.pos;
    return b.pan ? (v / 32768) * (b.vol / 255) : 0;
  }

  // ---------------------------------------------------------------- output

  sample() {
    const dt = 1 / RATE, fs = this.clock / 144;
    // LFO (register 22: bit 3 enables, bits 0-2 the rate).
    let pmWave = 0, amWave = 0;
    if (this.lfo & 8) {
      this.lfoPhase = (this.lfoPhase + LFO_HZ[this.lfo & 7] * dt) % 1;
      const p = this.lfoPhase;
      pmWave = p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
      amWave = p < 0.5 ? 2 * p : 2 - 2 * p;
    }
    let fm = 0;
    for (let n = 0; n < 6; n++) {
      const c = this.ch[n], o = c.ops;
      if (n === 0 || n === 3) continue;            // the YM2610 lacks channels 1 and 4
      const keycode = (c.block << 2) | (((c.fnum >> 10) & 1) << 1) | ((c.fnum >> 9) & 1);
      for (let i = 0; i < 4; i++) this.envelope(o[i], keycode, dt);
      if (!c.pan) continue;
      const base = ((c.fnum * Math.pow(2, c.block - 1) * fs) / 1048576) * (c.pms ? Math.pow(2, (PMS_CENTS[c.pms] * pmWave) / 1200) : 1);
      const amDb = AMS_DB[c.ams] * amWave;
      const op = (k, mod) => {
        const p = o[k];
        p.phase = (p.phase + base * p.mul * dt) % 1;
        if (p.stage === OFF) return 0;
        const att = p.att + p.tl * 0.75 + (p.am ? amDb : 0);
        if (att > 90) return 0;
        return SINE[((p.phase * 4096 + mod * 652) & 4095)] * Math.exp(-att * LN10_20);
      };
      const fbIn = c.fb ? (c.fb1 + c.fb2) * Math.PI * Math.pow(2, c.fb - 7) : 0;
      const o1 = op(0, fbIn);
      c.fb2 = c.fb1; c.fb1 = o1;
      const M = 4 * Math.PI;
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
    this.accA += this.clock / 432 / RATE;
    while (this.accA >= 1) { this.accA -= 1; this.tickA(); }
    const pcmB = this.tickB(dt);
    this.ssg.sample();
    this.out = (fm * 0.22 + this.ssg.out * 0.3 + (this.held / 16384) * 0.8 + pcmB * 0.6) * this.gain;
  }

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
    const sl = p.sl === 15 ? 93 : p.sl * 3;
    const r = p.stage === DECAY ? rate(p.dr) : p.stage === SUSTAIN ? rate(p.sr) : Math.min(63, 4 * p.rr + 2 + ksr);
    const t = FALL_TIME(r);
    if (t !== Infinity) p.att += (96 * dt) / t;
    if (p.stage === DECAY && p.att >= sl) { p.att = sl; p.stage = SUSTAIN; }
    if (p.att >= 96) { p.att = 96; if (p.stage === RELEASE) p.stage = OFF; }
  }
}
