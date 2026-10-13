// Atari Battlezone (1980): a 6502 at 1.5 MHz, the Analog Vector Generator
// (see avg.js) on a black-and-white monitor with a green and red overlay,
// the math box for the 3D, a POKEY, and analog sound for the engine, shells
// and explosions (synthesized here). The two tank treads are two 2-way
// sticks, read through the POKEY's pot lines. The picture runs at 40 Hz.

import { CPU6502 } from './m6502.js';
import { AVG } from './avg.js';
import { MathBox } from './mathbox.js';
import { Pokey, PokeyVoice } from './pokey.js';
import { SoundMix, RATE } from './mixer.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const CPU_CLOCK = 12096000 / 8, NMI_RATE = 12096000 / 4096 / 12, REFRESH = 40;
const FRAME_CYCLES = CPU_CLOCK / REFRESH, SAMPLES_PER_FRAME = RATE / REFRESH;
const STATE = ['ram', 'vram', 'cycleCarry', 'nmiCarry', 'sampleCarry', 'in0', 'treads', 'cpu', 'mathbox', 'sound'];

const HALF_W = 290, HALF_H = 200;
// The overlay: everything above this line (the radar and scores) shows red.
const OVERLAY_Y = 92;

// ---------------------------------------------------------------- analog sound

class BattlezoneSound {
  constructor() { this.out = 0; this.reset(); }
  saveState() { return capture(this, BZ_SOUND); }
  loadState(s) { apply(this, BZ_SOUND, s); }
  reset() {
    this.latch = 0;
    this.poly = 0; this.polyClock = 0; this.boomOut = 0; this.boomEdge = 0; this.shellOut = 0; this.shellEdge = 0;
    this.boom = 0; this.shell = 0;
    this.rate = 184; this.motorClock = 0; this.countA = 6; this.countB = 4; this.motorTarget = 0; this.motor = 0;
  }

  // D7 engine on, D5 all sound on, D4 engine rev, D3 shell loud, D2 shell,
  // D1 explosion loud, D0 explosion.
  write(v) { this.latch = v; }
  get enabled() { return !!(this.latch & 0x20); }

  sample() {
    const dt = 1 / RATE, l = this.latch;
    // A 15-bit noise shifter clocked at 6 kHz. Explosions toggle on the rising
    // edge of NAND(bits 12-14), shells on bit 15: two rough noise squares.
    this.polyClock += 6000 * dt;
    while (this.polyClock >= 1) {
      this.polyClock -= 1;
      const p = this.poly;
      this.poly = ((p << 1) | (!(p & 0x0008) === !(p & 0x4000) ? 1 : 0)) & 0xFFFF;
      const b = (this.poly & 0x7000) === 0x7000 ? 0 : 1;
      if (b && !this.boomEdge) this.boomOut ^= 1;
      this.boomEdge = b;
      const sh = (this.poly >> 15) & 1;
      if (sh && !this.shellEdge) this.shellOut ^= 1;
      this.shellEdge = sh;
    }
    // Each enable charges a capacitor; its discharge sets the noise's level.
    if (l & 0x01) this.boom = 1; else this.boom *= Math.exp(-dt / 0.92);
    if (l & 0x04) this.shell = 1; else this.shell *= Math.exp(-dt / 0.43);
    let s = 0;
    if (this.boomOut) s += this.boom * (l & 0x02 ? 1 / 3 : 1 / 4);
    if (this.shellOut) s += this.shell * (l & 0x08 ? 1 / 3 : 1 / 4);
    // Engine: a 555 (about 184 Hz, 240 Hz revved, gliding between in a quarter
    // second) clocks two 4-bit counters reloading at 6 and 4; their top bits and
    // carries sum through four equal resistors into a capacitor: two beating
    // throbs around 15-18 Hz.
    if (l & 0x80) {
      const target = l & 0x10 ? 240 : 184, glide = (240 - 184) / 0.25 * dt;
      this.rate += Math.max(-glide, Math.min(glide, target - this.rate));
      this.motorClock += this.rate * dt;
      while (this.motorClock >= 1) {
        this.motorClock -= 1;
        if (++this.countA === 16) this.countA = 6;
        if (++this.countB === 16) this.countB = 4;
        const high = ((this.countA >> 3) & 1) + (this.countA === 15 ? 1 : 0) + ((this.countB >> 3) & 1) + (this.countB === 15 ? 1 : 0);
        this.motorTarget = high / 4;
      }
      this.motor += (this.motorTarget - this.motor) * (1 - Math.exp(-dt / 0.0039));
      s += this.motor * 0.5;
    }
    this.out = l & 0x20 ? s * 1.6 : 0;
  }
}
const BZ_SOUND = ['latch', 'poly', 'polyClock', 'boomOut', 'boomEdge', 'shellOut', 'shellEdge', 'boom', 'shell',
  'rate', 'motorClock', 'countA', 'countB', 'motorTarget', 'motor'];

// The POKEY only sounds while D5 is on, too.
class GatedVoice extends PokeyVoice {
  constructor(pokey, analog) { super(pokey); this.analog = analog; }
  sample() { super.sample(); if (!this.analog.enabled) this.out = 0; }
}

// ---------------------------------------------------------------- board

export class Battlezone {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.drawList(); }

  // roms: { main 5000-7FFF (12K), vector 3000-3FFF (4K) }
  constructor(roms) {
    this.vector = true;
    this.width = HALF_W * 2;
    this.height = HALF_H * 2;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x400);
    this.vram = new Uint8Array(0x1000);
    this.cpu = new CPU6502({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.avg = new AVG((a) => (a < 0x1000 ? this.vram[a] : this.roms.vector[(a - 0x1000) & 0xFFF]), 'bzone');
    this.mathbox = new MathBox();
    this.pokey = new Pokey(CPU_CLOCK, 3);
    this.pokey.readPots = () => this.treads;
    this.analog = new BattlezoneSound();
    this.sound = new SoundMix([new GatedVoice(this.pokey, this.analog), this.analog], 1);
    this.vectors = { data: new Float32Array(7 * 6000), count: 0 };
    this.in0 = 0xFF; this.treads = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0);
    this.cycleCarry = this.nmiCarry = this.sampleCarry = 0;
    this.vectors.count = 0;
    this.mathbox.reset();
    this.cpu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- bus (15 address lines)

  read(a) {
    a &= 0x7FFF;
    if (a < 0x400) return this.ram[a];
    if (a >= 0x5000) return this.roms.main[a - 0x5000];
    if (a >= 0x2000 && a < 0x3000) return this.vram[a - 0x2000];
    if (a >= 0x3000 && a < 0x4000) return this.roms.vector[a - 0x3000];
    switch (a) {
      // IN0: coins (active low), test switches off; bit 6 the AVG done, bit 7 the 3 kHz clock.
      case 0x0800: return (this.in0 & 0x3F) | 0x40 | (this.cpu.cycles & 0x100 ? 0x80 : 0);
      case 0x0A00: return this.dsw0;
      case 0x0C00: return this.dsw1;
      case 0x1800: return this.mathbox.status();
      case 0x1810: return this.mathbox.lo();
      case 0x1818: return this.mathbox.hi();
    }
    if (a >= 0x1820 && a < 0x1830) return this.pokey.read(a & 15);
    return 0;
  }

  write(a, v) {
    a &= 0x7FFF;
    if (a < 0x400) { this.ram[a] = v; return; }
    if (a >= 0x2000 && a < 0x3000) { this.vram[a - 0x2000] = v; return; }
    if (a >= 0x1820 && a < 0x1830) { this.pokey.write(a & 15, v); return; }
    if (a >= 0x1860 && a < 0x1880) { this.mathbox.go(a & 0x1F, v); return; }
    if (a === 0x1200) this.drawList();
    else if (a === 0x1840) this.analog.write(v);
    // 1000 coin counters, 1400 watchdog, 1600 AVG reset.
  }

  drawList() {
    const segs = this.avg.run(), d = this.vectors.data;
    let n = 0;
    for (let i = 0; i < segs.length && n < 6000; i += 6) {
      const o = n * 7, b = segs[i + 5] / 255;
      const x0 = HALF_W + segs[i], y0 = HALF_H - segs[i + 1], x1 = HALF_W + segs[i + 2], y1 = HALF_H - segs[i + 3];
      d[o] = x0; d[o + 1] = y0; d[o + 2] = x1; d[o + 3] = y1;
      const red = Math.max(y0, y1) < OVERLAY_Y;
      d[o + 4] = (red ? 1 : 0.25) * b; d[o + 5] = (red ? 0.15 : 1) * b; d[o + 6] = (red ? 0.1 : 0.3) * b;
      n++;
    }
    this.vectors.count = n;
  }

  // ---------------------------------------------------------------- inputs

  // Treads (pot lines): 01 right back, 02 right forward, 04 left back, 08 left
  // forward; 10 fire, 20 start 1, 40 start 2. One stick drives both: up and
  // down move, left and right turn on the spot, diagonals turn with one tread.
  setInputs(s) {
    let left = 0, right = 0;                     // +1 forward, -1 back
    if (s.up) { left = 1; right = 1; if (s.left) left = 0; if (s.right) right = 0; }
    else if (s.down) { left = -1; right = -1; if (s.left) left = 0; if (s.right) right = 0; }
    else if (s.left) { left = -1; right = 1; }
    else if (s.right) { left = 1; right = -1; }
    this.treads = (right < 0 ? 0x01 : 0) | (right > 0 ? 0x02 : 0) | (left < 0 ? 0x04 : 0) | (left > 0 ? 0x08 : 0)
      | (s.fire ? 0x10 : 0) | (s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0);
    this.in0 = 0xFF & ~(s.coin ? 0x01 : 0);
  }
  // DSW0: lives, missile score, bonus, English. DSW1: 1 coin 1 credit.
  applySwitches(v) { this.dsw0 = v.lives | 0x04 | v.bonus; this.dsw1 = 0x02; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const slices = 16;
    for (let k = 0; k < slices; k++) {
      this.nmiCarry += NMI_RATE / REFRESH / slices;
      while (this.nmiCarry >= 1) { this.nmiCarry -= 1; this.cpu.nmi(); }
      this.cycleCarry += FRAME_CYCLES / slices;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += SAMPLES_PER_FRAME / slices;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }
}

Battlezone.id = 'bzone';
Battlezone.title = 'Battlezone';
Battlezone.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x00], ['3', 0x01], ['4', 0x02], ['5', 0x03]], default: 0x01 },
  { id: 'bonus', label: 'Bonus tank', options: [['15k and 100k', 0x10], ['20k and 100k', 0x20], ['50k and 100k', 0x30], ['None', 0x00]], default: 0x10 },
];

// ---------------------------------------------------------------- Red Baron (1980)
//
// Battlezone's board flying a biplane: the same AVG and math box (read at
// other addresses), an analog stick read through the POKEY's pot lines (a
// latch bit picks the axis), an EAROM for the high scores (`nvram`), a plain
// white monitor, and analog sounds for the crash, machine guns and the
// nose-dive squeal.

class RedBaronSound {
  constructor() { this.out = 0; this.reset(); }
  saveState() { return capture(this, ['latch', 'poly', 'polyAcc', 'filterAcc', 'crash', 'shot', 'squeal', 'squealPhase']); }
  loadState(s) { apply(this, ['latch', 'poly', 'polyAcc', 'filterAcc', 'crash', 'shot', 'squeal', 'squealPhase'], s); }
  reset() { this.latch = 0; this.poly = 1; this.polyAcc = 0; this.filterAcc = 0; this.crash = 0; this.shot = 0; this.squeal = 0; this.squealPhase = 0; }
  write(v) { this.latch = v; }
  sample() {
    const dt = 1 / RATE, l = this.latch;
    // A 15-bit noise shift register at 12 kHz; the crash takes its level from it 330 times a second.
    this.polyAcc += 12000 * dt;
    while (this.polyAcc >= 1) { this.polyAcc -= 1; this.poly = (((this.poly & 1) === 0) === ((this.poly & 0x4000) === 0) ? (this.poly << 1) | 1 : this.poly << 1) & 0xFFFF; }
    this.filterAcc += 330 * dt;
    while (this.filterAcc >= 1) { this.filterAcc -= 1; this.crash = (this.poly & 1) ? (l >> 4) / 15 : 0; }
    let s = this.crash * 0.35;
    // Machine guns: bit 2 low charges the gun; noise gates its decay.
    if (!(l & 4)) this.shot = 1;
    else if (!(this.poly & 0x8000) && this.shot > 0) { this.shot = Math.max(0, this.shot - dt / 0.03264); s += Math.exp(-8 * (1 - this.shot)) * 0.35; }
    // Squeal: a tone sweeping up while bit 1 is held.
    if (l & 2) { this.squeal = Math.min(1, this.squeal + dt / 1.017); this.squealPhase = (this.squealPhase + (1134 + 1134 * this.squeal) / 3 * dt) % 1; if (this.squealPhase < 0.33) s += 0.4; }
    else this.squeal = 0;
    this.out = (s - 0.2) * 0.5;
  }
}

export class RedBaron extends Battlezone {
  constructor(roms) {
    super(roms);
    this.width = 520; this.height = 400;
    this.controls = 'eight-way';
    this.pokey.readPots = () => (this.redBaron.latch & 1 ? this.stickX : this.stickY);
    this.redBaron = new RedBaronSound();
    this.sound = new SoundMix([new PokeyVoice(this.pokey), this.redBaron], 1);
    this.earom = new Uint8Array(64); this.nvram = this.earom;
    this.stickX = this.stickY = 0x80; this.in4 = 0;
    this.reset();
  }
  saveState() { return { ...super.saveState(), rb: [this.earomOffset, this.earomData, this.redBaron.saveState()] }; }
  loadState(s) { super.loadState(s); if (s.rb) { [this.earomOffset, this.earomData] = s.rb; this.redBaron.loadState(s.rb[2]); } }
  reset() { super.reset(); this.earomOffset = 0; this.earomData = 0; }

  read(a) {
    a &= 0x7FFF;
    if (a >= 0x4800) return this.roms.main[a - 0x4800];
    switch (a) {
      case 0x1800: return this.mathbox.status();
      case 0x1802: return this.in4;
      case 0x1804: return this.mathbox.lo();
      case 0x1806: return this.mathbox.hi();
    }
    if (a >= 0x1810 && a < 0x1820) return this.pokey.read(a & 15);
    if (a >= 0x1820 && a < 0x1860) return this.earomData;
    return super.read(a);
  }

  write(a, v) {
    a &= 0x7FFF;
    if (a < 0x400 || (a >= 0x2000 && a < 0x3000)) { super.write(a, v); return; }
    if (a >= 0x1810 && a < 0x1820) { this.pokey.write(a & 15, v); return; }
    if (a >= 0x1820 && a < 0x1860) { this.earomOffset = a & 0x3F; this.earomData = v; return; }
    if (a >= 0x1860 && a < 0x1880) { this.mathbox.go(a & 0x1F, v); return; }
    if (a === 0x1200) this.drawList();
    else if (a === 0x1808) this.redBaron.write(v);
    else if (a === 0x180C) {
      if (v & 1) this.earomData = this.earom[this.earomOffset];
      if ((v & 0x0C) === 0x0C) this.earom[this.earomOffset] = this.earomData;
    }
  }

  drawList() {
    const segs = this.avg.run(), d = this.vectors.data;
    let n = 0;
    for (let i = 0; i < segs.length && n < 6000; i += 6) {
      const o = n * 7, b = segs[i + 5] / 255;
      d[o] = 260 + segs[i]; d[o + 1] = 200 - segs[i + 1]; d[o + 2] = 260 + segs[i + 2]; d[o + 3] = 200 - segs[i + 3];
      d[o + 4] = d[o + 5] = d[o + 6] = b;
      n++;
    }
    this.vectors.count = n;
  }

  // The stick's two pots (64-192, centered at 128); IN4: start (40), fire (80).
  setInputs(s) {
    this.stickX = s.left ? 64 : s.right ? 192 : 128;
    this.stickY = s.up ? 64 : s.down ? 192 : 128;
    this.in4 = (s.start1 ? 0x40 : 0) | (s.fire ? 0x80 : 0);
    this.in0 = 0xFF & ~(s.coin ? 0x01 : 0);
  }
  applySwitches(v) { this.dsw0 = 0xFD; this.dsw1 = 0x03 | v.bonus | v.lives | 0xC0; }
}
RedBaron.id = 'redbaron';
RedBaron.title = 'Red Baron';
RedBaron.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x30], ['3', 0x20], ['4', 0x10], ['5', 0x00]], default: 0x20 },
  { id: 'bonus', label: 'Bonus life', options: [['2K, 10K, 30K', 0x0C], ['4K, 15K, 40K', 0x08], ['6K, 20K, 50K', 0x04], ['None', 0x00]], default: 0x04 },
];
