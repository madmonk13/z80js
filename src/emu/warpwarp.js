// Namco Warp & Warp (1981): an Intel 8080 at 2.048 MHz (run here on the Z80
// core, which executes the 8080's documented instructions identically for a
// game like this), a 34x28 grid of 1-bit characters each with its own 8-bit
// color, one hardware "ball" (the bullet), and a simple sound circuit: an
// effects channel (tones from the vertical counter, or noise) and a music
// channel, each with a decaying volume.
//
// 60 Hz; the picture is 272x224 on a vertical monitor.

import { Z80 } from './z80.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { RATE } from './mixer.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 272, H = 224;
const CYCLES_PER_FRAME = 2048000 / 60, LINES = 256;
const CLOCK_16H = 192000, CLOCK_1V = 8000;   // the sound circuit's clocks
const STATE = ['ram', 'vram', 'ballH', 'ballV', 'ballOn', 'cycleCarry', 'sampleCarry', 'in0', 'cpu', 'sound'];

// The sound circuit (see the board's schematics): effects pick a bit of the
// 8 kHz vertical counter (or a 16-bit noise shifter); music divides a 192 kHz
// clock by 4 x (64 - n) and gates a 4-bit counter by a mask. Each channel's
// volume restarts on a write and decays exponentially.
class WarpSound {
  constructor() {
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }
  saveState() { return capture(this, ['sound', 'music1', 'music2', 'sVol', 'mVol', 'sTau', 'mTau', 'vcount', 'mcount', 'vacc', 'macc', 'noise', 'sSig', 'mSig', 'dcIn', 'dcOut']); }
  loadState(s) { apply(this, ['sound', 'music1', 'music2', 'sVol', 'mVol', 'sTau', 'mTau', 'vcount', 'mcount', 'vacc', 'macc', 'noise', 'sSig', 'mSig', 'dcIn', 'dcOut'], s); }
  reset() {
    this.sound = 0; this.music1 = 0; this.music2 = 0;
    this.sVol = 0; this.mVol = 0; this.sTau = 0.12; this.mTau = 0.12;
    this.vcount = 0; this.mcount = 0; this.vacc = 0; this.macc = 0; this.noise = 0;
    this.sSig = 0; this.mSig = 0; this.dcIn = this.dcOut = 0;
    this.writePos = this.readPos = 0;
  }
  writeSound(v) { this.sound = v & 0x0F; this.sVol = 1; this.noise = 0; this.sTau = v & 8 ? 0.12 : 0.24; }
  writeMusic1(v) { this.music1 = v & 0x3F; }
  writeMusic2(v) { this.music2 = v & 0x3F; this.mVol = 1; this.mTau = v & 0x10 ? 0.12 : 0.375; }

  sample() {
    // Music: the counter steps at 192 kHz / (4 x (64 - n)).
    this.macc += CLOCK_16H / (4 * (64 - this.music1)) / RATE;
    while (this.macc >= 1) {
      this.macc -= 1;
      this.mcount++;
      this.mSig = (this.mcount & ~this.music2 & 15) ? 1 : 0;
      if ((this.music2 & 32) && (this.noise & 0x8000)) this.mSig = 1;
    }
    // Effects: the 8 kHz vertical counter; the noise shifter steps every 4.
    this.vacc += CLOCK_1V / RATE;
    while (this.vacc >= 1) {
      this.vacc -= 1;
      this.vcount++;
      if ((this.vcount & 3) === 2) this.noise = ((this.noise << 1) | ((this.noise & 1) === ((this.noise >> 10) & 1) ? 1 : 0)) & 0xFFFF;
      const v = this.vcount;
      switch (this.sound & 7) {
        case 0: this.sSig = v & 0x04 ? 1 : 0; break;
        case 1: this.sSig = v & 0x08 ? 1 : 0; break;
        case 2: this.sSig = v & 0x10 ? 1 : 0; break;
        case 3: this.sSig = v & 0x20 ? 1 : 0; break;
        case 4: this.sSig = !(v & 0x01) && !(v & 0x10) ? 1 : 0; break;
        case 5: this.sSig = !(v & 0x02) && !(v & 0x20) ? 1 : 0; break;
        case 6: this.sSig = !(v & 0x04) && !(v & 0x40) ? 1 : 0; break;
        default: this.sSig = this.noise & 0x8000 ? 1 : 0;
      }
    }
    this.sVol *= Math.exp(-1 / (this.sTau * RATE));
    this.mVol *= Math.exp(-1 / (this.mTau * RATE));
    const s = (this.sSig * this.sVol + this.mSig * this.mVol) * 0.3;
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

export class WarpWarp {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (0000-37FF), chars 2K }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = 60;
    this.controls = 'four-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x400);
    this.vram = new Uint8Array(0x800);          // 4000-43FF codes, 4400-47FF colors
    this.sound = new WarpSound();
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.charPix = decodeTiles(roms.chars, { count: 256, width: 8, height: 8, planes: [0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    // Colors straight from the 8-bit color byte: 3 bits red, 3 green, 2 blue.
    const w = (b0, b1, b2) => 0x1F * b0 + 0x3C * b1 + 0xA4 * b2;
    this.palette = Uint32Array.from({ length: 256 }, (_, i) =>
      rgba(w(i & 1, (i >> 1) & 1, (i >> 2) & 1), w((i >> 3) & 1, (i >> 4) & 1, (i >> 5) & 1), w(0, (i >> 6) & 1, (i >> 7) & 1)));
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.in0 = 0xFF; this.stick = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0);
    this.cpu.reset();
    this.sound.reset();
    this.ballH = this.ballV = 0;
    this.ballOn = 0;
    this.cycleCarry = 0;
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x3800) return this.roms.main[a] ?? 0xFF;
    if (a >= 0x4000 && a < 0x4800) return this.vram[a & 0x7FF];
    if (a >= 0x4800 && a < 0x5000) return this.roms.chars[a & 0x7FF];
    if (a >= 0x8000 && a < 0x8400) return this.ram[a & 0x3FF];
    if (a >= 0xC000 && a < 0xC010) return (this.in0 >> (a & 7)) & 1;
    if (a >= 0xC010 && a < 0xC020) return this.stick;
    if (a >= 0xC020 && a < 0xC030) return (this.dsw >> (a & 7)) & 1;
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x4000 && a < 0x4800) { this.vram[a & 0x7FF] = v; return; }
    if (a >= 0x8000 && a < 0x8400) { this.ram[a & 0x3FF] = v; return; }
    if (a >= 0xC000 && a < 0xC010) {
      switch (a & 3) {
        case 0: this.ballH = v; break;
        case 1: this.ballV = v; break;
        case 2: this.sound.writeSound(v); break;
        // 3: watchdog
      }
    } else if (a >= 0xC010 && a < 0xC020) this.sound.writeMusic1(v);
    else if (a >= 0xC020 && a < 0xC030) this.sound.writeMusic2(v);
    else if (a >= 0xC030 && a < 0xC040 && (a & 7) === 6) {
      // Ball enable, which is also the interrupt enable; low acknowledges.
      this.ballOn = v & 1;
      if (!this.ballOn) this.cpu.irq = false;
    }
  }

  // ---------------------------------------------------------------- inputs

  // IN0 (read a bit at a time): coin, starts, fire, upright cabinet. The
  // joystick goes through the analog "volume" input as one of five levels.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0) | (s.fire ? 0x10 : 0));
    this.stick = s.down ? 0x0F : s.up ? 0x3F : s.left ? 0x6F : s.right ? 0x9F : 0xFF;
  }
  // 1 coin 1 credit, lives, bonus, demo sounds, level select off.
  applySwitches(v) { this.dsw = 0x01 | v.lives | v.bonus | v.demoSounds | 0x80; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const perLine = CYCLES_PER_FRAME / LINES, samplesPerLine = RATE / 60 / LINES;
    let sampleCarry = this.sampleCarry || 0;
    for (let line = 0; line < LINES; line++) {
      if (line === 224) {
        if (this.ballOn) this.cpu.irq = true;    // held until the program drops BALL ON
        this.render();
      }
      this.cycleCarry += perLine;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      sampleCarry += samplesPerLine;
      while (sampleCarry >= 1) { sampleCarry -= 1; this.sound.sample(); }
    }
    this.sampleCarry = sampleCarry;
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, vram = this.vram, pal = this.palette;
    for (let row = 0; row < 28; row++) {
      for (let col = 0; col < 34; col++) {
        const r = row + 2, c = col - 1;
        const offs = c & 0x20 ? r + ((c & 1) << 5) : c + (r << 5);
        const pix = vram[offs] * 64, color = pal[vram[offs + 0x400]];
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y) * W + col * 8;
          for (let x = 0; x < 8; x++) out[o++] = this.charPix[pix + y * 8 + x] ? color : 0xFF000000;
        }
      }
    }
    if (this.ballOn) {                            // the 4x4 ball
      const bx = 264 - this.ballH, by = 240 - this.ballV;
      for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) {
        const x = bx - j, y = by - i;
        if (x >= 0 && x < W && y >= 0 && y < H) out[y * W + x] = pal[0xF6];
      }
    }
    rotate90(out, W, H, this.frame);
  }
}

WarpWarp.id = 'warpwarp';
WarpWarp.title = 'Warp & Warp';
WarpWarp.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x00], ['3', 0x04], ['4', 0x08], ['5', 0x0C]], default: 0x04 },
  { id: 'bonus', label: 'Bonus', options: [['8K/30K', 0x00], ['10K/40K', 0x10], ['15K/60K', 0x20], ['None', 0x30]], default: 0x00 },
  { id: 'demoSounds', label: 'Demo sounds', options: [['On', 0x00], ['Off', 0x40]], default: 0x00 },
];
