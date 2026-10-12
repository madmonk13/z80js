// Cinematronics Tail Gunner (1979): the Cinematronics CPU (see ccpu.js) at
// 5 MHz drawing straight to a black-and-white vector monitor, 38 frames a
// second. The gun's analog stick is read by successive approximation: the
// program sets the X register and tests a comparator on the JMI line. The
// cabinet's sounds were analog boards that MAME plays from recordings (not in
// the ROM set); they're synthesized here from the same triggers.

import { CCPU } from './ccpu.js';
import { RATE } from './mixer.js';
import { capture, apply } from './state.js';

const CLOCK = 5000000, REFRESH = 38;
const FRAME_CYCLES = CLOCK / REFRESH, SAMPLES_PER_FRAME = RATE / REFRESH;
const W = 1024, H = 768;
const SWITCH_ORDER = [2, 5, 4, 3, 0, 1, 6, 7];
const STATE = ['inputs', 'switches', 'stick', 'mux', 'coinSeen', 'coinLast', 'coinResetLast', 'bright',
  'cycleCarry', 'sampleCarry', 'cpu', 'sound'];

// ---------------------------------------------------------------- sound

class TailGunnerSound {
  constructor() { this.buffer = new Float32Array(1 << 15); this.rate = RATE; this.reset(); }
  saveState() { return capture(this, ['control', 'shift', 'env', 'phase', 'noise', 'lp', 'dcIn', 'dcOut']); }
  loadState(s) { apply(this, ['control', 'shift', 'env', 'phase', 'noise', 'lp', 'dcIn', 'dcOut'], s); }
  reset() {
    this.control = 0; this.shift = 0xFF;
    this.env = new Float64Array(3);            // explosion, bounce, hyperspace
    this.phase = new Float64Array(4);
    this.noise = 1; this.lp = new Float64Array(2);
    this.dcIn = this.dcOut = 0;
    this.writePos = this.readPos = 0;
  }

  // Ports 0-4 set one bit each of the sound control byte. The falling edge of
  // bit 4 clocks bit 3 into the latch bit picked by bits 0-2: bit 0 explosion
  // (falling edge), 1 rumble, 2 laser, 3 shield (0 = on), 4 bounce, 5 hyperspace.
  write(port, bit) {
    const old = this.control;
    this.control = (old & ~(1 << port)) | (bit << port);
    if ((old & 0x10) && !(this.control & 0x10)) {
      const v = this.control, was = this.shift;
      this.shift = (was & ~(1 << (v & 7))) | (((v >> 3) & 1) << (v & 7));
      const fell = was & ~this.shift;
      if (fell & 0x01) this.env[0] = 1;
      if (fell & 0x10) this.env[1] = 1;
      if (fell & 0x20) this.env[2] = 1;
    }
  }

  sample() {
    const dt = 1 / RATE, ph = this.phase, env = this.env, sh = this.shift;
    this.noise = (this.noise >> 1) | ((((this.noise) ^ (this.noise >> 3)) & 1) << 16);
    const white = (this.noise & 1) * 2 - 1;
    let s = 0;
    // Rumble: the engines, low noise while on.
    if (!(sh & 0x02)) { this.lp[0] += (white - this.lp[0]) * 0.02; s += this.lp[0] * 0.9; }
    // Laser: a falling zap that repeats while the trigger is held.
    if (!(sh & 0x04)) { ph[3] = (ph[3] + dt * 9) % 1; ph[0] = (ph[0] + (1600 - 1300 * ph[3]) * dt) % 1; s += ph[0] < 0.5 ? 0.12 : -0.12; }
    // Shield: a buzzing hum.
    if (!(sh & 0x08)) { ph[1] = (ph[1] + 110 * dt) % 1; s += (ph[1] < 0.5 ? 0.1 : -0.1) + white * 0.03; }
    // Explosion: filtered noise burst.
    if (env[0] > 0.001) { this.lp[1] += (white - this.lp[1]) * 0.08; s += this.lp[1] * env[0] * 1.3; env[0] *= Math.exp(-dt / 0.5); }
    // Bounce: a short blip; hyperspace: a rising sweep.
    if (env[1] > 0.001) { ph[2] = (ph[2] + 900 * dt) % 1; s += env[1] * (ph[2] < 0.5 ? 0.12 : -0.12); env[1] *= Math.exp(-dt / 0.06); }
    if (env[2] > 0.001) { ph[2] = (ph[2] + (300 + 1500 * (1 - env[2])) * dt) % 1; s += env[2] * (ph[2] < 0.5 ? 0.1 : -0.1); env[2] *= Math.exp(-dt / 0.4); }
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

export class TailGunner {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 8K (two 4K banks, each two 2K ROMs interleaved) }
  constructor(roms) {
    this.vector = true;
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.analogStick = true;
    this.buttons = 2;
    this.button2 = 'Shield';
    this.roms = roms;
    this.sound = new TailGunnerSound();
    this.vectors = { data: new Float32Array(7 * 6000), count: 0 };
    this.cpu = new CCPU({
      op: (a) => this.op(a),
      input: (port) => this.input(port),
      output: (port, bit) => this.output(port, bit),
      external: () => this.comparator(),
      vector: (x0, y0, x1, y1, shift) => this.line(x0, y0, x1, y1, shift),
    });
    this.inputs = 0xFFFF; this.switches = 0xFF;
    this.stick = new Float64Array(2);          // x, y: -1..1
    this.applySwitches({});
    this.reset();
  }

  reset() {
    this.mux = 0; this.coinSeen = 0; this.coinLast = 0x80; this.coinResetLast = 0; this.bright = 1;
    this.cycleCarry = this.sampleCarry = 0;
    this.vectors.count = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // Program space: 14 address lines; 0000-0FFF the first bank (mirrored at 1000), 2000-2FFF the second.
  op(a) { a &= 0x3FFF; return this.roms.main[(a & 0x2000 ? 0x1000 : 0) + (a & 0xFFF)]; }

  input(port) {
    if (port < 16) return (this.inputs >> port) & 1;
    if (port < 0x17) return (this.switches >> SWITCH_ORDER[port - 16]) & 1;
    return this.coinSeen ? 0 : 1;
  }

  output(port, bit) {
    if (port === 5) { if (bit && !this.coinResetLast) this.coinSeen = 0; this.coinResetLast = bit; }
    else if (port === 6) this.bright = bit ? 0.55 : 1;        // two intensities
    else if (port === 7) this.mux = bit;
    if (port < 5) this.sound.write(port, bit);
  }

  // The stick comparator: is the selected axis below the value in X?
  comparator() {
    const axis = this.mux ? this.stick[0] : -this.stick[1];      // stick up aims up
    const v = 0x800 + Math.round(axis * 0x600);
    const x = ((this.cpu.x & 0xFFF) << 20) >> 20;
    return v - x < 0x800 ? 1 : 0;
  }

  line(x0, y0, x1, y1, shift) {
    const v = this.vectors;
    if (v.count >= 6000) return;
    // A dot's brightness follows the shift (longer dwell); lines are full.
    const b = (x0 === x1 && y0 === y1 ? Math.min(1, (0x1FF * shift) / 8 / 255) : 1) * this.bright;
    const o = v.count * 7, d = v.data;
    d[o] = x0; d[o + 1] = H - 1 - y0; d[o + 2] = x1; d[o + 3] = H - 1 - y1;    // the monitor is flipped vertically
    d[o + 4] = d[o + 5] = d[o + 6] = b;
    v.count++;
  }

  // ---------------------------------------------------------------- inputs

  // Fire (bit 5), shield (6), start (7), active low; the stick is analog.
  setInputs(s) {
    const st = this.stick;
    if (s.analog) { st[0] = s.analog.x; st[1] = s.analog.y; }
    else {
      const tx = (s.right ? 1 : 0) - (s.left ? 1 : 0), ty = (s.down ? 1 : 0) - (s.up ? 1 : 0);
      st[0] += Math.max(-0.08, Math.min(0.08, tx - st[0]));
      st[1] += Math.max(-0.08, Math.min(0.08, ty - st[1]));
    }
    this.inputs = 0xFFFF & ~((s.fire ? 0x20 : 0) | (s.fire2 ? 0x40 : 0) | (s.start1 ? 0x80 : 0));
    this.coin = !!s.coin;
  }
  // 80 shield points, 1 coin 1 credit.
  applySwitches() { this.dipSwitches = 0x7F; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    // The coin switch latches on its press until the program resets it.
    this.switches = this.dipSwitches | (this.coin ? 0 : 0x80);
    const now = this.switches & 0x80;
    if (now !== this.coinLast && !now) this.coinSeen = 1;
    this.coinLast = now;
    // A frame: the program draws, then waits (FRM) for the next one.
    this.vectors.count = 0;
    this.cpu.startFrame();
    this.cycleCarry += FRAME_CYCLES;
    this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
    if (this.cycleCarry > FRAME_CYCLES) this.cycleCarry = FRAME_CYCLES;
    this.sampleCarry += SAMPLES_PER_FRAME;
    while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
  }
}

TailGunner.id = 'tailg';
TailGunner.title = 'Tail Gunner';
TailGunner.switches = [];
