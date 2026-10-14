// Konami's bitmap games (1982-83): Tutankham and Juno First. A 6809 at
// 1.5 MHz draws straight into a 256x256 bitmap of 4-bit pixels (32K of RAM,
// two pixels a byte, stored sideways for the vertical monitor) through a
// 16-color palette of 3-3-2 bits. Code and graphics ROMs page in at 9000.
//
// Tutankham: the left 192 columns of the bitmap scroll vertically (the maze
// moving sideways on the turned monitor); sound is Konami's Time Pilot board,
// a Z80 with two AY-3-8910s and switchable low-pass filters.
//
// Juno First: the 6809 is Konami's encrypted one, a blitter copies or erases
// 16x16 nibble images from its own ROMs, and the sound board has one AY plus
// an 8039 microcontroller playing samples through a DAC.
//
// The 6809 takes an IRQ every other 60 Hz frame (the games run at 30).

import { M6809, Konami1 } from './m6809.js';
import { Z80 } from './z80.js';
import { AY8910 } from './ay8910.js';
import { I8035 } from './i8035.js';
import { TimePilotSound } from './tpsound.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba, rotate270 } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const SIZE = 256, TOP = 16, H = 224, LINES = 256, REFRESH = 60;
const CPU_CLOCK = 1500000, SOUND_CLOCK = 14318180 / 8, MCU_CLOCK = 8000000 / 15;
const SAMPLES_PER_LINE = RATE / (REFRESH * LINES);
const STATE = ['vram', 'ram', 'pal', 'scroll', 'bank', 'irqEnable', 'irqToggle', 'latch', 'latch2', 'lastTrigger', 'blit',
  'mcuStatus', 'soundRam', 'in0', 'in1', 'cycleCarry', 'soundCarry', 'mcuCarry', 'sampleCarry', 'cpu', 'snd', 'mcu', 'sound', 'tp'];


// The 8039's DAC.
class DAC {
  constructor(gain) { this.gain = gain; this.reset(); }
  reset() { this.value = 0x80; this.out = 0; }
  saveState() { return { value: this.value }; }
  loadState(s) { this.value = s.value; }
  sample() { this.out = (this.value - 0x80) / 128 * this.gain; }
}

class KonamiBitmap {
  saveState() { return capture(this, STATE.filter((k) => this[k] !== undefined && this[k] !== null)); }
  loadState(s) { apply(this, STATE.filter((k) => this[k] !== undefined && this[k] !== null), s); }

  // roms: { main (A000-FFFF), banked (4K pages), sound (Z80), mcu (8039) and blitter (Juno First) }
  constructor(roms, encrypted) {
    this.width = H;
    this.height = SIZE;
    this.refresh = REFRESH;
    this.roms = roms;
    this.vram = new Uint8Array(0x8000);
    this.ram = new Uint8Array(0x1000);         // 8000-8FFF (the I/O registers sit inside it)
    this.pal = new Uint8Array(16);
    this.soundRam = new Uint8Array(0x400);
    this.palette = new Uint32Array(16).fill(0xFF000000);
    const bus = { read: (a) => this.read(a), write: (a, v) => this.write(a, v) };
    this.cpu = encrypted ? new Konami1(bus) : new M6809(bus);
    this.cpu.onTaken = (kind) => { if (kind === 'irq') this.cpu.irq = false; };   // the line is held until taken
    this.native = new Uint32Array(SIZE * H);
    this.frame = new Uint32Array(SIZE * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
  }

  reset() {
    for (const a of [this.vram, this.ram, this.pal, this.soundRam]) a.fill(0);
    this.scroll = 0; this.bank = 0; this.irqEnable = 0; this.irqToggle = 0;
    this.latch = 0; this.latch2 = 0; this.lastTrigger = 0; this.mcuStatus = 0;
    this.cycleCarry = this.soundCarry = this.mcuCarry = this.sampleCarry = 0;
    this.cpu.reset();
    if (this.tp) this.tp.reset();
    else { this.snd.reset(); this.mcu.reset(); this.sound.reset(); }
  }

  setColor(i) {
    const d = this.pal[i], b3 = (v) => ((v & 7) * 0x24) | ((v & 7) >> 1), b2 = (v) => (v & 3) * 0x55;
    this.palette[i] = rgba(b3(d), b3(d >> 3), b2(d >> 6));
  }

  bankRead(a) { return this.roms.banked[this.bank * 0x1000 + a - 0x9000] ?? 0; }


  runFrame() {
    const cyc = CPU_CLOCK / REFRESH / LINES, sc = SOUND_CLOCK / REFRESH / LINES, mc = MCU_CLOCK / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === TOP + H) {
        this.irqToggle ^= 1;
        if (this.irqToggle && this.irqEnable) this.cpu.irq = true;
      }
      this.cycleCarry += cyc;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      if (this.tp) { this.tp.run(1 / REFRESH / LINES); continue; }
      this.soundCarry += sc;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      const c0 = this.mcu.cycles;
      this.mcuCarry += mc; this.mcu.run(Math.floor(this.mcuCarry)); this.mcuCarry -= this.mcu.cycles - c0;
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    this.render();
  }

  // Bitmap byte at offs: row offs >> 7, columns (offs << 1) & FF and the one after (low nibble first).
  render() {
    const out = this.native, v = this.vram, pal = this.palette, scroll = this.scroll;
    for (let y = 0; y < H; y++) {
      const row = y + TOP;
      for (let x = 0; x < SIZE; x++) {
        const sy = x < 192 ? (row + scroll) & 0xFF : row;
        const b = v[sy * 128 + (x >> 1)];
        out[y * SIZE + x] = pal[x & 1 ? b >> 4 : b & 15];
      }
    }
    rotate270(out, SIZE, H, this.frame);
  }
}

// ---------------------------------------------------------------- Tutankham

// Tutankham (1982): explore the tomb, shooting left or right; one flash bomb
// a life clears the screen. Fire shoots the way you last moved.
export class Tutankham extends KonamiBitmap {
  constructor(roms) {
    super(roms, false);
    this.controls = 'four-way';
    this.buttons = 2;
    this.button2 = 'Flash';
    this.facing = 1;
    this.tp = new TimePilotSound(roms.sound);
    this.sound = this.tp.sound;
    this.reset();
  }

  read(a) {
    if (a < 0x8000) return this.vram[a];
    if (a >= 0xA000) return this.roms.main[a - 0xA000];
    if (a >= 0x9000) return this.bankRead(a);
    switch (a) {
      case 0x8160: return this.dsw2;
      case 0x8180: return this.in0;
      case 0x81A0: return this.in1;
      case 0x81C0: return 0xFF;
      case 0x81E0: return this.dsw1;
    }
    if (a < 0x8010) return this.pal[a - 0x8000];
    if (a >= 0x8800) return this.ram[a - 0x8000];
    return 0xFF;
  }
  write(a, v) {
    if (a < 0x8000) { this.vram[a] = v; return; }
    if (a < 0x8010) { this.pal[a - 0x8000] = v; this.setColor(a - 0x8000); return; }
    if (a >= 0x8800 && a < 0x9000) { this.ram[a - 0x8000] = v; return; }
    switch (a) {
      case 0x8100: this.scroll = v; return;
      case 0x8200: this.irqEnable = v & 1; if (!this.irqEnable) this.cpu.irq = false; return;
      case 0x8300: this.bank = v & 0x0F; return;
      case 0x8600: this.tp.trigger(v); return;
      case 0x8700: this.tp.command(v); return;
    }
  }

  // IN0: coin, starts. IN1: left, right, up, down, fire left, fire right, flash bomb.
  setInputs(s) {
    if (s.left) this.facing = 0; else if (s.right) this.facing = 1;
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0)
      | (s.fire ? (this.facing ? 0x20 : 0x10) : 0) | (s.fire2 ? 0x40 : 0));
  }
  // DSW2: lives, upright, bonus, difficulty, a flash bomb per life, demo sounds. DSW1: 1 coin 1 credit.
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = v.lives | v.bonus | v.difficulty | 0x40; }
}
Tutankham.id = 'tutankhm';
Tutankham.title = 'Tutankham';
Tutankham.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x03], ['4', 0x01], ['5', 0x02], ['256 (cheat)', 0x00]], default: 0x03 },
  { id: 'bonus', label: 'Bonus life', options: [['30000', 0x08], ['40000', 0x00]], default: 0x08 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x30], ['Normal', 0x10], ['Hard', 0x20], ['Hardest', 0x00]], default: 0x30 },
];

// ---------------------------------------------------------------- Juno First

// Juno First (1983): fly up and down the play field shooting the aliens;
// warp makes you briefly untouchable.
export class JunoFirst extends KonamiBitmap {
  constructor(roms) {
    super(roms, true);
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Warp';
    this.blit = new Uint8Array(4);
    this.ay = new AY8910(SOUND_CLOCK, (port) => (port === 0 ? (((this.snd.cycles >> 9) & 0x0F) << 4) | this.mcuStatus : 0xFF), 1.5);
    // Port B sets each channel's filter: 0.047 and/or 0.22 uF behind 1K || (2.2K + 200).
    this.ay.portOut = (n, v) => {
      if (n !== 1) return;
      const R = 1000 * 2400 / 3400;
      for (let ch = 0; ch < 3; ch++, v >>= 2) this.ay.setFilter(ch, R * ((v & 1 ? 0.047e-6 : 0) + (v & 2 ? 0.22e-6 : 0)));
    };
    this.dac = new DAC(0.5);
    this.mcu = new I8035({
      rom: roms.mcu,
      read: () => this.latch2,
      portOut: (n, v) => {
        if (n === 1) this.dac.value = v;
        else if (n === 2) { if (!(v & 0x80)) this.mcu.int = false; this.mcuStatus = (v & 0x70) >> 4; }
      },
    });
    this.sound = new SoundMix([this.ay, this.dac]);
    this.reset();
  }

  read(a) {
    if (a < 0x8000) return this.vram[a];
    if (a >= 0xA000) return this.roms.main[a - 0xA000];
    if (a >= 0x9000) return this.bankRead(a);
    switch (a) {
      case 0x8010: return this.dsw2;
      case 0x8020: return this.in0;
      case 0x8024: return this.in1;
      case 0x8028: return 0xFF;
      case 0x802C: return this.dsw1;
    }
    if (a < 0x8010) return this.pal[a - 0x8000];
    if (a >= 0x8100) return this.ram[a - 0x8000];
    return 0xFF;
  }
  write(a, v) {
    if (a < 0x8000) { this.vram[a] = v; return; }
    if (a < 0x8010) { this.pal[a - 0x8000] = v; this.setColor(a - 0x8000); return; }
    if (a >= 0x8100 && a < 0x9000) { this.ram[a - 0x8000] = v; return; }
    switch (a) {
      case 0x8030: this.irqEnable = v & 1; if (!this.irqEnable) this.cpu.irq = false; return;
      case 0x8033: this.scroll = v; return;
      case 0x8040: if (v & 1 && !this.lastTrigger) this.snd.irq = true; this.lastTrigger = v & 1; return;   // a rising edge interrupts the sound CPU
      case 0x8050: this.latch = v; return;
      case 0x8060: this.bank = v & 0x0F; return;
      case 0x8070: case 0x8071: case 0x8072: this.blit[a - 0x8070] = v; return;
      case 0x8073: this.blit[3] = v; this.blitter(); return;
    }
  }

  // Copy (source bit 0 set) or erase a 16x16 image from the blitter ROMs, nibble-addressed;
  // only where the source pixel isn't 0.
  blitter() {
    const g = this.roms.blitter, b = this.blit, v = this.vram;
    let src = ((b[2] << 8) | b[3]) & 0xFFFC, dest = (b[0] << 8) | b[1];
    const copy = b[3] & 1;
    for (let i = 0; i < 16; i++, dest += 240) {
      for (let j = 0; j < 16; j++, src++, dest++) {
        const byte = g[(src >> 1) & 0x7FFF] ?? 0, d = src & 1 ? byte & 15 : byte >> 4;
        if (!d) continue;
        const p = copy ? d : 0, o = (dest >> 1) & 0x7FFF;
        v[o] = dest & 1 ? (v[o] & 0x0F) | (p << 4) : (v[o] & 0xF0) | p;
      }
    }
  }

  soundRead(a) {
    if (a < 0x1000) return this.roms.sound[a] ?? 0xFF;
    if (a >= 0x2000 && a < 0x2400) return this.soundRam[a - 0x2000];
    if (a === 0x3000) return this.latch;
    if (a === 0x4001) return this.ay.read();
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0x2000 && a < 0x2400) { this.soundRam[a - 0x2000] = v; return; }
    switch (a) {
      case 0x4000: this.ay.select(v); return;
      case 0x4002: this.ay.write(v); return;
      case 0x5000: this.latch2 = v; return;
      case 0x6000: this.mcu.int = true; return;
    }
  }

  // IN0: coin, starts. IN1: left, right, up, down, warp, fire.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0) | (s.fire2 ? 0x10 : 0) | (s.fire ? 0x20 : 0));
  }
  // DSW2: lives, upright, difficulty, demo sounds. DSW1: 1 coin 1 credit.
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = v.lives | 0x08 | v.difficulty; }
}
JunoFirst.id = 'junofrst';
JunoFirst.title = 'Juno First';
JunoFirst.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x03], ['4', 0x02], ['5', 0x01], ['256 (cheat)', 0x00]], default: 0x03 },
  { id: 'difficulty', label: 'Difficulty', options: [['1 (easiest)', 0x70], ['2', 0x60], ['3', 0x50], ['4', 0x40], ['5', 0x30], ['6', 0x20], ['7', 0x10], ['8 (hardest)', 0x00]], default: 0x70 },
];
