// Data East BurgerTime (1982): a 6502 at 1.5 MHz draws a 32x32 map of 8x8
// three-bit characters (stored a column at a time; a second window into the
// same RAM has rows and columns swapped), eight 16x16 sprites kept in the
// first column of that RAM, and an optional background of 16x16 tiles from a
// ROM map. 16 colors live in RAM, written inverted.
//
// The program is encrypted in an odd way: an opcode whose address matches
// xxxx xxx1 xxxx x1xx has its bits rotated, but only when the instruction
// before it wrote to memory. So every write marks the next instruction's
// address (the jump target after a JSR) for decoding.
//
// No vblank interrupt: a coin raises the IRQ. A second 6502 at 500 kHz plays
// two AY-3-8910s, woken by an IRQ per command and 16 NMIs a frame.
// 256x240 on a vertical monitor at 57 Hz.

import { CPU6502 } from './m6502.js';
import { AY8910 } from './ay8910.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, rotate270, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 240, TOP = 8, LINES = 272, VBLANK_LINES = 48, REFRESH = 57;
const CPU_CLOCK = 1500000, SOUND_CLOCK = 500000;
const STATE = ['mem', 'ops', 'soundRam', 'latch', 'soundNmiOn', 'scroll1', 'coinHeld', 'vblank', 'in0', 'in2',
  'cycleCarry', 'soundCarry', 'sampleCarry', 'cpu', 'snd', 'ay'];

// 76543210 -> 65342710.
const rotate = (v) => (((v >> 6) & 1) << 7) | (((v >> 5) & 1) << 6) | (((v >> 3) & 1) << 5) | (((v >> 4) & 1) << 4)
  | (((v >> 2) & 1) << 3) | (((v >> 7) & 1) << 2) | (v & 3);

export class BurgerTime {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 16; i++) this.setColor(i); }

  // roms: { main (C000-FFFF), sound (F000-FFFF), chars (three 8K planes, also the sprites), tiles, tileMap }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = REFRESH;
    this.controls = 'four-way';
    this.buttons = 1;
    this.roms = roms;
    this.mem = new Uint8Array(0x10000);          // the main CPU's space as the board sees it: RAM, video RAM, ROM
    this.ops = new Uint8Array(0x10000);          // what the CPU fetches as opcodes (decoded in place as marked)
    this.soundRam = new Uint8Array(0x400);
    this.palette = new Uint32Array(16).fill(0xFF000000);

    this.cpu = new CPU6502({ read: (a) => this.read(a), write: (a, v) => this.write(a, v), fetch: (a) => this.ops[a] });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.snd = new CPU6502({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.ay = [new AY8910(1500000, () => 0xFF, 1), new AY8910(1500000, () => 0xFF, 1)];
    this.sound = new SoundMix(this.ay, 1);

    const third = roms.chars.length / 3 * 8;
    this.charPix = decodeTiles(roms.chars, { count: 1024, width: 8, height: 8, planes: [2 * third, third, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    const sx = [...run(128, 8), ...run(0, 8)], sy = run(0, 16, 8);
    this.spritePix = decodeTiles(roms.chars, { count: 256, width: 16, height: 16, planes: [2 * third, third, 0], xs: sx, ys: sy, size: 256 });
    const tthird = roms.tiles.length / 3 * 8;
    this.tilePix = decodeTiles(roms.tiles, { count: 64, width: 16, height: 16, planes: [2 * tthird, tthird, 0], xs: sx, ys: sy, size: 256 });
    this.frame = new Uint32Array(W * H);
    this.native = new Uint32Array(W * H);
    this.in0 = 0xFF; this.in2 = 0x3F;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.mem.fill(0); this.mem.set(this.roms.main, 0xC000); this.ops.set(this.mem);
    this.soundRam.fill(0); this.palette.fill(0xFF000000);
    this.latch = 0; this.soundNmiOn = 0; this.scroll1 = 0; this.coinHeld = 0; this.vblank = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
  }

  // Inverted BBGGGRRR.
  setColor(i) {
    const d = ~this.mem[0x0C00 + i] & 0xFF, w = (b0, b1, b2) => 0x21 * b0 + 0x47 * b1 + 0x97 * b2;
    this.palette[i] = rgba(w(d & 1, (d >> 1) & 1, (d >> 2) & 1), w((d >> 3) & 1, (d >> 4) & 1, (d >> 5) & 1), w(0, (d >> 6) & 1, (d >> 7) & 1));
  }

  read(a) {
    if (a >= 0x1800 && a < 0x2000) return this.mem[0x1000 + (a & 0x400) + swap(a & 0x3FF)];
    switch (a) {
      case 0x4000: return this.in0;
      case 0x4001: return 0xFF;
      case 0x4002: return this.in2;
      case 0x4003: return this.dsw1 | (this.vblank ? 0x80 : 0);
      case 0x4004: return this.dsw2;
    }
    return this.mem[a];
  }
  write(a, v) {
    if (a >= 0x0C00 && a < 0x0C10) { this.mem[a] = v; this.setColor(a - 0x0C00); }
    else if (a >= 0x1800 && a < 0x2000) this.mem[0x1000 + (a & 0x400) + swap(a & 0x3FF)] = v;
    else if (a === 0x4003) { this.latch = v; this.snd.irq = true; }
    else if (a === 0x4004) this.scroll1 = v;
    this.mem[a] = v;
    this.markNext();
  }
  // The instruction after this write gets decoded if its address matches the pattern.
  markNext() {
    const prev = this.cpu.opPc;
    let next = this.cpu.pc;
    if (this.ops[prev] === 0x20) next = this.mem[(prev + 1) & 0xFFFF] | (this.mem[(prev + 2) & 0xFFFF] << 8);   // JSR: its target
    if ((next & 0x0104) === 0x0104) this.ops[next] = rotate(this.mem[next]);
  }

  soundRead(a) {
    if (a < 0x0400) return this.soundRam[a];
    if (a < 0x1000) return this.roms.sound[a];                    // the ROM's 400-FFF shows here too
    if (a >= 0xA000 && a < 0xB000) return this.latch;
    if (a >= 0xF000) return this.roms.sound[a - 0xF000];
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a < 0x0400) this.soundRam[a] = v;
    else if (a >= 0x2000 && a < 0x3000) this.ay[0].write(v);
    else if (a >= 0x4000 && a < 0x5000) this.ay[0].select(v);
    else if (a >= 0x6000 && a < 0x7000) this.ay[1].write(v);
    else if (a >= 0x8000 && a < 0x9000) this.ay[1].select(v);
    else if (a >= 0xC000 && a < 0xD000) this.soundNmiOn = v & 1;
  }

  // IN0: right, left, up, down, pepper (active low). IN2: starts (low), coin (high).
  setInputs(s) {
    this.in0 = 0xFF & ~((s.right ? 1 : 0) | (s.left ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0) | (s.fire ? 0x10 : 0));
    this.in2 = (0x3F & ~((s.start1 ? 1 : 0) | (s.start2 ? 2 : 0))) | (s.coin ? 0x40 : 0);
  }
  // DSW1: 1 coin 1 credit, upright. DSW2: lives, bonus, enemies, end-of-level pepper.
  applySwitches(v) { this.dsw1 = 0x3F; this.dsw2 = v.lives | v.bonus | v.enemies | 0x10; }

  runFrame() {
    const main = CPU_CLOCK / REFRESH / LINES, snd = SOUND_CLOCK / REFRESH / LINES, samples = RATE / REFRESH / LINES;
    // A coin raises the IRQ once as it goes in.
    const coin = this.in2 & 0x40;
    if (coin && !this.coinHeld) this.cpu.irq = true;
    this.coinHeld = coin ? 1 : 0;
    for (let line = 0; line < LINES; line++) {
      this.vblank = line >= LINES - VBLANK_LINES ? 1 : 0;
      if (line % 17 === 0 && this.soundNmiOn) this.snd.nmi();      // 16 a frame
      this.cycleCarry += main;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.soundCarry += snd;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
      if (line === H + TOP) this.render();
    }
  }

  // The background picture (16x16 tiles from the ROM maps): it only changes with the scroll register,
  // so it's built once per setting and copied each frame.
  background() {
    const key = this.scroll1 & 0x07;
    if (this.bgKey === key) return this.bgCache;
    const bgBuf = this.bgCache || (this.bgCache = new Uint8Array(W * 256));
    bgBuf.fill(0);
    let scroll = -((this.scroll1 & 3) << 8);
    for (let i = 0; i < 5; i++, scroll += 256) {
      if (scroll > 256) break;
      if (scroll < -256) continue;
      const map = (((1 + i) & 3) | (this.scroll1 & 4)) * 0x100;
      for (let offs = 0; offs < 0x100; offs++) {
        const x0 = 240 - (16 * (offs >> 4) + scroll), y0 = 16 * (offs & 15), code = this.roms.tileMap[map + offs] & 63;
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
          const px = x0 + x;
          if (px >= 0 && px < W) bgBuf[(y0 + y) * W + px] = 8 + this.tilePix[code * 256 + y * 16 + x];
        }
      }
    }
    this.bgKey = key;
    return bgBuf;
  }

  render() {
    const out = this.native, m = this.mem, pal = this.palette;
    const full = this.full || (this.full = new Uint8Array(W * 256));
    // Background, when bit 4 of the scroll register is set.
    const bg = this.scroll1 & 0x10;
    if (bg) full.set(this.background()); else full.fill(0);
    // Characters: video RAM is stored a column at a time, right to left.
    for (let offs = 0; offs < 0x400; offs++) {
      const x0 = 8 * (31 - (offs >> 5)), y0 = 8 * (offs & 31), code = (m[0x1000 + offs] + 256 * (m[0x1400 + offs] & 3)) & 1023;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const pen = this.charPix[code * 64 + y * 8 + x];
        if (pen || !bg) full[(y0 + y) * W + x0 + x] = pen;
      }
    }
    // Sprites: eight, their bytes 32 apart in the first column of video RAM.
    for (let i = 0, offs = 0; i < 8; i++, offs += 0x80) {
      const attr = m[0x1000 + offs];
      if (!(attr & 1)) continue;
      const code = m[0x1020 + offs], fx = attr & 4, fy = attr & 2;
      const x0 = 240 - m[0x1060 + offs], y0 = 240 - m[0x1040 + offs] - 1;
      for (const yy of [y0, y0 + 256]) {
        for (let y = 0; y < 16; y++) {
          const py = yy + y;
          if (py < 0 || py >= 256) continue;
          for (let x = 0; x < 16; x++) {
            const px = x0 + x;
            if (px < 0 || px >= W) continue;
            const pen = this.spritePix[code * 256 + (fy ? 15 - y : y) * 16 + (fx ? 15 - x : x)];
            if (pen) full[py * W + px] = pen;
          }
        }
      }
    }
    for (let i = 0; i < W * H; i++) out[i] = pal[full[i + TOP * W]];
    rotate270(out, W, H, this.frame);
  }
}
// The swapped window: row and column exchanged.
function swap(o) { return ((o & 31) << 5) | (o >> 5); }

BurgerTime.id = 'btime';
BurgerTime.title = 'BurgerTime';
BurgerTime.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x01], ['5', 0x00]], default: 0x01 },
  { id: 'bonus', label: 'Bonus life', options: [['10000', 0x06], ['15000', 0x04], ['20000', 0x02], ['30000', 0x00]], default: 0x06 },
  { id: 'enemies', label: 'Enemies', options: [['4', 0x08], ['6', 0x00]], default: 0x08 },
];
