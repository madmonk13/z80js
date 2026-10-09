// Stern Berzerk (1980): one Z80 at 2.5 MHz and a 256x256 one-bit bitmap,
// colored in 4x4-pixel cells (two cells per byte of color RAM, high nibble on
// the left). Writes through the "magic RAM" window shift the data, optionally
// mirror it, combine it with what's on screen through a 74181 ALU, and note
// whether any lit pixel was hit (the game's collision detection).
//
// Sound effects come from a 6840 timer chip: three square-wave channels with
// set volumes, any of which can be clocked from a long noise shift register.
// The robots' voice is a separate speech board (an S14001A and two ROMs, 1c
// and 2c); without those ROMs the game simply plays silently there.
//
// 262 lines of 160 cycles (59.6 Hz); the visible picture is 256x224.

import { Z80 } from './z80.js';
import { rgba } from './video.js';
import { RATE } from './mixer.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 32;
const LINES = 262, LINE_CYCLES = 160;
const IRQ_LINES = [128, 256];
const NMI_LINES = [16, 48, 80, 112, 144, 176, 208, 240];
const PTM_CLOCK = 3579545 / 4;

// 74181 in logic mode (M high), by function select S3-S0.
const ALU = [
  (a) => ~a, (a, b) => ~(a | b), (a, b) => ~a & b, () => 0, (a, b) => ~(a & b), (a, b) => ~b, (a, b) => a ^ b, (a, b) => a & ~b,
  (a, b) => ~a | b, (a, b) => ~(a ^ b), (a, b) => b, (a, b) => a & b, () => 0xFF, (a, b) => a | ~b, (a, b) => a | b, (a) => a,
];
const reverse8 = (v) => { let r = 0; for (let i = 0; i < 8; i++) r |= ((v >> i) & 1) << (7 - i); return r; };

const STATE = ['ram', 'vram', 'cram', 'magicCtl', 'lastShift', 'intercept', 'irqEnabled', 'nmiEnabled', 'cycleCarry', 'sampleCarry', 'in0', 'in1', 'cpu', 'sound'];

// The 6840 as Berzerk uses it: counters in continuous mode, each output a
// square wave toggling on underflow (or, in dual 8-bit mode, a pulse), clocked
// by the chip's clock or by the noise generator.
class PTM6840 {
  constructor() {
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }
  saveState() { return capture(this, ['cr', 'latch', 'count', 'state', 'pulses', 'leftover', 'msb', 'volume', 'sfx', 'lfsr', 'oldXor', 'acc', 'dcIn', 'dcOut']); }
  loadState(s) { apply(this, ['cr', 'latch', 'count', 'state', 'pulses', 'leftover', 'msb', 'volume', 'sfx', 'lfsr', 'oldXor', 'acc', 'dcIn', 'dcOut'], s); }
  reset() {
    this.cr = [0, 0, 0]; this.latch = [0, 0, 0]; this.count = [0, 0, 0]; this.state = [0, 0, 0];
    this.pulses = [0, 0, 0]; this.leftover = 0; this.msb = 0;
    this.volume = [0, 0, 0]; this.sfx = 0;
    this.lfsr = [0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF]; this.oldXor = 0;
    this.acc = 0; this.dcIn = this.dcOut = 0;
    this.writePos = this.readPos = 0;
  }

  write(n, v) {
    switch (n) {
      case 0: if (this.cr[1] & 1) this.cr[0] = v; else this.cr[2] = v; break;
      case 1: this.cr[1] = v; break;
      case 2: case 4: case 6: this.msb = v; break;
      default: {                               // 3, 5, 7: LSB, latching the counter value
        const ch = (n - 3) >> 1;
        this.latch[ch] = (this.msb << 8) | v;
        if (!(this.cr[ch] & 0x10)) this.count[ch] = this.latch[ch];
      }
    }
  }
  // Effects control: the top two bits pick the control latch or a channel's volume.
  control(v) {
    const n = v >> 6;
    if (n === 0) this.sfx = v; else this.volume[n - 1] = (v & 7) / 7;
  }

  clockChannel(ch, clocks) {
    if (this.cr[ch] & 0x04) {                  // dual 8-bit: high when the MSB reaches 0
      let lo = this.count[ch] & 0xFF, hi = this.count[ch] >> 8;
      while (clocks > lo) {
        clocks -= lo + 1;
        lo = this.latch[ch] & 0xFF;
        if (hi-- === 0) { this.state[ch] = 0; lo = this.latch[ch] & 0xFF; hi = this.latch[ch] >> 8; }
        else if (hi === 0) { this.state[ch] = 1; this.pulses[ch]++; }
      }
      this.count[ch] = (hi << 8) | (lo - clocks);
    } else {
      let c = this.count[ch];
      while (clocks > c) {
        clocks -= c + 1;
        this.state[ch] ^= 1;
        this.pulses[ch] += this.state[ch];
        c = this.latch[ch];
      }
      this.count[ch] = c - clocks;
    }
  }

  // The noise generator: a long shift register; each 0-to-1 transition at
  // its tap is one external clock.
  noise(clocks) {
    const r = this.lfsr;
    let n = 0;
    for (let i = 0; i < clocks; i++) {
      const x = ((r[3] ^ r[2]) >>> 31) & 1;
      r[3] = ((r[3] << 1) | (r[2] >>> 31)) >>> 0;
      r[2] = ((r[2] << 1) | (r[1] >>> 31)) >>> 0;
      r[1] = ((r[1] << 1) | (r[0] >>> 31)) >>> 0;
      r[0] = ((r[0] << 1) | (x ^ this.oldXor)) >>> 0;
      this.oldXor = x;
      if ((r[2] & 3) === 1) n++;
    }
    return n;
  }

  sample() {
    this.acc += PTM_CLOCK / RATE;
    const clocks = Math.floor(this.acc);
    this.acc -= clocks;
    let s = 0;
    if (!(this.cr[0] & 1)) {
      const noisy = !(this.cr[0] & this.cr[1] & this.cr[2] & 0x02);
      let noiseClocks = noisy && !(this.sfx & 1) ? this.noise(clocks) : 0;
      if (this.cr[0] & 0x80) {
        const before = this.pulses[0];
        this.clockChannel(0, this.cr[0] & 2 ? clocks : noiseClocks);
        if (this.state[0] && !(this.sfx & 2)) s += this.volume[0];
        if (noisy && (this.sfx & 1)) noiseClocks = this.noise(this.pulses[0] - before);
      }
      if (this.cr[1] & 0x80) {
        this.clockChannel(1, this.cr[1] & 2 ? clocks : noiseClocks);
        if (this.state[1]) s += this.volume[1];
      }
      if (this.cr[2] & 0x80) {
        let c = this.cr[2] & 2 ? clocks : noiseClocks;
        if (this.cr[2] & 1) { c += this.leftover; this.leftover = c % 8; c = Math.floor(c / 8); }   // divide by 8
        this.clockChannel(2, c);
        if (this.state[2]) s += this.volume[2];
      }
    }
    s *= 0.3;
    const out = s - this.dcIn + 0.995 * this.dcOut;
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

export class Berzerk {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (0000-3FFF as mapped) }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = 5000000 / 320 / LINES;
    this.controls = 'eight-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x400);
    this.vram = new Uint8Array(0x2000);
    this.cram = new Uint8Array(0x800);
    this.cpu = new Z80({
      read: (a) => this.read(a), write: (a, v) => this.write(a, v),
      input: (p) => this.input(p & 0xFF), output: (p, v) => this.output(p & 0xFF, v),
    });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.cpu.irqVector = 0xFC;
    this.sound = new PTM6840();
    // Colors: red, green, blue bits plus an intensity bit.
    this.pens = Array.from({ length: 16 }, (_, c) => {
      const lvl = (bit) => ((c >> bit) & 1 ? ((c >> 3) & 1 ? 0xFF : 0x9C) : 0);
      return rgba(lvl(0), lvl(1), lvl(2));
    });
    this.frame = new Uint32Array(W * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.cram.fill(0);
    this.cpu.reset(); this.cpu.irqVector = 0xFC;
    this.sound.reset();
    this.magicCtl = 0; this.lastShift = 0; this.intercept = 0;
    this.irqEnabled = 0; this.nmiEnabled = 0;
    this.line = 0;
    this.cycleCarry = this.sampleCarry = 0;
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x4000) return (a & 0x0800) && a < 0x1000 ? this.ram[a & 0x3FF] : this.roms.main[a] ?? 0xFF;
    if (a < 0x8000) return this.vram[a & 0x1FFF];
    if (a < 0xC000) return this.cram[a & 0x7FF];
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x0800 && a < 0x1000) { this.ram[a & 0x3FF] = v; return; }
    if (a < 0x4000) return;
    if (a < 0x6000) { this.vram[a & 0x1FFF] = v; return; }
    if (a < 0x8000) { this.magicWrite(a & 0x1FFF, v); return; }
    if (a < 0xC000) this.cram[a & 0x7FF] = v;
  }

  // Shift (with the previous byte's low 7 bits shifted in), optionally
  // mirror, check for collision with what's there, combine through the ALU.
  magicWrite(o, v) {
    const cur = this.vram[o];
    let d = (((this.lastShift << 8) | v) >> (this.magicCtl & 7)) & 0xFF;
    if (this.magicCtl & 0x08) d = reverse8(d);
    if (d & cur) this.intercept = 0;
    this.vram[o] = ~ALU[this.magicCtl >> 4](d, cur) & 0xFF;
    this.lastShift = v & 0x7F;
  }

  input(p) {
    if (p >= 0x40 && p <= 0x47) return (p & 7) === 4 ? 0x40 : 0x00;   // speech board: never busy
    switch (p) {
      case 0x48: return this.in0;
      case 0x49: return this.in1;
      case 0x4A: return 0xFF;                   // player 2; upright cabinet
      case 0x4C: this.nmiEnabled = 1; return 0;
      case 0x4D: this.nmiEnabled = 0; return 0;
      case 0x4E: return ((this.intercept ? 0 : 1) << 7) | (this.line < 32 || this.line >= 256 ? 1 : 0);
    }
    if (p >= 0x60 && p < 0x80) return this.dsw[p & 7] ?? 0;
    return 0xFF;
  }

  output(p, v) {
    if (p >= 0x40 && p <= 0x47) {
      const n = p & 7;
      if (n === 6) this.sound.control(v);
      else if (n !== 4) this.sound.write(n, v);      // 4 is the speech board
      return;
    }
    switch (p) {
      case 0x4B: this.magicCtl = v; this.lastShift = 0; this.intercept = 1; return;
      case 0x4C: this.nmiEnabled = 1; return;
      case 0x4D: this.nmiEnabled = 0; return;
      case 0x4F: this.irqEnabled = v & 1; return;
    }
  }

  // ---------------------------------------------------------------- inputs

  // IN0: left, right, up, down, fire. IN1: starts, coin (bit 7).
  setInputs(s) {
    this.in0 = 0xFF & ~((s.left ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.up ? 0x04 : 0) | (s.down ? 0x08 : 0) | (s.fire ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.start1 ? 0x01 : 0) | (s.start2 ? 0x02 : 0) | (s.coin ? 0x80 : 0));
  }

  // Switch ports 60-65: test switches off and language, bonus life, three
  // coin chutes at their first setting, free play off.
  applySwitches(v) { this.dsw = [0x3C | v.language, 0x3C | v.bonus, 0xF0, 0xF0, 0xF0, 0x7E, 0, 0]; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      if (this.irqEnabled && IRQ_LINES.includes(line)) this.cpu.irq = true;
      if (this.nmiEnabled && NMI_LINES.includes(line)) this.cpu.nmi();
      if (line === 256) this.render();
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += RATE / (5000000 / 320);
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  render() {
    const out = this.frame, vram = this.vram, cram = this.cram, pens = this.pens;
    for (let y = 0; y < H; y++) {
      const ry = y + TOP;
      for (let xb = 0; xb < 32; xb++) {
        const offs = ry * 32 + xb;
        let d = vram[offs];
        const color = cram[((offs >> 2) & 0x7E0) | (offs & 0x1F)];
        let o = y * W + xb * 8;
        for (let i = 0; i < 8; i++, d <<= 1) out[o++] = d & 0x80 ? pens[i < 4 ? color >> 4 : color & 0x0F] : 0xFF000000;
      }
    }
  }
}

Berzerk.id = 'berzerk';
Berzerk.title = 'Berzerk';
Berzerk.switches = [
  { id: 'bonus', label: 'Bonus life', options: [['5K & 10K', 0xC0], ['5K', 0x40], ['10K', 0x80], ['None', 0x00]], default: 0xC0 },
  { id: 'language', label: 'Language', options: [['English', 0x00], ['German', 0x40], ['French', 0x80], ['Spanish', 0xC0]], default: 0x00 },
];

// Stern Frenzy (1982): the Berzerk board with a bigger program (0000-3FFF and
// C000-CFFF) and its battery-backed RAM moved to F800.
export class Frenzy extends Berzerk {
  read(a) {
    if (a < 0x4000) return this.roms.main[a];
    if (a >= 0xC000 && a < 0xD000) return this.roms.high[a - 0xC000];
    if (a >= 0xF800) return this.ram[a & 0x3FF];
    return super.read(a);
  }
  write(a, v) {
    if (a >= 0xF800) { this.ram[a & 0x3FF] = v; return; }
    if (a < 0x4000 || (a >= 0xC000 && a < 0xD000)) return;
    super.write(a, v);
  }
  // Ports 60-65: bonus life and language, test switches off, coinage 1/1, free play off.
  applySwitches(v) { this.dsw = [v.bonus | v.language, 0xF0, 0x01, 0x01, 0x01, 0x7E, 0, 0]; }
}
Frenzy.id = 'frenzy';
Frenzy.title = 'Frenzy';
Frenzy.switches = [
  { id: 'bonus', label: 'Bonus life', options: [['1K', 0x01], ['2K', 0x02], ['3K', 0x03], ['4K', 0x04], ['5K', 0x05], ['None', 0x00]], default: 0x03 },
  { id: 'language', label: 'Language', options: [['English', 0x00], ['German', 0x40], ['French', 0x80], ['Spanish', 0xC0]], default: 0x00 },
];
