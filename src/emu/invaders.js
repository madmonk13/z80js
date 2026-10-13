// Midway / Taito Space Invaders (1978): an Intel 8080 at 1.9968 MHz (run on
// the Z80 core), a 256x224 one-bit bitmap in RAM, a hardware barrel shifter
// (Fujitsu MB14241) for drawing sprites at any pixel, and discrete sound
// circuits, one per effect, switched on and off by two output ports. The
// color came from strips of cellophane on the monitor glass.
//
// The CPU is interrupted twice a frame: RST 1 at mid-screen and RST 2 at the
// start of vblank, so the game can redraw whichever half the beam isn't on.
// 262 lines at 59.54 Hz; the picture is 224x256 on a vertical monitor.

import { Z80 } from './z80.js';
import { rgba, rotate270 } from './video.js';
import { RATE } from './mixer.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, LINES = 262;
const CPU_CLOCK = 1996800, REFRESH = CPU_CLOCK / (LINES * 128);
const LINE_CYCLES = CPU_CLOCK / REFRESH / LINES, SAMPLES_PER_LINE = RATE / REFRESH / LINES;
const STATE = ['ram', 'shift', 'shiftCount', 'port3', 'port5', 'cycleCarry', 'sampleCarry', 'in1', 'ctl', 'cpu', 'sound'];

// The sound board, modelled by ear rather than component by component: each
// effect is a small synthesizer started by its port bit.
//   port 3: 01 saucer (while on), 02 shot, 04 base explodes, 08 invader hit,
//           10 extra base, 20 sound on
//   port 5: 01-08 the four fleet march notes, 10 saucer hit
const SOUND_STATE = ['p3', 'p5', 't', 'env', 'phase', 'noise', 'lp', 'out'];
const FLEET_HZ = [98, 87, 78, 73];
class InvadersSound {
  constructor() { this.reset(); }
  saveState() { return capture(this, SOUND_STATE); }
  loadState(s) { apply(this, SOUND_STATE, s); }
  reset() {
    this.p3 = this.p5 = 0;
    // Per effect: time since start (seconds), envelope level, oscillator phase.
    // 0 saucer, 1 shot, 2 explosion, 3 invader hit, 4 extra base, 5 fleet, 6 saucer hit
    this.t = new Float64Array(7); this.env = new Float64Array(7); this.phase = new Float64Array(7);
    this.noise = 1; this.lp = new Float64Array(3);
    this.out = 0;
  }
  write3(v) {
    const rise = v & ~this.p3;
    for (const [bit, n] of [[0x02, 1], [0x04, 2], [0x08, 3], [0x10, 4]]) if (rise & bit) { this.t[n] = 0; this.env[n] = 1; }
    this.p3 = v;
  }
  write5(v) {
    const rise = v & ~this.p5;
    if (rise & 0x0F) { this.t[5] = 0; this.env[5] = 1; this.fleet = FLEET_HZ[Math.log2(rise & 0x0F) | 0]; }
    if (rise & 0x10) { this.t[6] = 0; this.env[6] = 1; }
    this.p5 = v;
  }

  sample() {
    const dt = 1 / RATE, t = this.t, env = this.env, ph = this.phase;
    // A 17-bit noise source, stepped a few times a sample.
    for (let i = 0; i < 4; i++) this.noise = (this.noise >> 1) | ((((this.noise >> 0) ^ (this.noise >> 3)) & 1) << 16);
    const white = (this.noise & 1) * 2 - 1;
    let s = 0;
    // Saucer: a tone warbling up and down several times a second.
    if (this.p3 & 1) {
      const f = 520 + 160 * Math.sin(2 * Math.PI * 7 * t[0]);
      ph[0] = (ph[0] + f * dt) % 1; s += (ph[0] < 0.5 ? 0.25 : -0.25);
      t[0] += dt;
    }
    // Shot: a falling hiss.
    if (env[1] > 0.001) {
      const f = 2400 * Math.exp(-t[1] * 6);
      ph[1] = (ph[1] + f * dt) % 1;
      s += env[1] * 0.25 * ((ph[1] < 0.5 ? 1 : -1) * 0.5 + white * 0.5);
      env[1] *= Math.exp(-dt / 0.12); t[1] += dt;
    }
    // Base explosion: a long low rumble of filtered noise.
    if (env[2] > 0.001) {
      this.lp[0] += (white - this.lp[0]) * 0.03;
      s += env[2] * this.lp[0] * 1.6;
      env[2] *= Math.exp(-dt / 0.45); t[2] += dt;
    }
    // Invader hit: a short crack of brighter noise.
    if (env[3] > 0.001) {
      this.lp[1] += (white - this.lp[1]) * 0.25;
      s += env[3] * this.lp[1] * 0.7;
      env[3] *= Math.exp(-dt / 0.08); t[3] += dt;
    }
    // Extra base: a bright beeping for about a second.
    if (env[4] > 0.001) {
      ph[4] = (ph[4] + 1500 * dt) % 1;
      if ((t[4] * 12 | 0) % 2 === 0) s += env[4] * (ph[4] < 0.5 ? 0.2 : -0.2);
      env[4] = t[4] < 1 ? 1 : 0; t[4] += dt;
    }
    // Fleet: a thumping bass note per step.
    if (env[5] > 0.001) {
      ph[5] = (ph[5] + this.fleet * dt) % 1;
      s += env[5] * (ph[5] < 0.5 ? 0.5 : -0.5);
      env[5] *= Math.exp(-dt / 0.06); t[5] += dt;
    }
    // Saucer hit: a sweeping tone.
    if (env[6] > 0.001) {
      const f = 900 + 500 * Math.sin(2 * Math.PI * 14 * t[6]);
      ph[6] = (ph[6] + f * dt) % 1;
      s += env[6] * (ph[6] < 0.5 ? 0.25 : -0.25);
      env[6] = t[6] < 1.2 ? 1 : 0; t[6] += dt;
    }
    this.out = this.p3 & 0x20 ? s : 0;
  }
}

class Speaker {
  constructor(source) {
    this.source = source;
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.dcIn = this.dcOut = 0;
    this.writePos = this.readPos = 0;
  }
  saveState() { return { src: this.source.saveState(), dc: [this.dcIn, this.dcOut] }; }
  loadState(s) { this.source.loadState(s.src); [this.dcIn, this.dcOut] = s.dc; }
  reset() { this.source.reset(); this.dcIn = this.dcOut = 0; this.writePos = this.readPos = 0; }
  sample() {
    this.source.sample();
    const s = this.source.out * 1.1, out = s - this.dcIn + 0.995 * this.dcOut;
    this.dcIn = s; this.dcOut = out;
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

// The cellophane overlay, in screen (portrait) coordinates: a red band where
// the saucer flies, green over the bases and shields, and green over the
// spare bases in the bottom-left corner.
const WHITE = rgba(0xFF, 0xFF, 0xFF), RED = rgba(0xFF, 0x30, 0x30), GREEN = rgba(0x30, 0xFF, 0x30), BLACK = rgba(0, 0, 0);
function overlay(x, y) {
  if (y >= 32 && y < 64) return RED;
  if (y >= 184 && y < 240) return GREEN;
  if (y >= 240 && x >= 16 && x < 134) return GREEN;
  return WHITE;
}

export class SpaceInvaders {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 8K (or 18K with ROM at 4000), colors (1K per player) for the color boards }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = REFRESH;
    this.controls = 'two-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x2000);         // 2000-23FF work RAM, 2400-3FFF the bitmap
    this.sound = new Speaker(new (this.constructor.Sound || InvadersSound)());
    this.cpu = new Z80({
      read: (a) => this.read(a), write: (a, v) => this.write(a, v),
      input: (p) => this.input(p & 7), output: (p, v) => this.output(p & 7, v),
    });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.tint = Uint32Array.from({ length: W * H }, (_, i) => (this.constructor.plain ? WHITE : overlay(i % H, (i / H) | 0)));
    // The color boards: a PROM color (red, blue, green bits) per 8x8 block, one map per player.
    this.pens = Uint32Array.from({ length: 8 }, (_, i) => rgba((i & 1) * 0xFF, ((i >> 2) & 1) * 0xFF, ((i >> 1) & 1) * 0xFF));
    this.in1 = 0x09; this.ctl = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0);
    this.shift = 0; this.shiftCount = 0;
    this.port3 = this.port5 = 0;
    this.cycleCarry = this.sampleCarry = 0;
    this.sound.reset();
    this.cpu.reset();
  }

  // ---------------------------------------------------------------- bus (15 address lines)

  read(a) {
    a &= 0x7FFF;
    if (a & 0x2000) return this.ram[a & 0x1FFF];
    return this.roms.main[a] ?? 0;
  }

  write(a, v) {
    if (a & 0x2000) this.ram[a & 0x1FFF] = v;
  }

  input(p) {
    switch (p & 3) {
      case 0: return this.constructor.in0 ?? (0x08 | (this.ctl << 4));
      case 1: return this.in1;
      case 2: return this.dsw | (this.ctl << 4);
      default: return (this.shift >> (8 - this.shiftCount)) & 0xFF;   // the shifter's result
    }
  }

  output(p, v) {
    switch (p) {
      case 2: this.shiftCount = v & 7; break;
      case 3: this.port3 = v; this.sound.source.write3(v); break;
      case 4: this.shift = (this.shift >> 8) | (v << 8); break;
      case 5: this.port5 = v; this.sound.source.write5(v); break;
      // 6: watchdog
    }
  }

  // ---------------------------------------------------------------- inputs

  // IN1: coin (low while inserted), 2P start, 1P start, fire, left, right.
  // The controls are wired to both IN0 and IN2 as well (fire, left, right).
  setInputs(s) {
    this.ctl = (s.fire ? 1 : 0) | (s.left ? 2 : 0) | (s.right ? 4 : 0);
    this.in1 = (!s.coin !== !this.constructor.coinHigh ? 0 : 0x01) | (s.start2 ? 0x02 : 0) | (s.start1 ? 0x04 : 0) | 0x08 | (this.ctl << 4);
  }
  // Lives, bonus base at 1000 or 1500, show coinage.
  applySwitches(v) { this.dsw = v.lives | v.bonus; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === 96) { this.cpu.irqVector = 0xCF; this.cpu.irq = true; }    // RST 1
      if (line === 224) { this.cpu.irqVector = 0xD7; this.cpu.irq = true; this.render(); }   // RST 2
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  // Each line is 32 bytes, least significant bit leftmost.
  render() {
    if (this.roms.colors) { this.renderColor(); return; }
    const out = this.native, ram = this.ram;
    let o = 0;
    for (let y = 0; y < H; y++) {
      for (let b = 0; b < 32; b++) {
        const v = ram[0x400 + y * 32 + b];
        for (let bit = 0; bit < 8; bit++) out[o++] = (v >> bit) & 1;
      }
    }
    rotate270(out, W, H, this.frame);
    const f = this.frame, tint = this.tint;
    for (let i = 0; i < f.length; i++) f[i] = f[i] ? tint[i] : BLACK;
  }
}


// Color boards: port 3 bit 2 turns the whole screen red (the base exploding),
// port 5 bit 5 picks player 2's color map.
SpaceInvaders.prototype.renderColor = function renderColor() {
  const out = this.native, ram = this.ram, pens = this.pens, red = this.port3 & 0x04;
  const map = this.roms.colors, base = this.port5 & 0x20 ? 0x400 : 0;
  let o = 0;
  for (let y = 0; y < H; y++) {
    for (let b = 0; b < 32; b++) {
      const v = ram[0x400 + y * 32 + b], fore = pens[red ? 1 : map[base + ((y >> 3) << 5) + b] & 7];
      for (let bit = 0; bit < 8; bit++) out[o++] = (v >> bit) & 1 ? fore : BLACK;
    }
  }
  rotate270(out, W, H, this.frame);
};

SpaceInvaders.id = 'invaders';
SpaceInvaders.title = 'Space Invaders';
SpaceInvaders.switches = [
  { id: 'lives', label: 'Bases', options: [['3', 0x00], ['4', 0x01], ['5', 0x02], ['6', 0x03]], default: 0x00 },
  { id: 'bonus', label: 'Extra base', options: [['1500', 0x00], ['1000', 0x08]], default: 0x00 },
];

// ---------------------------------------------------------------- variants

// Taito's color boards. Part II: a second shot type, splitting invaders, and
// a name reset button wired active low into IN0.
export class SpaceInvadersPartII extends SpaceInvaders {
  applySwitches(v) { this.dsw = v.lives; }
}
SpaceInvadersPartII.id = 'invadpt2';
SpaceInvadersPartII.title = 'Space Invaders Part II';
SpaceInvadersPartII.in0 = 0x40;
SpaceInvadersPartII.switches = [
  { id: 'lives', label: 'Bases', options: [['3', 0x00], ['4', 0x01]], default: 0x00 },
];

// The original game on the color board.
export class SpaceInvadersCV extends SpaceInvaders {}
SpaceInvadersCV.id = 'sicv';
SpaceInvadersCV.title = 'Space Invaders (Color)';
SpaceInvadersCV.in0 = 0x00;
SpaceInvadersCV.switches = SpaceInvaders.switches;

// Lunar Rescue's sound: one-shot effects on port 3 (thrust, shot, death,
// alien hit, bonus ship) and port 5 (two footstep tones, the men-saved
// count, a one-bit speaker for the tunes, the shooting star while held).
class LunarRescueSound extends InvadersSound {
  reset() { super.reset(); this.x = new Float64Array(5); this.xph = new Float64Array(3); this.lowp = 0; }
  saveState() { return { base: super.saveState(), x: Array.from(this.x), xph: Array.from(this.xph), lowp: this.lowp }; }
  loadState(s) { super.loadState(s.base); this.x.set(s.x); this.xph.set(s.xph); this.lowp = s.lowp; }
  write3(v) {
    if (v & ~this.p3 & 0x01) this.x[0] = 1;                  // thrust
    super.write3(v & ~0x01 | (this.p3 & 0x01));
  }
  write5(v) {
    const rise = v & ~this.p5;
    if (rise & 0x03) { this.t[5] = 0; this.env[5] = 1; this.fleet = rise & 1 ? 196 : 147; }   // footsteps
    if (rise & 0x04) this.x[1] = 1;                          // men saved
    this.p5 = v;
  }
  sample() {
    super.sample();
    if (!(this.p3 & 0x20)) return;
    const dt = 1 / RATE, x = this.x, ph = this.xph, white = (this.noise & 1) * 2 - 1;
    let s = 0;
    if (x[0] > 0.001) { this.lowp += (white - this.lowp) * 0.08; s += x[0] * this.lowp * 1.2; x[0] *= Math.exp(-dt / 0.15); }
    if (x[1] > 0.001) { ph[0] = (ph[0] + 1200 * dt) % 1; s += x[1] * (ph[0] < 0.5 ? 0.2 : -0.2); x[1] *= Math.exp(-dt / 0.05); }
    if (this.p5 & 0x08) s += 0.25;                            // the tune speaker
    if (this.p5 & 0x10) {                                     // shooting star / rescue ship
      x[2] += dt; ph[1] = (ph[1] + (1800 - 900 * ((x[2] * 3) % 1)) * dt) % 1; s += ph[1] < 0.5 ? 0.12 : -0.12;
    } else x[2] = 0;
    this.out += s;
  }
}

export class LunarRescue extends SpaceInvaders {
  constructor(roms) { super(roms); this.buttons = 1; }
  applySwitches(v) { this.dsw = v.lives; }
}
LunarRescue.id = 'lrescue';
LunarRescue.title = 'Lunar Rescue';
LunarRescue.Sound = LunarRescueSound;
LunarRescue.in0 = 0x00;
LunarRescue.switches = SpaceInvaders.switches.slice(0, 1);

// Black and white games on the Midway board.
export class GalaxyWars extends SpaceInvaders {
  applySwitches(v) { this.dsw = v.lives | v.bonus; }
}
GalaxyWars.id = 'galxwars';
GalaxyWars.title = 'Galaxy Wars';
GalaxyWars.in0 = 0x40;
GalaxyWars.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x00], ['3', 0x01], ['4', 0x02], ['5', 0x03]], default: 0x01 },
  { id: 'bonus', label: 'Bonus', options: [['3000', 0x00], ['5000', 0x08]], default: 0x00 },
];

export class OzmaWars extends SpaceInvaders {
  applySwitches(v) { this.dsw = v.energy | v.bonus; }
}
OzmaWars.id = 'ozmawars';
OzmaWars.title = 'Ozma Wars';
OzmaWars.plain = true;
OzmaWars.coinHigh = true;
OzmaWars.in0 = 0x00;
OzmaWars.switches = [
  { id: 'energy', label: 'Energy', options: [['15000', 0x00], ['20000', 0x01], ['25000', 0x02], ['35000', 0x03]], default: 0x00 },
  { id: 'bonus', label: 'Bonus energy', options: [['15000', 0x00], ['10000', 0x08]], default: 0x00 },
];
