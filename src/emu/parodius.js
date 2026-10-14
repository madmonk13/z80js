// Konami's 1990-91 boards with the 053xxx chips: Parodius Da! — the Konami
// CPU (053248) at 3 MHz, K052109 tilemaps, K053245 sprites, the K053251
// priority mixer, and a Z80 driving a YM2151 and a K053260 PCM chip.
//
// The main CPU's 0000-07FF is work RAM or (by a bank bit) either half of
// the 2048-color palette; 2000-27FF the tilemap chip or the sprite RAM;
// the bank lines page 16K of ROM in at 6000. The visible picture is the same
// 288x224 window as the other Konami boards.

import { KonamiCPU } from './konami.js';
import { Z80 } from './z80.js';
import { YM2151 } from './ym2151.js';
import { K053260 } from './k053260.js';
import { K052109, K053245, K053251, deinterleave2 } from './konamiic.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const WIN = { x: 112, y: 16, w: 288, h: 224 };
const LINES = 256, VBLANK = 240, REFRESH = 60;
const CPU_CLOCK = 3000000, SOUND_CLOCK = 3579545;
const STATE = ['ram', 'palRam', 'soundRam', 'bank', 'videoBank', 'nmiPending', 'in', 'cycleCarry', 'soundCarry', 'sampleCarry',
  'cpu', 'snd', 'tiles', 'sprites', 'mixer', 'ym', 'k053260'];

export class Parodius {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 2048; i++) this.setColor(i); }

  // roms: { main (the 0x48000 region: fixed 8000-FFFF, banks from 10000), sound, tiles, sprites, samples }
  constructor(roms) {
    this.width = WIN.w;
    this.height = WIN.h;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 3;
    this.button2 = 'Missile';
    this.button3 = 'Power-up';
    this.roms = roms;
    this.ram = new Uint8Array(0x2000);
    this.palRam = new Uint8Array(0x1000);
    this.soundRam = new Uint8Array(0x800);
    this.palette = new Uint32Array(2048).fill(0xFF000000);
    this.tiles = new K052109(deinterleave2(roms.tiles), (l, b, c, col) => this.tileCallback(l, b, c, col));
    this.sprites = new K053245(deinterleave2(roms.sprites), (c, col) => this.spriteCallback(c, col));
    this.mixer = new K053251();
    this.cpu = new KonamiCPU({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onTaken = (kind) => { if (kind === 'irq') this.cpu.irq = false; else this.cpu.firq = false; };
    this.cpu.onSetLines = (v) => this.setLines(v);
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.ym = new YM2151(SOUND_CLOCK, 0.6);
    this.k053260 = new K053260(SOUND_CLOCK, roms.samples, 0.7);
    this.sound = new SoundMix([this.ym, this.k053260], 1);
    this.frame = new Uint32Array(WIN.w * WIN.h);
    this.pri = new Uint8Array(WIN.w * WIN.h);
    this.in = new Uint8Array(3).fill(0xFF);
    this.layerPri = [0, 0, 0];
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.palRam.fill(0); this.soundRam.fill(0); this.palette.fill(0xFF000000);
    this.bank = 0x10000; this.videoBank = 0; this.nmiPending = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.tiles.reset(); this.sprites.reset(); this.mixer.reset();
    this.cpu.reset(); this.snd.reset(); this.ym.reset(); this.k053260.reset();
  }

  setColor(i) {
    const c = (this.palRam[i * 2] << 8) | this.palRam[i * 2 + 1], l = (v) => (v << 3) | (v >> 2);
    this.palette[i] = rgba(l(c & 31), l((c >> 5) & 31), l((c >> 10) & 31));
  }
  // The bank lines (inverted) pick a 16K page; the last pages fold back onto the fixed ROM.
  setLines(v) {
    let offs = 0x10000 + (((v & 0x0F) ^ 0x0F) * 0x4000);
    if (offs >= 0x48000) offs -= 0x40000;
    this.bank = offs;
  }

  read(a) {
    if (a < 0x800) {
      if (this.videoBank & 1) return this.palRam[(this.videoBank & 4 ? 0x800 : 0) + a];
      return this.ram[a];
    }
    if (a < 0x2000) return this.ram[a];
    if (a < 0x6000) {
      switch (a) {
        case 0x3F8C: return this.in[0];
        case 0x3F8D: return this.in[1];
        case 0x3F8E: return this.in[2];
        case 0x3F8F: return this.dsw1;
        case 0x3F90: return this.dsw2;
        case 0x3FC0: return 0;                                   // watchdog
        case 0x3FCC: case 0x3FCD: return this.k053260.read(2 + (a & 1));
      }
      if (a >= 0x3FA0 && a < 0x3FB0) return this.sprites.readReg(a - 0x3FA0);
      if (a < 0x2800 && (this.videoBank & 2)) return this.sprites.read(a - 0x2000);
      return this.tiles.read(a - 0x2000);
    }
    if (a < 0xA000) return this.roms.main[this.bank + a - 0x6000] ?? 0xFF;
    return this.roms.main[a];
  }
  write(a, v) {
    if (a < 0x800) {
      if (this.videoBank & 1) { const o = (this.videoBank & 4 ? 0x800 : 0) + a; this.palRam[o] = v; this.setColor(o >> 1); }
      else this.ram[a] = v;
      return;
    }
    if (a < 0x2000) { this.ram[a] = v; return; }
    if (a >= 0x6000) return;
    if (a >= 0x3FA0 && a < 0x3FB0) { this.sprites.writeReg(a - 0x3FA0, v); return; }
    if (a >= 0x3FB0 && a < 0x3FC0) { this.mixer.write(a - 0x3FB0, v); return; }
    switch (a) {
      case 0x3FC0: this.tiles.rmrd = v & 0x08; return;            // coin counters; bit 3 reads the char ROM
      case 0x3FC4: this.videoBank = v; return;
      case 0x3FC8: this.snd.irqVector = 0xFF; this.snd.irq = true; return;
      case 0x3FCC: case 0x3FCD: this.k053260.write(a & 1, v); return;
    }
    if (a < 0x2800 && (this.videoBank & 2)) this.sprites.write(a - 0x2000, v);
    else this.tiles.write(a - 0x2000, v);
  }

  soundRead(a) {
    if (a < 0xF000) return this.roms.sound[a];
    if (a < 0xF800) return this.soundRam[a - 0xF000];
    if (a === 0xF801) return this.ym.read();
    if (a >= 0xFC00 && a < 0xFC30) return this.k053260.read(a - 0xFC00);
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0xF000 && a < 0xF800) this.soundRam[a - 0xF000] = v;
    else if (a === 0xF800) this.ym.select(v);
    else if (a === 0xF801) this.ym.write(v);
    else if (a === 0xFA00) this.nmiPending = 1;                    // an NMI follows shortly (50 us)
    else if (a >= 0xFC00 && a < 0xFC30) this.k053260.write(a - 0xFC00, v);
  }

  tileCallback(layer, bank, code, color) {
    const base = [this.mixer.paletteIndex(2), this.mixer.paletteIndex(4), this.mixer.paletteIndex(3)][layer];
    return { code: code | ((color & 0x03) << 8) | ((color & 0x10) << 6) | ((color & 0x0C) << 9) | (bank << 13), color: base + ((color & 0xE0) >> 5) };
  }
  // The sprite's priority against the three layers, sorted front to back (pri-buffer values 1, 2, 4).
  spriteCallback(code, color) {
    const p = 0x20 | ((color & 0x60) >> 2), [l0, l1, l2] = this.layerPri;
    const mask = p <= l2 ? 0 : p <= l1 ? 0xF0 : p <= l0 ? 0xFC : 0xFE;
    return { code, color: this.mixer.paletteIndex(1) + (color & 0x1F), priority: mask };
  }

  render() {
    const p = this.palette, m = this.mixer;
    // The three layers in priority order (highest first), drawn back to front.
    const layers = [[0, m.priority(2)], [1, m.priority(4)], [2, m.priority(3)]].sort((a, b) => b[1] - a[1]);
    this.layerPri = layers.map((l) => l[1]);
    this.frame.fill(p[16 * m.paletteIndex(0)]); this.pri.fill(0);
    this.tiles.draw(layers[0][0], this.frame, this.pri, p, WIN, { priority: 1 });
    this.tiles.draw(layers[1][0], this.frame, this.pri, p, WIN, { priority: 2 });
    this.tiles.draw(layers[2][0], this.frame, this.pri, p, WIN, { priority: 4 });
    this.sprites.draw(this.frame, this.pri, p, WIN);
  }

  runFrame() {
    const mainLine = CPU_CLOCK / REFRESH / LINES, soundLine = SOUND_CLOCK / REFRESH / LINES;
    const samples = RATE / REFRESH / LINES, dt = 1 / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK) { if (this.tiles.irqEnabled) this.cpu.irq = true; this.render(); }
      this.cycleCarry += mainLine;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      if (this.nmiPending) { this.nmiPending = 0; this.snd.nmi(); }
      this.ym.timers(dt);
      this.soundCarry += soundLine;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // P1: start, up, down, left, right, power-up, shoot, missile (active low). DSW3: coins in bits 2-3.
  setInputs(s) {
    this.in[0] = 0xFF & ~((s.start1 ? 1 : 0) | (s.up ? 2 : 0) | (s.down ? 4 : 0) | (s.left ? 8 : 0) | (s.right ? 0x10 : 0)
      | (s.fire3 ? 0x20 : 0) | (s.fire ? 0x40 : 0) | (s.fire2 ? 0x80 : 0));
    this.in[1] = 0xFF & ~(s.start2 ? 1 : 0);
    this.in[2] = 0xFF & ~(s.coin ? 0x04 : 0);
  }
  // DSW1: 1 coin 1 credit. DSW2: lives, upright, bonus, difficulty, demo sounds.
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = v.lives | v.bonus | v.difficulty; }
}
Parodius.id = 'parodius';
Parodius.title = 'Parodius Da!';
Parodius.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x03], ['3', 0x02], ['4', 0x01], ['7', 0x00]], default: 0x02 },
  { id: 'bonus', label: 'Bonus life', options: [['20K 80K', 0x18], ['30K 100K', 0x10], ['20K', 0x08], ['70K', 0x00]], default: 0x18 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Difficult', 0x20], ['Very difficult', 0x00]], default: 0x40 },
];
