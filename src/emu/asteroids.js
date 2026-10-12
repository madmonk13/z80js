// Atari Asteroids (1979): a 6502 at 1.5 MHz driving the Digital Vector
// Generator (see dvg.js) on a black-and-white vector monitor. The program
// builds a display list in 2K of vector RAM (shapes and the font are in the
// vector ROM) and starts the DVG once a frame; an NMI ~250 times a second
// keeps time. Sound is a set of analog circuits (thump, saucer, fires,
// thrust, explosions, extra life), synthesized here.

import { CPU6502 } from './m6502.js';
import { DVG } from './dvg.js';
import { RATE } from './mixer.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const CPU_CLOCK = 12096000 / 8, NMI_RATE = 12096000 / 4096 / 12;   // ~246 Hz
const FRAME_CYCLES = CPU_CLOCK / 60, SAMPLES_PER_FRAME = RATE / 60;
const STATE = ['ram', 'vram', 'bankSwap', 'cycleCarry', 'nmiCarry', 'sampleCarry', 'in0', 'in1', 'cpu', 'sound'];

// The visible window of the DVG's 1024x1024 space.
const WIN = { x0: 0, y0: 96, x1: 1040, y1: 928 };

// ---------------------------------------------------------------- sound

class AsteroidsSound {
  constructor() { this.buffer = new Float32Array(1 << 15); this.rate = RATE; this.reset(); }
  saveState() { return capture(this, ['reg', 'thump', 'explode', 'env', 'phase', 'noise', 'lp', 'dcIn', 'dcOut']); }
  loadState(s) { apply(this, ['reg', 'thump', 'explode', 'env', 'phase', 'noise', 'lp', 'dcIn', 'dcOut'], s); }
  reset() {
    this.reg = new Uint8Array(6);           // 3C00-3C05: saucer, saucer fire, saucer size, thrust, ship fire, life
    this.thump = 0; this.explode = 0;
    this.env = new Float64Array(4);         // ship fire, saucer fire, explosion, life
    this.phase = new Float64Array(5);
    this.noise = 1; this.lp = new Float64Array(2); this.dcIn = this.dcOut = 0;
    this.writePos = this.readPos = 0;
  }
  write(r, v) {
    const was = this.reg[r] & 0x80;
    this.reg[r] = v;
    if (!was && (v & 0x80)) { if (r === 4) this.env[0] = 1; if (r === 1) this.env[1] = 1; }
  }
  setExplode(v) { this.explode = v; if (v & 0x3C) this.env[2] = ((v >> 2) & 15) / 15; }
  sample() {
    const dt = 1 / RATE, ph = this.phase, env = this.env, r = this.reg;
    for (let i = 0; i < 2; i++) this.noise = (this.noise >> 1) | ((((this.noise) ^ (this.noise >> 3)) & 1) << 16);
    const white = (this.noise & 1) * 2 - 1;
    let s = 0;
    // Thump: the heartbeat, a low tone while bit 4 is set.
    if (this.thump & 0x10) { ph[0] = (ph[0] + (40 + 4 * (this.thump & 15)) * dt) % 1; s += ph[0] < 0.4 ? 0.35 : -0.35; }
    // Saucer: a warbling tone, higher for the small one.
    if (r[0] & 0x80) { ph[1] = (ph[1] + ((r[2] & 0x80 ? 900 : 600) + 120 * Math.sin(ph[4] * Math.PI * 2)) * dt) % 1; ph[4] = (ph[4] + 8 * dt) % 1; s += ph[1] < 0.5 ? 0.1 : -0.1; }
    // Thrust: rumbling noise.
    if (r[3] & 0x80) { this.lp[0] += (white - this.lp[0]) * 0.05; s += this.lp[0] * 0.6; }
    // Ship fire and saucer fire: falling zaps.
    for (const [k, base] of [[0, 2000], [1, 1500]]) {
      if (env[k] > 0.001) { ph[2 + k] = (ph[2 + k] + base * env[k] * dt) % 1; s += env[k] * (ph[2 + k] < 0.5 ? 0.18 : -0.18); env[k] *= Math.exp(-dt / 0.12); }
    }
    // Explosions: filtered noise, its brightness from the pitch bits.
    if (env[2] > 0.001) { this.lp[1] += (white - this.lp[1]) * (0.05 + 0.05 * (3 - (this.explode >> 6))); s += env[2] * this.lp[1] * 1.2; env[2] *= Math.exp(-dt / 0.35); }
    // Extra life: a beeping tone while held.
    if (r[5] & 0x80) { ph[2] = (ph[2] + 3000 * dt) % 1; s += ph[2] < 0.5 ? 0.08 : -0.08; }
    const out = s * 0.6 - this.dcIn + 0.995 * this.dcOut;
    this.dcIn = s * 0.6; this.dcOut = out;
    const mask = this.buffer.length - 1;
    this.buffer[this.writePos] = out;
    this.writePos = (this.writePos + 1) & mask;
    if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
  }
  available() { return (this.writePos - this.readPos) & (this.buffer.length - 1); }
  pull(out, outRate) {
    const buf = this.buffer, mask = buf.length - 1, step = RATE / outRate;
    if (this.available() > RATE * 0.075) this.readPos = (this.writePos - Math.floor(RATE * 0.035)) & mask;
    let pos = this.frac || 0, last = this.last || 0;
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) { out[i] = last *= 0.995; continue; }
      const s0 = buf[this.readPos], s1 = buf[(this.readPos + 1) & mask];
      last = out[i] = s0 + (s1 - s0) * pos;
      pos += step;
      while (pos >= 1 && this.available() > 1) { pos -= 1; this.readPos = (this.readPos + 1) & mask; }
    }
    this.frac = pos; this.last = last;
  }
}

// ---------------------------------------------------------------- board

export class Asteroids {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (6800-7FFF) 6K, vector 2K }
  constructor(roms) {
    this.vector = true;
    this.width = WIN.x1 - WIN.x0;
    this.height = WIN.y1 - WIN.y0;
    this.refresh = 60;
    this.controls = 'two-way';
    this.buttons = 2;
    this.button2 = 'Thrust';
    this.roms = roms;
    this.ram = new Uint8Array(0x400);
    this.vram = new Uint8Array(0x800);         // 4000-47FF
    this.cpu = new CPU6502({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sound = new AsteroidsSound();
    this.dvg = new DVG((w) => this.dvgWord(w));
    this.vectors = { data: new Float32Array(7 * 4096), count: 0 };
    this.in0 = 0; this.in1 = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0);
    this.bankSwap = 0;
    this.cycleCarry = this.nmiCarry = this.sampleCarry = 0;
    this.vectors.count = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- bus (15 address lines)

  // The 2-player RAM swap exchanges pages 2 and 3.
  ramIndex(a) { return this.bankSwap && a >= 0x200 ? a ^ 0x100 : a; }

  read(a) {
    a &= 0x7FFF;
    if (a < 0x400) return this.ram[this.ramIndex(a)];
    if (a >= 0x6800) return this.roms.main[a - 0x6800];
    if (a >= 0x4000 && a < 0x4800) return this.vram[a - 0x4000];
    if (a >= 0x5000 && a < 0x5800) return this.roms.vector[a - 0x5000];
    // Switches, one per address, reported in bit 7.
    if (a >= 0x2000 && a < 0x2008) {
      const bits = this.in0 | (this.cpu.cycles & 0x100 ? 0x02 : 0);   // bit 1: the 3 kHz clock; bit 2: DVG busy (never)
      return bits & (1 << (a & 7)) ? 0x80 : 0x7F;
    }
    if (a >= 0x2400 && a < 0x2408) return this.in1 & (1 << (a & 7)) ? 0x80 : 0x7F;
    if (a >= 0x2800 && a < 0x2804) return 0xFC | ((this.dsw >> (2 * (3 - (a & 3)))) & 3);
    return 0xFF;
  }

  write(a, v) {
    a &= 0x7FFF;
    if (a < 0x400) { this.ram[this.ramIndex(a)] = v; return; }
    if (a >= 0x4000 && a < 0x4800) { this.vram[a - 0x4000] = v; return; }
    switch (a & 0xFF00) {
      case 0x3000: this.runDvg(); break;
      case 0x3200: this.bankSwap = v & 4; break;
      case 0x3600: this.sound.setExplode(v); break;
      case 0x3A00: this.sound.thump = v; break;
      case 0x3C00: if ((a & 7) < 6) this.sound.write(a & 7, v); break;
      // 3400 watchdog, 3E00 noise reset.
    }
  }

  // The DVG reads 16-bit words: word address w is bytes 4000 + 2w (RAM, then ROM at 5000).
  dvgWord(w) {
    const a = 0x4000 + w * 2;
    return this.read(a) | (this.read(a + 1) << 8);
  }

  runDvg() {
    const lines = this.dvg.run(), v = this.vectors, d = v.data;
    let n = 0;
    for (let i = 0; i < lines.length && n < 4096; i += 5) {
      const o = n * 7, z = lines[i + 4] / 15;
      d[o] = lines[i] - WIN.x0; d[o + 1] = WIN.y1 - lines[i + 1];
      d[o + 2] = lines[i + 2] - WIN.x0; d[o + 3] = WIN.y1 - lines[i + 3];
      d[o + 4] = d[o + 5] = d[o + 6] = z;
      n++;
    }
    v.count = n;
  }

  // ---------------------------------------------------------------- inputs

  // IN0: hyperspace (8), fire (10). IN1: coin (1), start 1 (8), start 2 (10),
  // thrust (20), rotate right (40), rotate left (80). Down is hyperspace.
  setInputs(s) {
    this.in0 = (s.down || s.hyper ? 0x08 : 0) | (s.fire ? 0x10 : 0);
    this.in1 = (s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0)
      | (s.fire2 || s.up ? 0x20 : 0) | (s.right ? 0x40 : 0) | (s.left ? 0x80 : 0);
  }
  // Language English, lives, 1 coin 1 credit.
  applySwitches(v) { this.dsw = v.lives | 0x80; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const slices = 16;
    for (let k = 0; k < slices; k++) {
      this.nmiCarry += NMI_RATE / 60 / slices;
      while (this.nmiCarry >= 1) { this.nmiCarry -= 1; this.cpu.nmi(); }
      this.cycleCarry += FRAME_CYCLES / slices;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += SAMPLES_PER_FRAME / slices;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }
}

Asteroids.id = 'asteroid';
Asteroids.title = 'Asteroids';
Asteroids.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x04], ['4', 0x00]], default: 0x04 },
];
