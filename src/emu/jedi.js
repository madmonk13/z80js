// Atari Return of the Jedi (1984): a 6502 at 2.5 MHz with banked program ROM,
// and a second 6502 at 1.5 MHz playing four POKEYs and a TMS5220 for the
// film's speech. The picture mixes three layers with no priority logic: the
// background (256x256 of 8x8 tiles, doubled to 512x512 by a smoothing circuit
// that blends neighboring pixels through two PROMs), 48 motion objects and a
// 2-bit text layer each supply some bits of one 10-bit color address
// (background in bits 0-3, objects 4-7, text 8-9), and the program sets up
// the 1024 colors so that the right layer shows. Controlled with a flight yoke.
// 296x240 at 60 Hz; both CPUs are interrupted four times a frame.

import { CPU6502 } from './m6502.js';
import { Pokey, PokeyVoice } from './pokey.js';
import { TMS5220 } from './tms5220.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { capture, apply } from './state.js';

const W = 296, H = 240, LINES = 262, REFRESH = 60;
const MAIN_LINE = 2500000 / REFRESH / LINES, SOUND_LINE = 1512000 / REFRESH / LINES, SAMPLES = RATE / REFRESH / LINES;
const SPEECH_EVERY = RATE / 8000;
const STATE = ['ram', 'nvram', 'bgRam', 'palRam', 'vram', 'spriteRam', 'soundRam', 'bank', 'alphaBank', 'videoOff', 'smooth',
  'hscroll', 'vscroll', 'adcSel', 'nvEnabled', 'soundOn', 'soundLatch', 'ackLatch', 'comm', 'speechData', 'speechStrobe',
  'yoke', 'in0', 'cycleCarry', 'soundCarry', 'sampleCarry', 'speechCarry', 'cpu', 'snd', 'sound', 'speech'];

export class ReturnOfTheJedi {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 1024; i++) this.setColor(i); }

  // roms: { main 64K (8000-FFFF at 8000), banks 48K (three 16K pages at 4000), sound 32K (8000),
  //         chars 8K, tiles 64K, sprites 128K, smooth 2K (the two smoothing PROMs) }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.analogStick = true;
    this.buttons = 1;                              // the yoke's trigger and thumb buttons all fire
    this.roms = roms;
    this.ram = new Uint8Array(0x800);
    this.nvram = new Uint8Array(0x100);            // 0800-08FF, kept between sessions
    this.bgRam = new Uint8Array(0x800);            // 2000-27FF: tile codes, then bank bits
    this.palRam = new Uint8Array(0x800);           // 2800-2FFF: low bytes, then high
    this.vram = new Uint8Array(0x7C0);             // 3000-37BF: text
    this.spriteRam = new Uint8Array(0x440);        // 37C0-3BFF
    this.soundRam = new Uint8Array(0x800);
    this.palette = new Uint32Array(1024).fill(0xFF000000);
    this.yoke = new Float64Array(2);

    this.cpu = new CPU6502({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.snd = new CPU6502({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.pokeys = [0, 1, 2, 3].map(() => new Pokey(1512000, 0.6));
    this.speech = new TMS5220(1);
    this.sound = new SoundMix([...this.pokeys.map((p) => new PokeyVoice(p)), this.speech], 1);
    this.frame = new Uint32Array(W * H);

    this.charPix = decodeTiles(roms.chars, { count: roms.chars.length / 16, width: 8, height: 8, planes: [0, 1], xs: run(0, 8, 2), ys: run(0, 8, 16), size: 128 });
    const half = (rom) => rom.length * 4;
    this.tilePix = decodeTiles(roms.tiles, {
      count: roms.tiles.length / 32, width: 8, height: 8, planes: [0, 4, half(roms.tiles), half(roms.tiles) + 4],
      xs: [0, 1, 2, 3, 8, 9, 10, 11], ys: run(0, 8, 16), size: 128,
    });
    this.spritePix = decodeTiles(roms.sprites, {
      count: roms.sprites.length / 64, width: 8, height: 16, planes: [0, 4, half(roms.sprites), half(roms.sprites) + 4],
      xs: [0, 1, 2, 3, 8, 9, 10, 11], ys: run(0, 16, 16), size: 256,
    });
    this.bgRaw = new Uint8Array(256 * 256);        // the background's pens before smoothing
    this.moBuf = new Uint8Array(W * H);            // motion object pens this frame
    this.in0 = 0xFF;
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.bgRam, this.palRam, this.vram, this.spriteRam, this.soundRam]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.bank = 0; this.alphaBank = 0; this.videoOff = 0; this.smooth = 0; this.hscroll = 0; this.vscroll = 0;
    this.adcSel = 0; this.nvEnabled = 0; this.soundOn = 0;
    this.soundLatch = 0; this.ackLatch = 0; this.comm = 0; this.speechData = 0; this.speechStrobe = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = this.speechCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset(); this.speech.reset();
  }

  // 12-bit color: blue 0-2, green 3-5, red 6-8, intensity 9-11; each gun 5 x level x intensity.
  setColor(i) {
    const c = this.palRam[i] | (this.palRam[0x400 + i] << 8), k = 5 * ((c >> 9) & 7);
    this.palette[i] = rgba(k * ((c >> 6) & 7), k * ((c >> 3) & 7), k * (c & 7));
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a >= 0x8000) return this.roms.main[a - 0x8000];
    if (a >= 0x4000) return this.roms.banks[this.bank * 0x4000 + a - 0x4000];
    if (a < 0x800) return this.ram[a];
    if (a < 0x900) return this.nvram[a - 0x800];
    if (a >= 0x2000 && a < 0x2800) return this.bgRam[a - 0x2000];
    if (a >= 0x2800 && a < 0x3000) return this.palRam[a - 0x2800];
    if (a >= 0x3000 && a < 0x37C0) return this.vram[a - 0x3000];
    if (a >= 0x37C0 && a < 0x3C00) return this.spriteRam[a - 0x37C0];
    switch (a) {
      case 0x0C00: return this.in0;
      // Bit 7 vertical blank, 6 a command waiting for the sound CPU, 5 its reply waiting; tilt off.
      case 0x0C01: return 0x1B | ((this.comm >> 1) & 0x60) | (this.line >= H ? 0x80 : 0);
      case 0x1400: this.comm &= ~0x40; return this.ackLatch;
      case 0x1800: return this.adcSel === 0 ? this.axis(1) : this.adcSel === 2 ? this.axis(0) : 0;
    }
    return 0;
  }

  write(a, v) {
    if (a < 0x800) { this.ram[a] = v; return; }
    if (a < 0x900) { if (this.nvEnabled) this.nvram[a - 0x800] = v; return; }
    if (a >= 0x2000 && a < 0x2800) { this.bgRam[a - 0x2000] = v; return; }
    if (a >= 0x2800 && a < 0x3000) { this.palRam[a - 0x2800] = v; this.setColor((a - 0x2800) & 0x3FF); return; }
    if (a >= 0x3000 && a < 0x37C0) { this.vram[a - 0x3000] = v; return; }
    if (a >= 0x37C0 && a < 0x3C00) { this.spriteRam[a - 0x37C0] = v; return; }
    if (a >= 0x3C00 && a < 0x3C02) { this.vscroll = v | ((a & 1) << 8); return; }
    if (a >= 0x3D00 && a < 0x3D02) { this.hscroll = v | ((a & 1) << 8); return; }
    if (a >= 0x3E00 && a < 0x4000) { this.smooth = v & 3; return; }       // the PIXI smoothing table
    if (a >= 0x1C80 && a <= 0x1C82) { this.adcSel = a - 0x1C80; return; }
    switch (a) {
      case 0x1C00: this.nvEnabled = 1; return;
      case 0x1C01: this.nvEnabled = 0; return;
      case 0x1E00: this.cpu.irq = false; return;
      case 0x1E84: this.alphaBank = v & 0x80 ? 256 : 0; return;
      case 0x1E86: {                                // the sound CPU's reset line
        const on = v & 1;
        if (on && !this.soundOn) this.snd.reset();
        this.soundOn = on;
        return;
      }
      case 0x1E87: this.videoOff = v; return;
      case 0x1F00: this.soundLatch = v; this.comm |= 0x80; return;
      case 0x1F80: if (v & 1) this.bank = 0; if (v & 2) this.bank = 1; if (v & 4) this.bank = 2; return;
      // 1D00 NVRAM store, 1D80 watchdog, 1E80-1E83 coin counters and LEDs.
    }
  }

  // The yoke: 0x80 centered; axis 0 left-right, 1 up-down (pulling back reads high).
  axis(n) { return Math.max(0, Math.min(255, Math.round(0x80 + this.yoke[n] * 0x7F))); }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a >= 0x8000) return this.roms.sound[a - 0x8000];
    if (a < 0x800) return this.soundRam[a];
    if (a < 0x840) return this.pokeys[(a >> 4) & 3].read(a & 15);
    switch (a) {
      case 0x1800: this.comm &= ~0x80; return this.soundLatch;
      case 0x1C00: return this.speech.ready() ? 0 : 0x80;
      case 0x1C01: return this.comm;
    }
    return 0;
  }

  soundWrite(a, v) {
    if (a < 0x800) { this.soundRam[a] = v; return; }
    if (a < 0x840) { this.pokeys[(a >> 4) & 3].write(a & 15, v); return; }
    if (a === 0x1000) { this.snd.irq = false; return; }
    if (a >= 0x1100 && a < 0x1200) { this.speechData = v; return; }
    if (a >= 0x1200 && a < 0x1400) {               // the speech write strobe: 1200 on, 1300 off; data goes in on the way up
      const on = a < 0x1300 ? 1 : 0;
      if (on && !this.speechStrobe) this.speech.write(this.speechData);
      this.speechStrobe = on;
      return;
    }
    if (a === 0x1400) { this.ackLatch = v; this.comm |= 0x40; }
    // 1500 speech chip reset.
  }

  // ---------------------------------------------------------------- inputs

  // The yoke follows a real stick where there is one; otherwise the d-pad steers it, springing back.
  // 0C00 (active low): the thumb buttons and triggers, then coins.
  setInputs(s) {
    const y = this.yoke;
    if (s.analog) { y[0] = s.analog.x; y[1] = s.analog.y; }
    else {
      const tx = (s.right ? 1 : 0) - (s.left ? 1 : 0), ty = (s.down ? 1 : 0) - (s.up ? 1 : 0);
      y[0] += Math.max(-0.08, Math.min(0.08, tx - y[0]));
      y[1] += Math.max(-0.08, Math.min(0.08, ty - y[1]));
    }
    const fire = s.fire || s.fire2 || s.start1;
    this.in0 = 0xFF & ~((fire ? 0x07 : 0) | (s.coin ? 0x80 : 0));
  }
  applySwitches() {}

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      // /32V: the interrupt goes up at lines 64, 128, 192 and 256 and is dropped 32 lines later.
      if (line % 32 === 0 && line >= 32) {
        const on = !(line & 32);
        this.cpu.irq = on;
        this.snd.irq = on;
      }
      if (line === H) this.render();
      this.cycleCarry += MAIN_LINE;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      if (this.soundOn) { this.soundCarry += SOUND_LINE; this.soundCarry -= this.snd.run(Math.floor(this.soundCarry)); }
      this.sampleCarry += SAMPLES;
      while (this.sampleCarry >= 1) {
        this.sampleCarry -= 1;
        if (++this.speechCarry >= SPEECH_EVERY) { this.speechCarry -= SPEECH_EVERY; this.speech.clock(); }
        this.sound.sample();
      }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, pal = this.palette;
    if (this.videoOff) { out.fill(0xFF000000); return; }
    // The background's raw pens: 32x32 tiles, the bank bits shuffled into the code; bit 2 flips x.
    const bg = this.bgRam, raw = this.bgRaw, tiles = this.tilePix;
    for (let offs = 0; offs < 0x400; offs++) {
      const bank = bg[offs + 0x400] & 15;
      const code = bg[offs] | ((bank & 1) << 8) | ((bank & 8) << 6) | ((bank & 2) << 9), flip = bank & 4;
      const x0 = (offs & 31) * 8, y0 = (offs >> 5) * 8, src = code * 64;
      for (let y = 0; y < 8; y++) {
        const o = (y0 + y) * 256 + x0;
        for (let x = 0; x < 8; x++) raw[o + x] = tiles[src + y * 8 + (flip ? 7 - x : x)];
      }
    }
    // Motion objects: 48, 8x16 (or 8x32 when tall), pen 0 clear; later ones on top.
    const mo = this.moBuf, spr = this.spriteRam, sp = this.spritePix;
    mo.fill(0);
    for (let n = 0; n < 0x30; n++) {
      const flags = spr[n + 0x40];
      const x = spr[n + 0x100] + ((flags & 1) << 8) - 2, y = 240 - spr[n + 0x80] + 1;
      const fx = flags & 0x10, fy = flags & 0x20, tall = flags & 0x08;
      const bank = ((flags & 2) >> 1) | ((flags & 0x40) >> 5) | (flags & 4);
      let code = spr[n] + bank * 256;
      if (tall) code |= 1;
      this.drawObject(mo, sp, code, fx, fy, x, y);
      if (tall) this.drawObject(mo, sp, code - 1, fx, fy, x, y - 16);
    }
    // Mix: smoothed background pen | object pen << 4 | text pen << 8, through the palette.
    const prom = this.roms.smooth, p0 = this.smooth * 0x100, p1 = 0x400 + this.smooth * 0x100;
    const chars = this.charPix, vram = this.vram;
    for (let sy = 0; sy < H; sy++) {
      const by = (sy + this.vscroll) & 511, cur = (by >> 1) * 256, last = (((by - 1) & 511) >> 1) * 256;
      const trow = (sy >> 3) * 64, ty = (sy & 7) * 8;
      for (let sx = 0; sx < W; sx++) {
        const bx = (sx + this.hscroll) & 511, nx = ((bx + 1) & 511) >> 1;
        const tr = raw[last + nx], br = raw[cur + nx];
        let pen;
        if (bx & 1) {
          const cx = bx >> 1, mixt = prom[p0 + 16 * raw[last + cx] + tr], mixb = prom[p0 + 16 * raw[cur + cx] + br];
          pen = prom[p1 + 16 * mixt + mixb];
        } else pen = prom[p1 + 16 * tr + br];
        const t = vram[trow + (sx >> 3)], fg = chars[(t + this.alphaBank) * 64 + ty + (sx & 7)];
        out[sy * W + sx] = pal[(pen & 15) | (mo[sy * W + sx] << 4) | (fg << 8)];
      }
    }
  }

  drawObject(mo, pix, code, fx, fy, x, y) {
    const src = (code % (pix.length / 128)) * 128;
    for (let r = 0; r < 16; r++) {
      const py = y + r;
      if (py < 0 || py >= H) continue;
      const row = src + (fy ? 15 - r : r) * 8;
      for (let c = 0; c < 8; c++) {
        const px = x + c;
        if (px < 0 || px >= W) continue;
        const pen = pix[row + (fx ? 7 - c : c)];
        if (pen) mo[py * W + px] = pen;
      }
    }
  }
}

ReturnOfTheJedi.id = 'jedi';
ReturnOfTheJedi.title = 'Return of the Jedi';
ReturnOfTheJedi.switches = [];
