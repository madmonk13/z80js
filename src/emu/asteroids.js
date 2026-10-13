// Atari Asteroids (1979): a 6502 at 1.5 MHz driving the Digital Vector
// Generator (see dvg.js) on a black-and-white vector monitor. The program
// builds a display list in 2K of vector RAM (shapes and the font are in the
// vector ROM) and starts the DVG once a frame; an NMI ~250 times a second
// keeps time. Sound is a set of analog circuits (thump, saucer, fires,
// thrust, explosions, extra life), synthesized here.

import { CPU6502 } from './m6502.js';
import { DVG } from './dvg.js';
import { RATE, SoundMix } from './mixer.js';
import { Pokey, PokeyVoice } from './pokey.js';
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
    const v = this.compute();
    const out = v - this.dcIn + 0.995 * this.dcOut;
    this.dcIn = v; this.dcOut = out;
    const mask = this.buffer.length - 1;
    this.buffer[this.writePos] = out;
    this.writePos = (this.writePos + 1) & mask;
    if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
  }

  // One sample of the analog circuits (Asteroids Deluxe uses only thrust and explosions).
  compute() {
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
    return s * 0.6;
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
    this.win = this.constructor.window || WIN;
    this.width = this.win.x1 - this.win.x0;
    this.height = this.win.y1 - this.win.y0;
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
    const lines = this.dvg.run(), v = this.vectors, d = v.data, WIN = this.win;
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

// ---------------------------------------------------------------- Asteroids Deluxe (1980)
//
// The same board with a POKEY for most sounds (the analog circuits keep the
// thrust and explosions), shields instead of hyperspace, and an EAROM that
// keeps the high scores (`nvram`). The vector ROM grows to 4800-57FF and the
// program to 6000-7FFF.

class AnalogVoice {
  constructor(sound) { this.snd = sound; this.out = 0; }
  reset() { this.snd.reset(); }
  saveState() { return this.snd.saveState(); }
  loadState(s) { this.snd.loadState(s); }
  sample() { this.out = this.snd.compute(); }
}

export class AsteroidsDeluxe extends Asteroids {
  constructor(roms) {
    super(roms);
    this.button2 = 'Thrust';
    this.analog = new AsteroidsSound();
    this.pokey = new Pokey(CPU_CLOCK, 1);
    this.pokey.readPots = () => this.dsw2;
    this.sound = new SoundMix([new PokeyVoice(this.pokey), new AnalogVoice(this.analog)], 1);
    this.earom = new Uint8Array(64);
    this.nvram = this.earom;
    this.reset();
  }
  saveState() { return { ...super.saveState(), earomState: [this.earomOffset, this.earomData] }; }
  loadState(s) { super.loadState(s); [this.earomOffset, this.earomData] = s.earomState || [0, 0]; }

  reset() { super.reset(); this.earomOffset = 0; this.earomData = 0; }

  read(a) {
    a &= 0x7FFF;
    if (a >= 0x6000 && a < 0x8000) return this.roms.main[a - 0x6000];
    if (a >= 0x4800 && a < 0x5800) return this.roms.vector[a - 0x4800];
    if (a >= 0x2C00 && a < 0x2C10) return this.pokey.read(a & 15);
    if (a >= 0x2C40 && a < 0x2C80) return this.earomData;
    return super.read(a);
  }

  write(a, v) {
    a &= 0x7FFF;
    if (a < 0x400 || (a >= 0x4000 && a < 0x4800)) { super.write(a, v); return; }
    if (a >= 0x2C00 && a < 0x2C10) { this.pokey.write(a & 15, v); return; }
    if (a >= 0x3200 && a < 0x3240) { this.earomOffset = a & 0x3F; this.earomData = v; return; }
    switch (a) {
      case 0x3000: this.runDvg(); return;
      case 0x3600: this.analog.setExplode(v); return;
      case 0x3A00:                                   // EAROM control: clock in a read, or write
        if (v & 1) this.earomData = this.earom[this.earomOffset];
        if ((v & 0x0C) === 0x0C) this.earom[this.earomOffset] = this.earomData;
        return;
      case 0x3C03: this.analog.write(3, v); return; // thrust
      case 0x3C04: this.bankSwap = v & 0x80; return;
    }
  }

  applySwitches(v) { this.dsw = v.lives | v.difficulty; this.dsw2 = 0x9D; }
}
AsteroidsDeluxe.id = 'astdelux';
AsteroidsDeluxe.title = 'Asteroids Deluxe';
AsteroidsDeluxe.switches = [
  { id: 'lives', label: 'Lives', options: [['2-4', 0x00], ['3-5', 0x04], ['4-6', 0x08], ['5-7', 0x0C]], default: 0x04 },
  { id: 'difficulty', label: 'Difficulty', options: [['Hard', 0x00], ['Easy', 0x20]], default: 0x00 },
];

// ---------------------------------------------------------------- Lunar Lander (1979)
//
// The Asteroids board's first use: 256 bytes of RAM, a 40 Hz picture, a
// thrust lever (an 8-bit pot; up / down move it here) and its own analog
// sounds: thrust noise at one of 8 volumes, 3 and 6 kHz beeps, an explosion.

class LanderSound {
  constructor() { this.reset(); }
  reset() { this.reg = 0; this.noise = 1; this.lp = 0; this.ph3 = 0; this.ph6 = 0; this.env = 0; this.out = 0; }
  saveState() { return capture(this, ['reg', 'noise', 'lp', 'ph3', 'ph6', 'env']); }
  loadState(s) { apply(this, ['reg', 'noise', 'lp', 'ph3', 'ph6', 'env'], s); }
  write(v) { if ((v & 8) && !(this.reg & 8)) this.env = 1; this.reg = v; }
  sample() {
    const dt = 1 / RATE, r = this.reg;
    this.noise = (this.noise >> 1) | ((((this.noise) ^ (this.noise >> 3)) & 1) << 16);
    const white = (this.noise & 1) * 2 - 1;
    this.lp += (white - this.lp) * 0.08;
    let s = this.lp * (r & 7) / 7 * 0.8;                       // thrust
    if (this.env > 0.001) { s += this.lp * this.env * 1.2; this.env *= Math.exp(-dt / 0.6); }   // explosion
    if (r & 0x10) { this.ph3 = (this.ph3 + 3000 * dt) % 1; s += this.ph3 < 0.5 ? 0.12 : -0.12; }
    if (r & 0x20) { this.ph6 = (this.ph6 + 6000 * dt) % 1; s += this.ph6 < 0.5 ? 0.12 : -0.12; }
    this.out = s * 0.6;
  }
}

export class LunarLander extends Asteroids {
  constructor(roms) {
    super(roms);
    this.refresh = 40;
    this.controls = 'four-way';
    this.buttons = 1;
    this.lander = new LanderSound();
    this.sound = new SoundMix([this.lander], 1);
    this.thrust = 0;
    this.reset();
  }
  saveState() { return { ...super.saveState(), thrust: this.thrust }; }
  loadState(s) { super.loadState(s); this.thrust = s.thrust ?? 0; }

  read(a) {
    a &= 0x7FFF;
    if (a < 0x2000) return this.ram[a & 0xFF];
    if (a >= 0x6000 && a < 0x8000) return this.roms.main[a - 0x6000];
    if (a >= 0x4800 && a < 0x6000) return this.roms.vector[a - 0x4800] ?? 0;
    if (a >= 0x4000 && a < 0x4800) return this.vram[a - 0x4000];
    if (a === 0x2000) return 0xFF;                  // vector generator done, no service or tilt, 3 kHz clock
    if (a >= 0x2400 && a < 0x2408) return this.in1 & (1 << (a & 7)) ? 0x80 : 0x7F;
    if (a >= 0x2800 && a < 0x2804) return 0xFC | ((this.dsw >> (2 * (3 - (a & 3)))) & 3);
    if (a === 0x2C00) return this.thrust;
    return 0xFF;
  }

  write(a, v) {
    a &= 0x7FFF;
    if (a < 0x2000) { this.ram[a & 0xFF] = v; return; }
    if (a >= 0x4000 && a < 0x4800) { this.vram[a - 0x4000] = v; return; }
    if (a === 0x3000) this.runDvg();
    else if (a === 0x3C00) this.lander.write(v);
  }

  // IN1: start (01), coin (02, active low), select game (10), abort (20), right (40), left (80).
  // Up and down move the thrust lever, which stays where it's left.
  setInputs(s) {
    this.in1 = (s.start1 ? 0x01 : 0) | (s.coin ? 0 : 0x02) | 0x08 | (s.start2 ? 0x10 : 0) | (s.fire ? 0x20 : 0)
      | (s.right ? 0x40 : 0) | (s.left ? 0x80 : 0);
    if (s.up) this.thrust = Math.min(254, this.thrust + 8);
    if (s.down) this.thrust = Math.max(0, this.thrust - 8);
  }
  applySwitches(v) { this.dsw = 0x01 | v.fuel; }

  runFrame() {
    const slices = 16, frame = CPU_CLOCK / 40, samples = RATE / 40;
    for (let k = 0; k < slices; k++) {
      this.nmiCarry += NMI_RATE / 40 / slices;
      while (this.nmiCarry >= 1) { this.nmiCarry -= 1; this.cpu.nmi(); }
      this.cycleCarry += frame / slices;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += samples / slices;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }
}
LunarLander.window = { x0: 0, y0: 0, x1: 1024, y1: 1024 };
LunarLander.id = 'llander';
LunarLander.title = 'Lunar Lander';
LunarLander.switches = [
  { id: 'fuel', label: 'Fuel per coin', options: [['450', 0x00], ['600', 0x40], ['750', 0x80], ['900', 0xC0], ['1100', 0x10], ['1300', 0x50], ['1550', 0x90], ['1800', 0xD0]], default: 0x80 },
];
