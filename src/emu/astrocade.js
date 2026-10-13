// Bally/Midway Astrocade arcade boards (1978-81): Sea Wolf II, Extra Bases,
// Space Zap, Wizard of Wor, Gorf and Robby Roto. The same custom chips as the
// Bally Astrocade home console: a Z80 at 1.79 MHz, a "data" chip that turns
// 2-bit pixels into color through eight color registers, and an "I/O" chip
// with the sound generator and the input ports.
//
// The screen is a 320x204 bitmap of 2-bit pixels (four to a byte) in 16K of
// RAM at 4000. The left part of the screen (up to the color split) uses color
// registers 4-7, the rest 0-3; each register picks one of 32 hues and 8
// brightnesses. Games recolor the screen in bands with scanline interrupts.
//
// Writes to 0000-3FFF go through the "function generator" into the screen at
// 4000 on the way: shifted by 0-3 pixels, expanded from 1 bit to 2, rotated
// a quarter turn, flopped left-right, and ORed or XORed with what's there
// (reporting overlaps through the intercept register). The later games add a
// pattern board, a simple blitter that copies rectangles through the same path.
//
// Wizard of Wor and Gorf also have "sparkle" (pixels of a color shimmer from
// a noise circuit), stars in the background, and a Votrax speech chip.

import { Z80 } from './z80.js';
import { AstrocadeSound } from './astrocade-sound.js';
import { Votrax } from './votrax.js';
import { SoundMix } from './mixer.js';
import { rgba, rotate270 } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const CLOCK = 14318180 / 8;                     // CPU and sound chip
const LINES = 262, LINE_CYCLES = CLOCK / (14318180 / 2 / 455), SAMPLES_PER_LINE = 48000 / (CLOCK / LINE_CYCLES / LINES) / LINES;
const W = 320, H = 204;
const LINE_WIDTH = 455, VERT_OFFSET = 22, HORZ_OFFSET = 16;
const RNG_PERIOD = (1 << 17) - 1;

// 32 hues around the color wheel (the first gray) at 16 brightnesses.
const PALETTE = (() => {
  const pal = new Uint32Array(512);
  for (let color = 0; color < 32; color++) {
    const ry = color ? 0.75 * Math.sin((color / 32) * 2 * Math.PI) : 0;
    const by = color ? 1.15 * Math.cos((color / 32) * 2 * Math.PI) : 0;
    for (let luma = 0; luma < 16; luma++) {
      const y = luma / 15;
      const c = (v) => Math.max(0, Math.min(255, Math.trunc(v * 255)));
      pal[color * 16 + luma] = rgba(c(ry + y), c((y - 0.299 * (ry + y) - 0.114 * (by + y)) / 0.587), c(by + y));
    }
  }
  return pal;
})();

// The sparkle and star noise: one 17-bit shift register run for its whole
// period. Bits 0-3 of each entry are a sparkle brightness, bit 4 marks a star.
let sparkleStar = null;
function sparkleTable() {
  if (sparkleStar) return sparkleStar;
  sparkleStar = new Uint8Array(RNG_PERIOD);
  let sr = 0;
  for (let i = 0; i < RNG_PERIOD; i++) {
    sr = (sr >>> 1) | ((((sr >> 12) ^ ~sr) & 1) << 16);
    sparkleStar[i] = (((sr >> 4) & 1) << 3) | (((sr >> 12) & 1) << 2) | (((sr >> 16) & 1) << 1) | ((sr >> 8) & 1)
      | ((sr & 0xFF) === 0xFE ? 0x10 : 0);
  }
  return sparkleStar;
}

const STATE = ['vram', 'ram', 'colors', 'colorSplit', 'bgData', 'vblank', 'mode', 'intEnable', 'intVector', 'intLine',
  'vFeedback', 'hFeedback', 'holdIrq', 'expandColor', 'fgControl', 'expandCount', 'rotateCount', 'rotateData', 'shiftPrev',
  'intercept', 'pattern', 'protectOpen', 'sparkle', 'frameCount', 'cycleCarry', 'sampleCarry', 'misc', 'cpu', 'sound'];

export class Astrocade {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (64K address space image) }
  constructor(roms) {
    const cfg = this.constructor.config;
    this.cfg = cfg;
    this.rotated = !!cfg.rotate;
    this.width = this.rotated ? H : W;
    this.height = this.rotated ? W : H;
    // Pixels are a little narrower than tall: the 320x204 picture fills 91% of a 4:3 screen's width and 85% of its height.
    const aspect = (W * (4 / 352)) / (H * (3 / 240));
    this.aspect = this.rotated ? 1 / aspect : aspect;
    this.refresh = 60;
    this.controls = cfg.controls;
    this.buttons = 1;
    this.roms = roms;
    this.vram = new Uint8Array(0x4000);
    this.ram = new Uint8Array(cfg.ramSize || 1);
    this.native = new Uint32Array(W * H);
    this.frame = this.rotated ? new Uint32Array(W * H) : this.native;
    if (cfg.stars) this.stars = sparkleTable();

    this.cpu = new Z80({
      read: (a) => this.read(a), write: (a, v) => this.write(a, v),
      input: (p) => this.input(p), output: (p, v) => this.output(p, v),
    });
    this.cpu.onIrqAck = () => { if (this.holdIrq) this.cpu.irq = false; };
    this.chips = [new AstrocadeSound(CLOCK, 0.6)];
    if (cfg.stereo) this.chips.push(new AstrocadeSound(CLOCK, 0.6));
    if (cfg.speech) { this.votrax = new Votrax(0.8); this.chips.push(this.votrax); }
    this.sound = new SoundMix(this.chips, 1);
    this.in = new Uint8Array(4).fill(0xFF);
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.vram.fill(0); this.ram.fill(0);
    this.colors = new Uint8Array(8); this.colorSplit = 0; this.bgData = 0; this.vblank = 0; this.mode = 0;
    this.intEnable = 0; this.intVector = 0; this.intLine = 0; this.vFeedback = 0; this.hFeedback = 0; this.holdIrq = 1;
    this.expandColor = new Uint8Array(2); this.fgControl = 0; this.expandCount = 0; this.rotateCount = 0;
    this.rotateData = new Uint8Array(4); this.shiftPrev = 0; this.intercept = 0;
    this.pattern = new Uint16Array(6);         // source, mode, dest, skip, width, height
    this.protectOpen = 0;
    this.sparkle = new Uint8Array(4);
    this.misc = new Uint8Array(8);             // game-specific latches (see subclasses)
    this.frameCount = 0;
    this.cycleCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- memory

  read(a) {
    const cfg = this.cfg;
    if (a >= 0x4000 && a < 0x8000) return this.vram[a - 0x4000];
    if (a >= cfg.ramBase && a < cfg.ramBase + cfg.ramSize) {
      if (cfg.protSize && a < cfg.ramBase + cfg.protSize) this.protectOpen = 0;
      return this.ram[a - cfg.ramBase];
    }
    return this.roms.main[a];
  }

  write(a, v) {
    const cfg = this.cfg;
    if (a < 0x4000) { this.funcgen(a, v); return; }
    if (a < 0x8000) { this.vram[a - 0x4000] = v; return; }
    if (a >= cfg.ramBase && a < cfg.ramBase + cfg.ramSize) {
      if (cfg.protSize && a < cfg.ramBase + cfg.protSize) {
        if (this.protectOpen) this.ram[a - cfg.ramBase] = v;
        this.protectOpen = 0;
        return;
      }
      this.ram[a - cfg.ramBase] = v;
    }
  }

  // ---------------------------------------------------------------- function generator

  // Control: bits 0-1 shift, 2 rotate, 3 expand, 4 OR, 5 XOR, 6 flop.
  funcgen(offset, v) {
    const c = this.fgControl;
    if (c & 0x08) {
      this.expandCount ^= 1;
      v >>= 4 * this.expandCount;
      const e = this.expandColor;
      v = (e[(v >> 3) & 1] << 6) | (e[(v >> 2) & 1] << 4) | (e[(v >> 1) & 1] << 2) | e[v & 1];
    }
    const prev = this.shiftPrev;
    this.shiftPrev = v;
    if (c & 0x04) {
      // Rotate: four writes gather a 4x4 block of pixels, the next four write it turned.
      if (!(this.rotateCount & 4)) { this.rotateData[this.rotateCount++ & 3] = v; return; }
      const sh = 2 * (~this.rotateCount++ & 3), d = this.rotateData;
      v = (((d[3] >> sh) & 3) << 6) | (((d[2] >> sh) & 3) << 4) | (((d[1] >> sh) & 3) << 2) | ((d[0] >> sh) & 3);
    } else {
      const sh = 2 * (c & 3);
      v = ((v >> sh) | (prev << (8 - sh))) & 0xFF;
    }
    if (c & 0x40) v = ((v >> 6) | ((v >> 2) & 0x0C) | ((v << 2) & 0x30) | (v << 6)) & 0xFF;
    const a = 0x4000 + offset;
    if (c & 0x30) {
      const old = this.read(a);
      this.intercept &= 0x0F;
      if ((old & 0xC0) && (v & 0xC0)) this.intercept |= 0x11;
      if ((old & 0x30) && (v & 0x30)) this.intercept |= 0x22;
      if ((old & 0x0C) && (v & 0x0C)) this.intercept |= 0x44;
      if ((old & 0x03) && (v & 0x03)) this.intercept |= 0x88;
      v = c & 0x10 ? v | old : v ^ old;
    }
    this.write(a, v);
  }

  // ---------------------------------------------------------------- pattern board

  // Mode bits: 0 direction (copy dest to source), 1 expand (source steps every
  // other byte), 2 source steps at all, 3 flush (last byte of each row is 0),
  // 4 dest carry direction, 5 dest steps up rather than down.
  blit() {
    const p = this.pattern, mode = p[1];
    let src = p[0], dest = p[2], height = p[5];
    let ff = mode & 0x02 ? 0 : 1, cycles = 0;
    const stepSrc = (w) => {
      if (ff && (mode & 0x04) && (w !== 0 || !(mode & 0x08))) src = (src + 1) & 0xFFFF;
      if (mode & 0x02) ff ^= 1;
    };
    const stepDest = (w) => { if (w !== 0) dest = (dest + (mode & 0x20 ? 1 : -1)) & 0xFFFF; };
    for (;;) {
      let w = p[4];
      for (;;) {
        const from = mode & 1 ? dest : src;
        const v = w === 0 && (mode & 0x08) ? 0 : this.read(from);
        if (mode & 1) stepDest(w); else stepSrc(w);
        this.write(mode & 1 ? src : dest, v);
        if (mode & 1) stepSrc(w); else stepDest(w);
        cycles += 4;
        if (w-- === 0) break;
      }
      const carry = ((dest & 0xFF) + p[3]) & 0x100;
      dest = (dest & 0xFF00) | ((dest + p[3]) & 0xFF);
      dest = (mode & 0x10 ? dest - (carry ^ 0x100) : dest + carry) & 0xFFFF;
      if (height-- === 0) break;
    }
    p[0] = src; p[2] = dest; p[5] = 0xFF;
    this.cpu.cycles += cycles;
  }

  patternWrite(r, v) {
    const p = this.pattern;
    switch (r) {
      case 0: p[0] = (p[0] & 0xFF00) | v; break;
      case 1: p[0] = (p[0] & 0xFF) | (v << 8); break;
      case 2: p[1] = v & 0x3F; p[2] &= 0xFF00; break;
      case 3: p[3] = v; break;
      case 4: p[2] = ((p[2] + p[3]) & 0xFF) | (v << 8); break;
      case 5: p[4] = v; break;
      case 6: p[5] = v; this.blit(); break;
    }
  }

  // ---------------------------------------------------------------- I/O

  input(port) {
    const lo = port & 0xFF;
    const v = this.gameInput(lo, port);
    if (v !== undefined) return v;
    switch (lo) {
      case 0x08: { const r = this.intercept; this.intercept = 0; return r; }
      case 0x0E: return this.vFeedback;
      case 0x0F: return this.hFeedback;
      case 0x10: case 0x11: case 0x12: case 0x13: return this.handle(lo - 0x10);
    }
    return 0xFF;
  }

  output(port, v) {
    const lo = port & 0xFF;
    if (this.gameOutput(lo, port, v)) return;
    if (lo < 8) { this.colors[lo] = v; return; }
    switch (lo) {
      case 0x08: this.mode = v & 1; return;
      case 0x09: this.colorSplit = 2 * (v & 0x3F); this.bgData = ((v & 0xC0) >> 6) * 0x55; return;
      case 0x0A: this.vblank = v; return;
      case 0x0B: this.colors[(port >> 8) & 7] = v; return;
      case 0x0C: this.fgControl = v; this.expandCount = 0; this.rotateCount = 0; this.shiftPrev = 0; return;
      case 0x0D: this.intVector = v; return;
      case 0x0E: this.intEnable = v; return;
      case 0x0F: this.intLine = v; return;
      case 0x19: this.expandColor[0] = v & 3; this.expandColor[1] = (v >> 2) & 3; return;
    }
    if (lo >= 0x10 && lo <= 0x18 && this.cfg.sound !== false) this.soundWrite(this.chips[0], port, v);
    else if (lo >= 0x50 && lo <= 0x58 && this.cfg.stereo) this.soundWrite(this.chips[1], port, v);
    else if (lo >= 0x78 && lo <= 0x7E && this.cfg.pattern) this.patternWrite(lo - 0x78, v);
    else if (port === 0xA55B) this.protectOpen = 1;
  }

  soundWrite(chip, port, v) {
    // Port x8 is the block transfer: the register number rides on the address's high byte.
    if (port & 8) chip.write((port >> 8) & 7, v); else chip.write(port & 7, v);
  }

  // Overridden by games with extra ports; undefined/false means "not mine".
  gameInput() { return undefined; }
  gameOutput() { return false; }
  handle(n) { return this.in[n]; }

  // ---------------------------------------------------------------- interrupts

  raise(vector, hold) {
    this.cpu.irqVector = vector;
    this.cpu.irq = true;
    this.holdIrq = hold ? 1 : 0;
    // "Pulse" mode: the line is up for one instruction only.
    if (!hold) { this.cpu.run(1); this.cpu.irq = false; }
  }

  lineInterrupt(line) {
    const e = this.intEnable;
    if (line === this.intLine && (e & 0x08)) this.raise(this.intVector, !(e & 0x04));
    else if (this.cfg.lightpen && (e & 0x12)) {
      // On these boards the horizontal drive feeds the light pen input: an interrupt every line.
      this.raise(this.intVector & 0xF0, !(e & 0x01));
      this.vFeedback = line; this.hFeedback = 8;
    }
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      this.lineInterrupt(line);
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      if (line < H) this.drawLine(line);
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    this.frameCount = (this.frameCount + 1) >>> 0;
    if (this.rotated) rotate270(this.native, W, H, this.frame);
  }

  drawLine(y) {
    const out = this.native, hi = this.mode, step = 2 - hi;
    const stars = this.stars, sparkle = this.sparkle;
    let offset = Math.floor(y / step) * (80 / step);
    const inPicture = y < this.vblank;
    let sparkOffs = 0, starOffs = 0;
    if (stars) {
      const screenY = (y + VERT_OFFSET) % LINES;
      sparkOffs = ((this.frameCount * (LINE_WIDTH * LINES)) % RNG_PERIOD + screenY * LINE_WIDTH + HORZ_OFFSET) % RNG_PERIOD;
      starOffs = y * LINE_WIDTH + HORZ_OFFSET;
    }
    let o = y * W;
    for (let x = 0; x < 80; x += step) {
      const base = x < this.colorSplit ? 4 : 0;
      let data = inPicture ? this.vram[offset++] : this.bgData;
      for (let i = 0; i < 4; i++) {
        const pix = (data >> 6) & 3;
        let col = this.colors[base + pix] << 1, luma = col & 0x0F;
        if (stars) {
          if (sparkle[pix] === 0) {
            if (pix !== 0 || (stars[starOffs] & 0x10)) luma = stars[sparkOffs] & 0x0F;
            else col = luma = 0;
          }
          starOffs++;
          if (++sparkOffs >= RNG_PERIOD) sparkOffs = 0;
          if (step === 2) { starOffs++; if (++sparkOffs >= RNG_PERIOD) sparkOffs = 0; }
        }
        const c = PALETTE[(col & 0x1F0) | luma];
        out[o++] = c;
        if (step === 2) out[o++] = c;
        data <<= 2;
      }
    }
  }
}

// ---------------------------------------------------------------- the games

const COIN_SWITCHES = [];

// Gorf (1981): five missions; a vertical monitor; Votrax speech.
export class Gorf extends Astrocade {
  // P1: coins, service, tilt, starts, cabinet, speech on. P3: stick, fire, speech ready (bit 7).
  setInputs(s) {
    this.in[0] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x10 : 0) | (s.start2 ? 0x20 : 0));
    this.in[2] = 0x7F & ~((s.up ? 0x01 : 0) | (s.down ? 0x02 : 0) | (s.left ? 0x04 : 0) | (s.right ? 0x08 : 0) | (s.fire ? 0x10 : 0));
  }
  applySwitches(v) { this.in[3] = 0x01 | 0x06 | 0x08 | v.lives | v.bonus | 0x40 | 0x80; }
  handle(n) { return n === 2 ? this.in[2] | (this.votrax.ready() ? 0x80 : 0) : this.in[n]; }
  gameInput(lo, port) {
    const bit = (port >> 8) & 1, which = (port >> 9) & 7;
    if (lo === 0x15) {
      if (which >= 2 && which <= 5) this.sparkle[which - 2] = bit;
      else if (which === 6) this.chips[0].gain = bit ? 0 : 0.6;   // the upper speaker gives way to speech
      return 0xFF;
    }
    if (lo === 0x16) return 0xFF;                   // lamps
    if (lo === 0x17) { this.votrax.write(port >> 8); return port >> 8; }
    return undefined;
  }
}
Gorf.config = { ramBase: 0xD000, ramSize: 0x1000, protSize: 0x40, stereo: true, pattern: true, lightpen: true, stars: true, speech: true, rotate: true, controls: 'eight-way' };
Gorf.id = 'gorf';
Gorf.title = 'Gorf';
Gorf.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x10], ['3', 0x00]], default: 0x00 },
  { id: 'bonus', label: 'Bonus life', options: [['Mission 5', 0x00], ['None', 0x20]], default: 0x00 },
];

// Wizard of Wor (1980): dungeon mazes, two players at once; Votrax speech.
export class WizardOfWor extends Astrocade {
  // P1: coins, service, tilt, starts, no flip. P3: stick, fire (bit 5), speech ready (bit 7).
  setInputs(s) {
    this.in[0] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0));
    this.in[1] = 0xEF;                              // player 2 idle (bit 4 is active high)
    this.in[2] = 0x6F & ~((s.up ? 0x01 : 0) | (s.down ? 0x02 : 0) | (s.left ? 0x04 : 0) | (s.right ? 0x08 : 0) | (s.fire ? 0x20 : 0));
  }
  applySwitches(v) { this.in[3] = 0x01 | 0x06 | 0x08 | v.lives | v.bonus | 0x40 | 0x80; }
  handle(n) { return n === 2 ? this.in[2] | (this.votrax.ready() ? 0x80 : 0) : this.in[n]; }
  gameInput(lo, port) {
    if (lo === 0x15) {
      const which = (port >> 9) & 7;
      if (which >= 2 && which <= 5) this.sparkle[which - 2] = (port >> 8) & 1;
      return 0xFF;
    }
    if (lo === 0x17) { this.votrax.write(port >> 8); return port >> 8; }
    return undefined;
  }
}
WizardOfWor.config = { ramBase: 0xD000, ramSize: 0x1000, protSize: 0x40, stereo: true, pattern: true, lightpen: true, stars: true, speech: true, controls: 'eight-way' };
WizardOfWor.id = 'wow';
WizardOfWor.title = 'Wizard of Wor';
WizardOfWor.switches = [
  { id: 'lives', label: 'Lives', options: [['2 a credit', 0x10], ['3 a credit', 0x00]], default: 0x00 },
  { id: 'bonus', label: 'Bonus life', options: [['3rd level', 0x20], ['4th level', 0x00]], default: 0x20 },
];

// Robby Roto (1981): dig tunnels, rescue hostages.
export class RobbyRoto extends Astrocade {
  setInputs(s) {
    this.in[0] = 0x7F & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0));
    this.in[2] = 0xFF & ~((s.up ? 0x01 : 0) | (s.down ? 0x02 : 0) | (s.left ? 0x04 : 0) | (s.right ? 0x08 : 0) | (s.fire ? 0x20 : 0));
  }
  // No NVRAM use (the board starts from defaults each time), upright, demo sounds.
  applySwitches() { this.in[3] = 0x00 | 0x02 | 0x04 | 0x08 | 0x80; }
  gameInput(lo) { return lo === 0x15 ? 0xFF : undefined; }
}
RobbyRoto.config = { ramBase: 0xE000, ramSize: 0x2000, protSize: 0x200, stereo: true, pattern: true, controls: 'four-way' };
RobbyRoto.id = 'robby';
RobbyRoto.title = 'Robby Roto';
RobbyRoto.switches = COIN_SWITCHES;

// Space Zap (1980): a fixed cannon at the center, aimed in four directions.
export class SpaceZap extends Astrocade {
  setInputs(s) {
    this.in[0] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x10 : 0) | (s.start2 ? 0x20 : 0));
    this.in[2] = 0xFF & ~((s.up ? 0x01 : 0) | (s.down ? 0x02 : 0) | (s.left ? 0x04 : 0) | (s.right ? 0x08 : 0) | (s.fire ? 0x10 : 0));
  }
  applySwitches() { this.in[3] = 0x01 | 0x06 | 0xC0; }
  // Port 13 reads the player's handle on this board (and drives the coin counters).
  gameInput(lo) { return lo === 0x13 ? this.in[2] : undefined; }
}
SpaceZap.config = { ramBase: 0xD000, ramSize: 0x800, protSize: 0x40, pattern: true, controls: 'four-way' };
SpaceZap.id = 'spacezap';
SpaceZap.title = 'Space Zap';
SpaceZap.switches = COIN_SWITCHES;

// Extra Bases (1980): baseball with a trackball (here, the stick moves it).
export class ExtraBases extends Astrocade {
  constructor(roms) {
    super(roms);
    this.analogStick = true;
  }
  setInputs(s) {
    this.in[0] = 0x33 & ~((s.fire ? 0x02 : 0) | (s.start1 ? 0x10 : 0) | (s.start2 ? 0x20 : 0));
    this.in[1] = 0x07 & ~(s.coin ? 0x01 : 0);
    const a = s.analog || { x: (s.right ? 1 : 0) - (s.left ? 1 : 0), y: (s.down ? 1 : 0) - (s.up ? 1 : 0) };
    // misc[4-7]: the trackball counters (player 2 X, Y, player 1 X, Y).
    this.misc[6] = (this.misc[6] + Math.round(a.x * 6)) & 0xFF;
    this.misc[7] = (this.misc[7] - Math.round(a.y * 6)) & 0xFF;
  }
  applySwitches() { this.in[3] = 0x00; }
  handle(n) { return n === 2 ? this.misc[4 + (this.misc[0] & 3)] : this.in[n]; }
  gameOutput(lo, port, v) {
    if ((lo & 0xF8) === 0x20) return true;        // coin counter
    if ((lo & 0xF8) === 0x28) { this.misc[0] = v & 3; return true; }
    return false;
  }
}
ExtraBases.config = { ramBase: 0x10000, ramSize: 0, controls: 'eight-way' };
ExtraBases.id = 'ebases';
ExtraBases.title = 'Extra Bases';
ExtraBases.switches = COIN_SWITCHES;

// Sea Wolf II (1978): two periscopes, torpedoes at passing ships. No sound chip:
// the original's sound board is approximated (see seawolfSound below).
export class SeaWolf2 extends Astrocade {
  constructor(roms) {
    super(roms);
    this.controls = 'two-way';
    this.spinner = true;
    this.dialSpeed = 1;
    this.sfx = new SeaWolfSound();
    this.sound = new SoundMix([this.sfx], 1);
  }
  reset() { super.reset(); this.misc[1] = 0x1F; }   // misc[1]: periscope position, 0-63
  setInputs(s) {
    if (s.spin) this.misc[1] = Math.max(0, Math.min(63, this.misc[1] + Math.round(s.spin)));
    // P2HANDLE is player 1's periscope (a 64-position Gray-like code) and fire.
    this.in[1] = SCOPE_CODE[this.misc[1]] | (s.fire ? 0x80 : 0);
    this.in[0] = SCOPE_CODE[0x1F];
    this.in[2] = (s.coin ? 0x01 : 0) | (s.start1 ? 0x02 : 0) | (s.start2 ? 0x04 : 0);
  }
  applySwitches(v) { this.in[3] = 0x01 | v.time | 0x08 | v.extended | 0x40 | 0x80; }
  gameOutput(lo, port, v) {
    if ((lo & 0xE7) === 0x40) { this.sfx.write(lo & 3, v); return true; }
    return false;
  }
}
SeaWolf2.config = { ramBase: 0xC000, ramSize: 0x400, sound: false, controls: 'two-way' };
SeaWolf2.id = 'seawolf2';
SeaWolf2.title = 'Sea Wolf II';
SeaWolf2.switches = [
  { id: 'time', label: 'Play time', options: [['40', 0x06], ['50', 0x04], ['60', 0x02], ['70', 0x00]], default: 0x00 },
  { id: 'extended', label: 'Extended play', options: [['None', 0x00], ['5000', 0x10], ['6000', 0x20], ['7000', 0x30]], default: 0x00 },
];

// The periscope's position code (64 positions; the board reads it through a remapping ROM).
const SCOPE_CODE = [
  0x20, 0x21, 0x23, 0x22, 0x26, 0x27, 0x25, 0x24, 0x2c, 0x2d, 0x2f, 0x2e, 0x2a, 0x2b, 0x29, 0x28,
  0x38, 0x39, 0x3b, 0x3a, 0x3e, 0x3f, 0x3d, 0x3c, 0x34, 0x35, 0x37, 0x36, 0x32, 0x33, 0x31, 0x30,
  0x10, 0x11, 0x13, 0x12, 0x16, 0x17, 0x15, 0x14, 0x1c, 0x1d, 0x1f, 0x1e, 0x1a, 0x1b, 0x19, 0x18,
  0x08, 0x09, 0x0b, 0x0a, 0x0e, 0x0f, 0x0d, 0x0c, 0x04, 0x05, 0x07, 0x06, 0x02, 0x03, 0x01, 0x00,
];

// Sea Wolf II's discrete sound board, approximated: torpedo launch, ship and
// mine explosions, the dive klaxon and sonar pings, started by rising bits on
// ports 40 and 41 (bit 7 of 41 enables most of them).
const SEAWOLF_STATE = ['last', 'voices', 'rng', 't'];

class SeaWolfSound {
  constructor() { this.reset(); }
  saveState() { return capture(this, SEAWOLF_STATE); }
  loadState(s) { apply(this, SEAWOLF_STATE, s); }
  reset() { this.last = new Uint8Array(2).fill(0xFF); this.voices = new Float64Array(5); this.rng = 1; this.t = 0; this.out = 0; }
  write(port, v) {
    if (port > 1) return;                          // 42-43: lamps
    const rise = v & ~this.last[port];
    this.last[port] = v;
    const V = this.voices;
    if (port === 0) {
      if (rise & 0x09) V[0] = 1;                   // torpedo
      if (rise & 0x12) V[1] = 1;                   // ship hit
      if (rise & 0x24) V[2] = 1;                   // mine hit
    } else {
      if (rise & 0x08) V[3] = 1;                   // dive
      if (rise & 0x30) V[4] = 1;                   // sonar
    }
  }
  sample() {
    const V = this.voices, dt = 1 / 48000;
    if (!(this.last[1] & 0x80)) { this.out = 0; return; }
    this.t = (this.t + dt) % 1000;
    this.rng = (this.rng * 1103515245 + 12345) >>> 0;
    const noise = ((this.rng >>> 16) & 0x7FFF) / 16384 - 1;
    let s = 0;
    // Torpedo: a hiss with a falling whistle, 0.6 s.
    if (V[0] > 0) { s += V[0] * (0.4 * noise * 0.5 + 0.3 * Math.sign(Math.sin(this.t * 2 * Math.PI * (300 + 900 * V[0])))); V[0] -= dt / 0.6; }
    // Explosions: low noise, 1.2 s and 0.8 s.
    if (V[1] > 0) { s += V[1] * V[1] * noise; V[1] -= dt / 1.2; }
    if (V[2] > 0) { s += V[2] * V[2] * noise * 0.8; V[2] -= dt / 0.8; }
    // Dive klaxon: a buzzing two-tone, 1 s.
    if (V[3] > 0) { s += 0.3 * Math.sign(Math.sin(this.t * 2 * Math.PI * (V[3] > 0.5 ? 400 : 330))); V[3] -= dt / 1.0; }
    // Sonar: a fading 1.1 kHz ping, 0.5 s.
    if (V[4] > 0) { s += 0.4 * V[4] * V[4] * Math.sin(this.t * 2 * Math.PI * 1100); V[4] -= dt / 0.5; }
    this.out = s * 0.5;
  }
}
