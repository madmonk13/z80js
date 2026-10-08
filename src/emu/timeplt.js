// Konami Time Pilot (1982): one Z80 at 3.072 MHz, a 32x32 tile layer (some
// tiles marked to sit in front of the sprites), 24 16x16 sprites, and
// Konami's sound board: a second Z80 at 1.79 MHz with two AY-3-8910s, each
// channel through a switchable RC low-pass filter.
//
// The game reads the beam's current line and rewrites the sprite registers
// partway down the screen to show more sprites than the hardware has (the
// clouds), so the sprite registers are latched line by line as the frame runs
// and each line is drawn from its own copy.
//
// 256 lines of 200 cycles, 60 Hz; the picture is 256x224 on a vertical
// monitor.

import { Z80 } from './z80.js';
import { AY8910 } from './ay8910.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const NATIVE_W = 256, NATIVE_H = 224, TOP = 16;
const LINES = 256, LINE_CYCLES = 200;
const SOUND_CLOCK = 14318180 / 8;                       // 1.79 MHz
const SOUND_PER_LINE = SOUND_CLOCK / (60 * LINES);      // about 116.5 cycles
const SAMPLES_PER_LINE = 48000 / (60 * LINES);          // 3.125
const SPRITES = 0x30;                                   // 24 sprites x 2 bytes, in each of two banks

// The AY's port B reads a timer divided down from the sound CPU's clock
// (divide by 512, then a bi-quinary divide by 10).
const TIMER = [0x00, 0x10, 0x20, 0x30, 0x40, 0x90, 0xA0, 0xB0, 0xA0, 0xD0];

// Each channel's filter: 1K in parallel with 5.1K into 0.22 uF and/or
// 0.047 uF, picked by two address lines per channel.
const R_FILTER = (1000 * 5100) / (1000 + 5100);
const filterTau = (bits) => R_FILTER * ((bits & 1 ? 0.22e-6 : 0) + (bits & 2 ? 0.047e-6 : 0));

const STATE = ['ram', 'soundRam', 'nmiEnable', 'latch', 'lastTrigger', 'soundCarry', 'sampleCarry', 'in0', 'in1', 'cpu', 'sndCpu', 'sound'];

// The palette: two PROMs give each of 32 colors 5 bits of red, green and blue
// through 1.2K/820/560/470/390 ohm resistors.
function palette(lo, hi) {
  const W = [0x19, 0x24, 0x35, 0x40, 0x4D];
  const level = (v) => W.reduce((sum, w, i) => sum + ((v >> i) & 1) * w, 0);
  return Uint32Array.from({ length: 32 }, (_, i) => {
    // Red: b5 bits 1-5. Green: b5 bits 6-7, then b4 bits 0-2. Blue: b4 bits 3-7.
    return rgba(level(hi[i] >> 1), level(((hi[i] >> 6) & 3) | ((lo[i] & 7) << 2)), level(lo[i] >> 3));
  });
}

export class TimePilot {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 24K, sound 4K, chars 8K, sprites 16K, palLo 32, palHi 32, spriteLut 256, charLut 256 }
  constructor(roms) {
    this.width = NATIVE_H;
    this.height = NATIVE_W;
    this.refresh = 60;
    this.controls = 'eight-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x2000);         // A000-BFFF: colors, tiles, work RAM, sprites
    this.soundRam = new Uint8Array(0x400);
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sndCpu = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    // The sound CPU's interrupt is held until it's taken.
    this.sndCpu.onIrqAck = () => { this.sndCpu.irq = false; };
    this.ay = [
      new AY8910(SOUND_CLOCK, (port) => (port === 0 ? this.latch : TIMER[Math.floor((this.sndCpu.cycles % 5120) / 512)]), 3),
      new AY8910(SOUND_CLOCK, () => 0xFF, 3),
    ];
    this.sound = new SoundMix(this.ay);
    // Sprite registers as latched on each line.
    this.mux = new Uint8Array(LINES * SPRITES * 2);
    this.frame = new Uint32Array(this.width * this.height);
    this.native = new Uint32Array(NATIVE_W * NATIVE_H);
    this.front = new Uint8Array(NATIVE_W * NATIVE_H);   // tile pixels drawn over the sprites

    this.charPix = decodeTiles(roms.chars, {
      count: roms.chars.length / 16, width: 8, height: 8, planes: [4, 0], xs: [...run(0, 4), ...run(64, 4)], ys: run(0, 8, 8), size: 128,
    });
    this.spritePix = decodeTiles(roms.sprites, {
      count: roms.sprites.length / 64, width: 16, height: 16, planes: [4, 0],
      xs: [...run(0, 4), ...run(64, 4), ...run(128, 4), ...run(192, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    this.palette = palette(roms.palLo, roms.palHi);
    this.spriteLut = Uint8Array.from(roms.spriteLut, (v) => v & 0x0F);
    this.charLut = Uint8Array.from(roms.charLut, (v) => (v & 0x0F) + 0x10);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.soundRam.fill(0);
    this.cpu.reset(); this.sndCpu.reset();
    this.sound.reset();
    this.nmiEnable = false;
    this.latch = 0;
    this.lastTrigger = 0;
    this.scanline = 0;
    this.soundCarry = 0;
    this.sampleCarry = 0;
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x6000) return this.roms.main[a] ?? 0xFF;
    if (a >= 0xA000 && a < 0xC000) return this.ram[a - 0xA000];
    switch (a) {
      case 0xC000: return this.scanline;
      case 0xC200: return this.dsw1;
      case 0xC300: return this.in0;
      case 0xC320: return this.in1;
      case 0xC340: return 0xFF;                 // player 2 (cocktail)
      case 0xC360: return this.dsw0;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0xA000 && a < 0xC000) { this.ram[a - 0xA000] = v; return; }
    switch (a) {
      case 0xC000: this.latch = v; return;
      case 0xC300: this.nmiEnable = !!(v & 1); return;
      case 0xC304:                               // low then high interrupts the sound CPU
        if (v && !this.lastTrigger) this.sndCpu.irq = true;
        this.lastTrigger = v;
        return;
      // C200 watchdog, C302 flip screen, C30A/C30C coin counters: not needed.
    }
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x2000) return this.roms.sound[a] ?? 0xFF;
    if (a >= 0x3000 && a < 0x3400) return this.soundRam[a - 0x3000];
    if (a === 0x4000) return this.ay[0].read();
    if (a === 0x6000) return this.ay[1].read();
    return 0xFF;
  }

  soundWrite(a, v) {
    if (a >= 0x3000 && a < 0x3400) { this.soundRam[a - 0x3000] = v; return; }
    switch (a & 0xF000) {
      case 0x4000: this.ay[0].write(v); return;
      case 0x5000: this.ay[0].select(v); return;
      case 0x6000: this.ay[1].write(v); return;
      case 0x7000: this.ay[1].select(v); return;
      case 0x8000:                               // the address lines set the six filters
        for (let ch = 0; ch < 3; ch++) {
          this.ay[0].setFilter(ch, filterTau((a >> (6 + 2 * ch)) & 3));
          this.ay[1].setFilter(ch, filterTau((a >> (2 * ch)) & 3));
        }
    }
  }

  // ---------------------------------------------------------------- inputs

  // Active low. IN0: coin, starts. IN1: left, right, up, down, fire.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.left ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.up ? 0x04 : 0) | (s.down ? 0x08 : 0) | (s.fire ? 0x10 : 0));
  }

  // DSW0: 1 coin 1 credit for both slots. DSW1: lives, upright, bonus,
  // difficulty, demo sounds.
  applySwitches(v) {
    this.dsw0 = 0xFF;
    this.dsw1 = v.lives | v.bonus | v.difficulty | v.demoSounds;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const ram = this.ram;
    for (let line = 0; line < LINES; line++) {
      this.scanline = line;
      this.cpu.run(LINE_CYCLES);
      // Latch this line's sprite registers (B010-B03F and B410-B43F).
      const m = line * SPRITES * 2;
      this.mux.set(ram.subarray(0x1010, 0x1010 + SPRITES), m);
      this.mux.set(ram.subarray(0x1410, 0x1410 + SPRITES), m + SPRITES);
      if (line === LINES - 1 && this.nmiEnable) this.cpu.nmi();

      this.soundCarry += SOUND_PER_LINE;
      this.sampleCarry += SAMPLES_PER_LINE;
      const cycles = Math.floor(this.soundCarry), samples = Math.floor(this.sampleCarry);
      this.soundCarry -= cycles; this.sampleCarry -= samples;
      for (let k = 0; k < samples; k++) {
        this.sndCpu.run(Math.floor(cycles / samples) + (k < cycles % samples ? 1 : 0));
        this.sound.sample();
      }
    }
    this.render();
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, front = this.front, ram = this.ram, pal = this.palette;

    // Tiles: A400 codes, A000 attributes (color, bank, flips, priority).
    for (let row = 2; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const i = row * 32 + col, attr = ram[i];
        const code = ram[0x400 + i] | ((attr & 0x20) << 3), color = (attr & 0x1F) * 4;
        const flipX = attr & 0x40, flipY = attr & 0x80, pri = (attr >> 4) & 1;
        for (let y = 0; y < 8; y++) {
          const src = code * 64 + (flipY ? 7 - y : y) * 8;
          let o = ((row - 2) * 8 + y) * NATIVE_W + col * 8;
          for (let x = 0; x < 8; x++, o++) {
            out[o] = pal[this.charLut[color + this.charPix[src + (flipX ? 7 - x : x)]]];
            front[o] = pri;
          }
        }
      }
    }

    // Sprites, line by line from each line's latched registers; the first
    // register pair is on top.
    const mux = this.mux, sprites = this.spritePix;
    for (let line = TOP; line < TOP + NATIVE_H; line++) {
      const r1 = line * SPRITES * 2, r2 = r1 + SPRITES;
      const row = (line - TOP) * NATIVE_W;
      for (let offs = SPRITES - 2; offs >= 0; offs -= 2) {
        const sy = 241 - mux[r2 + offs + 1];
        if (sy <= line - 16 || sy > line) continue;
        const attr = mux[r2 + offs], sx = mux[r1 + offs];
        const color = (attr & 0x3F) * 4, flipX = !(attr & 0x40), flipY = attr & 0x80;
        const y = line - sy, src = mux[r1 + offs + 1] * 256 + (flipY ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px >= NATIVE_W) break;
          const pen = sprites[src + (flipX ? 15 - x : x)];
          if (pen && !front[row + px]) out[row + px] = pal[this.spriteLut[color + pen]];
        }
      }
    }

    rotate90(out, NATIVE_W, NATIVE_H, this.frame);
  }
}

TimePilot.id = 'timeplt';
TimePilot.title = 'Time Pilot';
TimePilot.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x03], ['4', 0x02], ['5', 0x01]], default: 0x03 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easiest', 0x70], ['Easy', 0x50], ['Normal', 0x30], ['Hard', 0x10], ['Hardest', 0x00]], default: 0x70 },
  { id: 'bonus', label: 'Bonus', options: [['10K/50K', 0x08], ['20K/60K', 0x00]], default: 0x08 },
  { id: 'demoSounds', label: 'Demo sounds', options: [['On', 0x00], ['Off', 0x80]], default: 0x00 },
];
