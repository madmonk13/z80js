// Konami Scramble (1981) and Amidar (1981): Galaxian-style video with
// Konami's sound board as on Frogger, but with two AY-3-8910s (the second
// one reads the command latch and the timer on its ports). Built on the
// Frogger class for the sound CPU's timing and the 8255 PPI interface.
//
//   Scramble: single-pixel bullets, static stars, a switchable blue
//             background, and a protection device on the second PPI's port C.
//   Amidar:   a different memory map, no stars or bullets, and a background
//             color from three latches.

import { Z80 } from './z80.js';
import { AY8910 } from './ay8910.js';
import { SoundMix } from './mixer.js';
import { Frogger } from './frogger.js';
import { NATIVE_W, NATIVE_H, TOP } from './galaxian.js';
import { rgba } from './video.js';

const SOUND_CLOCK = 14318000 / 8;
const TIMER = [0x00, 0x10, 0x20, 0x30, 0x40, 0x90, 0xA0, 0xB0, 0xA0, 0xD0];
const BULLET = rgba(0xEF, 0xEF, 0x00), BLUE = rgba(0, 0, 0x56);

// Scramble's protection chip: the answers the program expects at each of its
// checks, keyed by where the check is made.
const PROTECTION = { 0x00A8: 0xF0, 0x00BE: 0xB0, 0x0C1D: 0xF0, 0x0C6A: 0xB0, 0x0CEB: 0x40, 0x0D37: 0x60, 0x1CA2: 0x00, 0x1D7E: 0xB0 };

export class Scramble extends Frogger {
  constructor(roms) {
    super(roms);
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Bomb';
    this.bullets = true;
    this.ay = [
      new AY8910(SOUND_CLOCK, () => 0xFF, 3),
      new AY8910(SOUND_CLOCK, (port) => (port === 0 ? this.latch : TIMER[Math.floor((this.sndCpu.cycles % 5120) / 512)]), 3),
    ];
    this.sound = new SoundMix(this.ay);
    this.sndCpu = new Z80({
      read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v),
      input: (p) => this.soundIn(p & 0xFF), output: (p, v) => this.soundOut(p & 0xFF, v),
    });
    this.sndCpu.onIrqAck = () => { this.sndCpu.irq = false; };
    this.bgOn = 0;
    this.reset();
  }

  saveState() { return { ...super.saveState(), bgOn: this.bgOn }; }
  loadState(s) { super.loadState(s); this.bgOn = s.bgOn ?? 0; }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x4000) return this.roms.main[a] ?? 0xFF;
    if (a < 0x4800) return this.ram[a - 0x4000];
    if (a < 0x5000) return this.vram[a & 0x3FF];
    if (a < 0x5100) return this.obj[a & 0xFF];
    if ((a & 0xFF00) === 0x8100) return [this.in0, this.in1, this.in2, 0xFF][a & 3];
    if (a >= 0x8200 && a < 0x8204) return (a & 3) === 2 ? this.protection() : 0xFF;
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x4000 && a < 0x4800) { this.ram[a - 0x4000] = v; return; }
    if (a >= 0x4800 && a < 0x5000) { this.vram[a & 0x3FF] = v; return; }
    if (a >= 0x5000 && a < 0x5100) { this.obj[a & 0xFF] = v; return; }
    switch (a) {
      case 0x6801: this.nmiEnable = !!(v & 1); return;
      case 0x6803: this.bgOn = v & 1; return;
      case 0x6804: this.starsOn = !!(v & 1); return;
    }
    if (a >= 0x8200 && a < 0x8204) this.soundPort(a & 3, v);
  }

  protection() { return PROTECTION[this.cpu.pc] ?? 0; }   // the address just past the read

  // The second PPI: port A is the sound command; port B's bit 3 falling
  // interrupts the sound CPU and bit 4 mutes the board.
  soundPort(port, v) {
    if (port === 0) this.latch = v;
    else if (port === 1) {
      const clk = ~v & 0x08;
      if (clk && !this.lastClk) this.sndCpu.irq = true;
      this.lastClk = clk;
      for (const ay of this.ay) ay.enabled = !(v & 0x10);
    }
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x3000) return this.roms.sound[a] ?? 0xFF;
    if (a >= 0x8000 && a < 0x9000) return this.soundRam[a & 0x3FF];
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0x8000 && a < 0x9000) this.soundRam[a & 0x3FF] = v;
    // 9000-9FFF set the output filters: not modeled.
  }
  soundIn(p) {
    if (p & 0x20) return this.ay[0].read();
    if (p & 0x80) return this.ay[1].read();
    return 0xFF;
  }
  soundOut(p, v) {
    if (p & 0x10) this.ay[0].select(v);
    if (p & 0x20) this.ay[0].write(v);
    if (p & 0x40) this.ay[1].select(v);
    if (p & 0x80) this.ay[1].write(v);
  }

  // ---------------------------------------------------------------- inputs

  // All active low. IN0: bomb, fire, right, left, coin. IN1: lives, starts.
  // IN2: coinage and cabinet (1 coin 1 credit, upright), up, down.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.fire2 ? 0x02 : 0) | (s.fire ? 0x08 : 0) | (s.right ? 0x10 : 0) | (s.left ? 0x20 : 0) | (s.coin ? 0x80 : 0));
    this.in1 = ((0xFC | this.lives) & ~((s.start2 ? 0x40 : 0) | (s.start1 ? 0x80 : 0))) & 0xFF;
    this.in2 = 0xF1 & ~((s.up ? 0x10 : 0) | (s.down ? 0x40 : 0));
  }
  applySwitches(v) { this.lives = v.lives; this.setInputs({}); }

  // ---------------------------------------------------------------- video

  background(out) { out.fill(this.bgOn ? BLUE : 0xFF000000); }
  mapColor(c) { return c; }
  mapY(v) { return v; }

  // One yellow pixel per shot.
  drawBullets(out) {
    const obj = this.obj;
    for (let b = 0; b < 8; b++) {
      const y = 255 - obj[0x61 + b * 4], x = 255 - obj[0x63 + b * 4] - 6;
      if (y >= TOP && y < TOP + NATIVE_H && x >= 0 && x < NATIVE_W) out[y * NATIVE_W + x] = BULLET;
    }
  }
}
Scramble.id = 'scramble';
Scramble.title = 'Scramble';
Scramble.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x00], ['4', 0x01], ['5', 0x02]], default: 0x00 },
];

export class Amidar extends Scramble {
  constructor(roms) {
    super(roms);
    this.controls = 'four-way';
    this.buttons = 1;                          // the jump
    this.bullets = false;
    this.bg = [0, 0, 0];
  }

  saveState() { return { ...super.saveState(), bg: this.bg }; }
  loadState(s) { super.loadState(s); this.bg = s.bg ?? [0, 0, 0]; }

  read(a) {
    if (a < 0x8000) return this.roms.main[a] ?? 0xFF;
    if (a < 0x8800) return this.ram[a - 0x8000];
    if (a >= 0x9000 && a < 0x9400) return this.vram[a & 0x3FF];
    if (a >= 0x9800 && a < 0x9900) return this.obj[a & 0xFF];
    if (a >= 0xB000 && a < 0xB040) return [this.in0, this.in1, this.in2, 0xFF][(a >> 4) & 3];
    if (a >= 0xB800 && a < 0xB840) return 0xFF;      // port C: coinage switches, 1 coin 1 credit
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0x8800) { this.ram[a - 0x8000] = v; return; }
    if (a >= 0x9000 && a < 0x9400) { this.vram[a & 0x3FF] = v; return; }
    if (a >= 0x9800 && a < 0x9900) { this.obj[a & 0xFF] = v; return; }
    switch (a) {
      case 0xA000: this.bg[0] = v & 1; return;
      case 0xA008: this.nmiEnable = !!(v & 1); return;
      case 0xA020: this.bg[1] = v & 1; return;
      case 0xA028: this.bg[2] = v & 1; return;
    }
    if (a >= 0xB800 && a < 0xB840) this.soundPort((a >> 4) & 3, v);
  }

  // IN0: jump, right, left, coin. IN1: lives, starts. IN2: switches (demo
  // sounds, bonus, upright), up, down.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.fire ? 0x08 : 0) | (s.right ? 0x10 : 0) | (s.left ? 0x20 : 0) | (s.coin ? 0x80 : 0));
    this.in1 = ((0xFC | this.lives) & ~((s.start2 ? 0x40 : 0) | (s.start1 ? 0x80 : 0))) & 0xFF;
    this.in2 = (0x51 | this.dip2) & ~((s.up ? 0x10 : 0) | (s.down ? 0x40 : 0));
  }
  applySwitches(v) { this.lives = v.lives; this.dip2 = v.bonus | v.demoSounds; this.setInputs({}); }

  // The background color: one bit each of red, green and blue.
  background(out) {
    const [r, g, b] = this.bg;
    out.fill(rgba(r * 0x55, g * 0x47, b * 0x55));
  }
}
Amidar.id = 'amidar';
Amidar.title = 'Amidar';
Amidar.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x03], ['4', 0x02], ['5', 0x01]], default: 0x03 },
  { id: 'bonus', label: 'Bonus', options: [['30K/50K', 0x00], ['50K/50K', 0x04]], default: 0x00 },
  { id: 'demoSounds', label: 'Demo sounds', options: [['On', 0x00], ['Off', 0x02]], default: 0x00 },
];

// Konami Super Cobra (1981): the Scramble board with its memory map moved
// (RAM 8000, tiles 8800, objects 9000, PPIs 9800/A000) and no protection.
export class SuperCobra extends Scramble {
  read(a) {
    if (a < 0x8000) return this.roms.main[a] ?? 0xFF;
    if (a < 0x8800) return this.ram[a - 0x8000];
    if (a < 0x9000) return this.vram[a & 0x3FF];
    if (a < 0x9100) return this.obj[a & 0xFF];
    if (a >= 0x9800 && a < 0x9804) return [this.in0, this.in1, this.in2, 0xFF][a & 3];
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0x8800) { this.ram[a - 0x8000] = v; return; }
    if (a >= 0x8800 && a < 0x9000) { this.vram[a & 0x3FF] = v; return; }
    if (a >= 0x9000 && a < 0x9100) { this.obj[a & 0xFF] = v; return; }
    if (a >= 0xA000 && a < 0xA004) { this.soundPort(a & 3, v); return; }
    switch (a) {
      case 0xA801: this.nmiEnable = !!(v & 1); return;
      case 0xA803: this.bgOn = v & 1; return;
      case 0xA804: this.starsOn = !!(v & 1); return;
    }
  }

  // As Scramble, with the coinage switch at 1 coin 1 credit.
  setInputs(s) {
    super.setInputs(s);
    this.in2 |= 0x02;
  }
}
SuperCobra.id = 'scobra';
SuperCobra.title = 'Super Cobra';
SuperCobra.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x00], ['4', 0x02]], default: 0x00 },
];
