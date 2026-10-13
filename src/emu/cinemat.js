// Cinematronics vector games (1980-81) on the same CPU board as Tail Gunner
// (see tailg.js and ccpu.js): Star Castle, Rip Off, Armor Attack and Solar
// Quest. They differ in program size (8K or 16K), how the screen is mirrored,
// the monitor's intensity control (bright/dim, or 64 levels latched from the
// X register), and their analog sound boards, which MAME plays from
// recordings; here each board's triggers drive a small synthesized kit.
//
// The inputs are 16 bits read one at a time; the switches 7 more (shuffled),
// and the coin through a latch the program resets.

import { CCPU } from './ccpu.js';
import { RATE } from './mixer.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const CLOCK = 5000000, REFRESH = 38;
const FRAME_CYCLES = CLOCK / REFRESH, SAMPLES_PER_FRAME = RATE / REFRESH;
const W = 1024, H = 768;
const SWITCH_ORDER = [2, 5, 4, 3, 0, 1, 6, 7];
const STATE = ['inputs', 'switches', 'control', 'shift', 'lastShift', 'shift2', 'lastShift2', 'coinSeen', 'coinLast',
  'coinResetLast', 'color', 'lastCtl', 'cycleCarry', 'sampleCarry', 'cpu', 'sound'];

// ---------------------------------------------------------------- sound kit

// One-shots: boom (big explosion), pop (small explosion), zap (a falling
// laser), shot (a short hiss), beep. Loops, on while set: thrust (rushing
// noise), drone (a low tone at `pitch`), motor (a low buzz), chop (noise
// chopped by rotor blades), hum, music (a square wave at `freq`).
const ONE = ['boom', 'pop', 'zap', 'shot', 'beep'];
const KIT_STATE = ['env', 'phase', 'loops', 'pitch', 'freq', 'noise', 'lp', 'dcIn', 'dcOut'];

class CineSound {
  constructor() { this.buffer = new Float32Array(1 << 15); this.rate = RATE; this.reset(); }
  saveState() { return capture(this, KIT_STATE); }
  loadState(s) { apply(this, KIT_STATE, s); }
  reset() {
    this.env = new Float64Array(ONE.length);
    this.phase = new Float64Array(8);
    this.loops = new Uint8Array(6);            // thrust, drone, motor, chop, hum, music
    this.pitch = 1; this.freq = 0;
    this.noise = 1; this.lp = new Float64Array(4);
    this.dcIn = this.dcOut = 0;
    this.writePos = this.readPos = 0;
  }
  play(name) { this.env[ONE.indexOf(name)] = 1; }
  loop(name, on) { this.loops[['thrust', 'drone', 'motor', 'chop', 'hum', 'music'].indexOf(name)] = on ? 1 : 0; }

  sample() {
    const dt = 1 / RATE, env = this.env, ph = this.phase, lp = this.lp, L = this.loops;
    this.noise = (this.noise >> 1) | ((((this.noise) ^ (this.noise >> 3)) & 1) << 16);
    const white = (this.noise & 1) * 2 - 1;
    const sq = (i, f, a) => { ph[i] = (ph[i] + f * dt) % 1; return ph[i] < 0.5 ? a : -a; };
    let s = 0;
    if (env[0] > 0.001) { lp[0] += (white - lp[0]) * 0.04; s += lp[0] * env[0] * 1.6; env[0] *= Math.exp(-dt / 0.7); }
    if (env[1] > 0.001) { lp[1] += (white - lp[1]) * 0.15; s += lp[1] * env[1] * 0.9; env[1] *= Math.exp(-dt / 0.18); }
    if (env[2] > 0.001) { s += sq(0, 300 + 2200 * env[2], 0.16 * env[2]); env[2] *= Math.exp(-dt / 0.12); }
    if (env[3] > 0.001) { s += white * 0.25 * env[3]; env[3] *= Math.exp(-dt / 0.06); }
    if (env[4] > 0.001) { s += sq(1, 1000, 0.12); env[4] = env[4] > 0.5 ? env[4] - dt / 0.08 : 0; }
    if (L[0]) { lp[2] += (white - lp[2]) * 0.06; s += lp[2] * 0.7; }
    if (L[1]) s += sq(2, 55 * this.pitch, 0.12);
    if (L[2]) s += sq(3, 48, 0.1) * (ph[4] = (ph[4] + 9 * dt) % 1, ph[4] < 0.6 ? 1 : 0.3);
    if (L[3]) { lp[3] += (white - lp[3]) * 0.1; ph[5] = (ph[5] + 11 * dt) % 1; s += lp[3] * (ph[5] < 0.4 ? 0.9 : 0.15); }
    if (L[4]) s += sq(6, 110, 0.06);
    if (L[5] && this.freq > 0) s += sq(7, this.freq, 0.1);
    const out = s * 0.9 - this.dcIn + 0.995 * this.dcOut;
    this.dcIn = s * 0.9; this.dcOut = out;
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

export class Cinematronics {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main: 8K or 16K, each 8K the T/U ROMs on even bytes and P/R on odd }
  constructor(roms) {
    this.vector = true;
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'two-way';
    this.buttons = 2;
    this.button2 = 'Thrust';
    this.roms = roms;
    this.sound = new CineSound();
    this.vectors = { data: new Float32Array(7 * 6000), count: 0 };
    this.cpu = new CCPU({
      op: (a) => this.op(a),
      input: (port) => this.input(port),
      output: (port, bit) => this.output(port, bit),
      vector: (x0, y0, x1, y1, shift) => this.line(x0, y0, x1, y1, shift),
    });
    this.inputs = 0xFFFF; this.switches = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.control = 0x9F; this.shift = this.lastShift = this.shift2 = this.lastShift2 = 0xFFFF;
    this.coinSeen = 0; this.coinLast = 0x80; this.coinResetLast = 0;
    this.color = 1; this.lastCtl = 0;
    this.cycleCarry = this.sampleCarry = 0;
    this.vectors.count = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // 8K: two 4K banks at 0000 and 2000, each mirrored 1000 up; 16K: flat.
  op(a) {
    if (this.roms.main.length > 0x2000) return this.roms.main[a & 0x3FFF];
    return this.roms.main[(a & 0x2000 ? 0x1000 : 0) + (a & 0xFFF)];
  }

  input(port) {
    if (port < 16) return (this.inputs >> port) & 1;
    if (port < 0x17) return (this.switches >> SWITCH_ORDER[port - 16]) & 1;
    return this.coinSeen ? 0 : 1;
  }

  output(port, bit) {
    if (port === 5) { if (bit && !this.coinResetLast) this.coinSeen = 0; this.coinResetLast = bit; }
    else if (port === 6) this.intensity(bit);
    if (port < 8) {
      const old = this.control;
      this.control = (old & ~(1 << port)) | (bit << port);
      if (this.control !== old) this.soundControl(this.control, this.control ^ old);
    }
  }

  // Bright or dim by the bit, or (64 levels) latch X bits 2-7 on a rising edge.
  intensity(bit) {
    if (this.constructor.levels === 64) {
      if (bit && !this.lastCtl) this.color = (((~this.cpu.x >> 2) & 0x3F) + 1) / 64;
    } else this.color = bit ? 0.5 : 1;
    this.lastCtl = bit;
  }

  line(x0, y0, x1, y1, shift) {
    const v = this.vectors;
    if (v.count >= 6000) return;
    const b = (x0 === x1 && y0 === y1 ? Math.min(1, (0x1FF * shift) / 8 / 255) : 1) * this.color;
    const o = v.count * 7, d = v.data, fx = this.constructor.flipX;
    d[o] = fx ? W - 1 - x0 : x0; d[o + 1] = H - 1 - y0; d[o + 2] = fx ? W - 1 - x1 : x1; d[o + 3] = H - 1 - y1;
    d[o + 4] = d[o + 5] = d[o + 6] = b;
    v.count++;
  }

  // Bit helpers for the sound handlers: rising/falling edges of the control
  // byte and of the shift register clocked by it.
  rise(changed, v, bit) { return (changed & bit) && (v & bit); }
  fall(changed, v, bit) { return (changed & bit) && !(v & bit); }
  shiftRise(bit) { return !(this.lastShift & bit) && (this.shift & bit); }
  shiftFall(bit) { return (this.lastShift & bit) && !(this.shift & bit); }

  runFrame() {
    this.switches = this.dipSwitches | (this.coin ? 0 : 0x80);
    const now = this.switches & 0x80;
    if (now !== this.coinLast && !now) this.coinSeen = 1;
    this.coinLast = now;
    this.vectors.count = 0;
    this.cpu.startFrame();
    this.cycleCarry += FRAME_CYCLES;
    this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
    if (this.cycleCarry > FRAME_CYCLES) this.cycleCarry = FRAME_CYCLES;
    this.sampleCarry += SAMPLES_PER_FRAME;
    while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
  }
}

// ---------------------------------------------------------------- the games

// Star Castle: rotate, fire, thrust at the castle behind its rings.
export class StarCastle extends Cinematronics {
  setInputs(s) {
    this.inputs = 0xFFFF & ~((s.start1 ? 0x0001 : 0) | (s.start2 ? 0x0004 : 0) | (s.left ? 0x0040 : 0) | (s.right ? 0x0100 : 0)
      | (s.fire2 || s.up ? 0x0400 : 0) | (s.fire ? 0x1000 : 0));
    this.coin = !!s.coin;
  }
  applySwitches(v) { this.dipSwitches = 0x3C | v.lives; }   // 1 coin 1 credit, service off
  // Bit 7 shifts in on bit 4's rise; bit 0 rising acts on it.
  soundControl(v, c) {
    const k = this.sound;
    if (this.rise(c, v, 0x10)) this.shift = ((this.shift >> 1) & 0x7F) | (v & 0x80);
    if (this.rise(c, v, 0x01)) {
      if (this.shiftFall(0x80)) k.play('pop');                 // fireball
      if (this.shiftFall(0x40)) k.play('beep');                // shield hit
      if (this.shiftRise(0x20)) k.loop('hum', 1);              // star
      if (this.shiftFall(0x20)) k.loop('hum', 0);
      if (this.shiftFall(0x10)) k.loop('thrust', 1);
      if (this.shiftRise(0x10)) k.loop('thrust', 0);
      if (this.shiftFall(0x08)) k.loop('drone', 1);
      if (this.shiftRise(0x08)) k.loop('drone', 0);
      k.pitch = 1 + ((this.shift & 7) + ((this.shift & 2) << 2)) / 16;
      this.lastShift = this.shift;
    }
    if (this.fall(c, v, 0x02)) k.play('boom');
    if (this.fall(c, v, 0x04)) k.play('pop');
    if (this.fall(c, v, 0x08)) k.play('zap');
  }
}
StarCastle.id = 'starcas';
StarCastle.title = 'Star Castle';
StarCastle.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x03], ['4', 0x01], ['5', 0x02], ['6', 0x00]], default: 0x03 },
];

// Rip Off and Armor Attack share a control panel: rotate, fire, thrust.
class TwoPanel extends Cinematronics {
  setInputs(s) {
    this.inputs = 0xFFFF & ~((s.start1 ? 0x0002 : 0) | (s.start2 ? 0x0008 : 0) | (s.left ? 0x1000 : 0) | (s.fire ? 0x2000 : 0)
      | (s.right ? 0x4000 : 0) | (s.fire2 || s.up ? 0x8000 : 0));
    this.coin = !!s.coin;
  }
}

export class RipOff extends TwoPanel {
  applySwitches(v) { this.dipSwitches = 0x50 | v.lives; }   // 1 coin 1 credit, demo sounds, individual scores
  // Bit 0 shifts in on bit 1's rise; bit 2 rising acts on it.
  soundControl(v, c) {
    const k = this.sound;
    if (this.rise(c, v, 0x02)) this.shift = ((this.shift >> 1) & 0x7F) | ((v << 7) & 0x80);
    if (this.rise(c, v, 0x04)) {
      if (this.shiftFall(0x04)) k.loop('hum', 1);              // background
      if (this.shiftRise(0x04)) k.loop('hum', 0);
      if (this.shiftFall(0x02)) k.play('beep');
      if (this.shiftFall(0x01)) k.loop('motor', 1);
      if (this.shiftRise(0x01)) k.loop('motor', 0);
      this.lastShift = this.shift;
    }
    if (this.fall(c, v, 0x08)) k.play('shot');                 // torpedo
    if (this.fall(c, v, 0x10)) k.play('zap');                  // laser
    if (this.fall(c, v, 0x80)) k.play('boom');
  }
}
RipOff.id = 'ripoff';
RipOff.title = 'Rip Off';
RipOff.switches = [
  { id: 'lives', label: 'Fuel pods', options: [['4', 0x01], ['8', 0x03], ['12', 0x00], ['16', 0x02]], default: 0x03 },
];

export class ArmorAttack extends TwoPanel {
  applySwitches(v) { this.dipSwitches = 0x2C | v.lives; }   // 1 coin 1 credit, demo sounds on
  soundControl(v, c) {
    const k = this.sound;
    if (this.rise(c, v, 0x10)) this.shift = ((this.shift >> 1) & 0x7F) | (v & 0x80);
    if (this.rise(c, v, 0x01)) {
      if (this.shiftFall(0x10)) k.play('boom');
      if (this.shiftFall(0x20)) k.play('shot');                // jeep fire
      if (this.shiftFall(0x40)) k.play('pop');
      if (this.shiftFall(0x80)) k.play('zap');                 // tank fire
      this.lastShift = this.shift;
    }
    if (c & 0x02) k.loop('motor', !(v & 0x02));               // tank
    if (c & 0x04) k.loop('hum', !(v & 0x04));                 // beep
    if (c & 0x08) k.loop('chop', !(v & 0x08));                // helicopter
  }
}
ArmorAttack.id = 'armora';
ArmorAttack.title = 'Armor Attack';
ArmorAttack.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x00], ['3', 0x02], ['4', 0x01], ['5', 0x03]], default: 0x03 },
];

// Solar Quest: rotate, fire, thrust, hyperspace; the nova smart bomb is on
// the 2-player start button (they share a line).
export class SolarQuest extends Cinematronics {
  constructor(roms) { super(roms); this.buttons = 3; this.button3 = 'Hyperspace'; }
  setInputs(s) {
    this.inputs = 0xFFFF & ~((s.start2 ? 0x01 : 0) | (s.fire ? 0x02 : 0) | (s.fire2 || s.up ? 0x04 : 0)
      | (s.start1 || s.fire3 ? 0x08 : 0) | (s.right ? 0x10 : 0) | (s.left ? 0x20 : 0));
    this.coin = !!s.coin;
  }
  applySwitches(v) { this.dipSwitches = 0x27 | v.lives; }   // 1 coin 1 credit, bonus at 25 captures
  // A 16-bit register clocked on bit 4 (from bit 7); bit 1 acts on its top
  // byte (effects), bit 0 on all of it (the music: 12-bit pitch, enable).
  soundControl(v, c) {
    const k = this.sound;
    if (this.rise(c, v, 0x10)) this.shift = ((this.shift >> 1) & 0x7FFF) | ((v << 8) & 0x8000);
    if (this.rise(c, v, 0x02)) {
      this.shift >>= 8;
      if (this.shiftFall(0x80)) k.play('boom');
      if (this.shiftFall(0x40)) k.play('pop');
      if (this.shiftFall(0x20)) k.loop('thrust', 1);
      if (this.shiftRise(0x20)) k.loop('thrust', 0);
      if (this.shiftFall(0x10)) k.play('zap');                 // fire
      if (this.shiftFall(0x08)) k.play('beep');                // capture
      if (this.shiftRise(0x04)) k.loop('chop', 1);             // nova
      if (this.shiftFall(0x04)) k.loop('chop', 0);
      if (this.shiftFall(0x02)) k.play('shot');                // photon
      this.lastShift = this.shift;
    }
    if (this.rise(c, v, 0x01)) {
      const sh = this.shift;
      k.loop('music', sh & 0x8000);
      k.freq = 56818.18 / (4096 - (sh & 0xFFF)) / 2;
      this.lastShift2 = sh;
    }
  }
}
SolarQuest.id = 'solarq';
SolarQuest.title = 'Solar Quest';
SolarQuest.levels = 64;
SolarQuest.flipX = true;
SolarQuest.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x18], ['3', 0x08], ['4', 0x10], ['5', 0x00]], default: 0x10 },
];
