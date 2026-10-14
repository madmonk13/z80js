// Konami's 68000 boards with the K052109 / K051960 pair (1989): M.I.A. and
// Teenage Mutant Ninja Turtles. A 68000 at 8 MHz; a Z80 for sound with a
// YM2151 and a K007232 (TMNT adds a uPD7759 for speech and a 16-bit title
// music recording played straight from ROM).
//
// The 68000 sees the tile chip as words (color byte high, code byte low)
// with its A12 line unconnected, so the 16K chip spans 32K with mirrors.
// Both games' graphics ROMs are wired to the chips with their bits in a
// different order, and their sprite ROM address lines shuffled per sprite
// size (TMNT through a PROM); the ROMs are rearranged at load.
//
// The picture is 304x224 (x 104-407, y 16-239 of the chips' bitmap).

import { M68000 } from './m68000.js';
import { Z80 } from './z80.js';
import { YM2151 } from './ym2151.js';
import { K007232 } from './k007232.js';
import { UPD7759 } from './upd7759.js';
import { K052109, K051960, deinterleave2 } from './konamiic.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const WIN = { x: 104, y: 16, w: 304, h: 224 };
const LINES = 256, VBLANK = 240, MAIN_CLOCK = 8000000, SOUND_CLOCK = 3579545;
const STATE = ['ram', 'ram2', 'palRam', 'soundRam', 'latch', 'ctl', 'priority', 'sres', 'in', 'cycleCarry', 'soundCarry',
  'sampleCarry', 'cpu', 'snd', 'tiles', 'sprites', 'ym', 'k007232', 'upd', 'title'];

// The 051962 / 051937 see each 32-bit group's bits transposed.
function transposeBits(rom) {
  const out = new Uint8Array(rom.length);
  for (let i = 0; i < rom.length; i += 4) {
    for (let j = 0; j < 4; j++) {
      let v = 0;
      for (let k = 0; k < 8; k++) {
        const bit = j + 4 * k;                       // source bit index in the group
        v |= ((rom[i + (bit >> 3)] >> (bit & 7)) & 1) << k;
      }
      out[i + j] = v;
    }
  }
  return out;
}

// Sprite ROM line addresses: which source address line feeds each of the
// low output lines, per sprite size (from the TMNT schematics).
const PICK = [
  [3, 3, 3, 3, 3, 3, 3, 3], [0, 0, 5, 5, 5, 5, 5, 5], [1, 1, 0, 0, 0, 7, 7, 7], [2, 2, 1, 1, 1, 0, 0, 9], [4, 4, 2, 2, 2, 1, 1, 0],
  [5, 6, 4, 4, 4, 2, 2, 1], [6, 5, 6, 6, 6, 4, 4, 2], [7, 7, 7, 7, 8, 6, 6, 4], [8, 8, 8, 8, 7, 8, 8, 6], [9, 9, 9, 9, 9, 9, 9, 8],
];
function tmntSprites(rom, prom) {
  const out = new Uint8Array(rom.length);
  for (let a = 0; a < rom.length / 4; a++) {
    const entry = prom[(a & 0x7F800) >> 11] & 7;
    let b = a & 0x7FC00;
    for (let i = 0; i < 10; i++) b |= ((a >> PICK[i][entry]) & 1) << i;
    out.set(rom.subarray(b * 4, b * 4 + 4), a * 4);
  }
  return out;
}
function miaSprites(rom) {
  const out = new Uint8Array(rom.length);
  const big = [3, 5, 0, 1, 2, 4, 6, 7], small = [3, 5, 7, 0, 1, 2, 4, 6];
  for (let a = 0; a < rom.length / 4; a++) {
    const pick = (a & 0x3C000) === 0x3C000 ? big : small;
    let b = a & 0x3FF00;
    for (let i = 0; i < 8; i++) b |= ((a >> pick[i]) & 1) << i;
    out.set(rom.subarray(b * 4, b * 4 + 4), a * 4);
  }
  return out;
}

// TMNT's title music: 16-bit words, a 3-bit exponent and 10 bits of sample,
// played at 20 kHz.
class TitleSample {
  constructor(rom) {
    this.data = new Float32Array(rom.length / 2);
    for (let i = 0; i < this.data.length; i++) {
      const v = rom[2 * i] | (rom[2 * i + 1] << 8), e = v >> 13;
      this.data[i] = ((((v >> 3) & 0x3FF) - 0x200) * Math.pow(2, e - 3)) / 32768;
    }
    this.reset();
  }
  saveState() { return { pos: this.pos, playing: this.playing }; }
  loadState(s) { this.pos = s.pos; this.playing = s.playing; }
  reset() { this.pos = 0; this.playing = 0; this.out = 0; }
  sample() {
    if (!this.playing) { this.out = 0; return; }
    this.out = this.data[Math.floor(this.pos)] ?? 0;
    this.pos += 20000 / RATE;
    if (this.pos >= this.data.length) this.playing = 0;
  }
}

export class KonamiTMNT {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 1024; i++) this.setColor(i); }

  constructor(roms) {
    const tmnt = this.constructor.tmnt;
    this.roms = roms;
    this.width = WIN.w; this.height = WIN.h; this.refresh = 60;
    this.controls = 'eight-way';
    this.buttons = tmnt ? 2 : 3;
    this.ram = new Uint8Array(0x4000);           // 060000
    this.ram2 = new Uint8Array(0x4000);          // 040000 (M.I.A.)
    this.palRam = new Uint16Array(0x800);        // 080000: word RAM; a color takes the low bytes of two words
    this.soundRam = new Uint8Array(0x800);
    this.palette = new Uint32Array(1024).fill(0xFF000000);
    const tiles = transposeBits(deinterleave2(roms.tiles));
    const spr = transposeBits(deinterleave2(roms.sprites));
    this.tiles = new K052109(tiles, (l, b, c, col) => this.tileCallback(l, b, c, col));
    this.sprites = new K051960(tmnt ? tmntSprites(spr, roms.prom) : miaSprites(spr), (c, col) => this.spriteCallback(c, col), true);
    this.cpu = new M68000({
      read8: (a) => this.read8(a), read16: (a) => this.read16(a),
      write8: (a, v) => this.write8(a, v), write16: (a, v) => this.write16(a, v),
    });
    this.cpu.onIrqAck = () => { this.cpu.irq = 0; };
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.ym = new YM2151(SOUND_CLOCK, 0.8);
    this.k007232 = [new K007232(SOUND_CLOCK, roms.samples, 0.6)];
    const k = this.k007232[0];
    k.onPort = (v) => { k.setVolume(0, (v >> 4) / 15); k.setVolume(1, (v & 15) / 15); };
    this.upd = tmnt ? new UPD7759(640000, 0.6, () => {}, roms.speech) : null;
    this.title = tmnt ? new TitleSample(roms.title) : null;
    this.sound = new SoundMix([this.ym, k, ...(tmnt ? [this.upd, this.title] : [])], 1);
    this.frame = new Uint32Array(WIN.w * WIN.h);
    this.pri = new Uint8Array(WIN.w * WIN.h);
    this.in = new Uint8Array(5).fill(0xFF);
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.ram2.fill(0); this.palRam.fill(0); this.soundRam.fill(0); this.palette.fill(0xFF000000);
    this.latch = 0; this.ctl = 0; this.priority = 0; this.sres = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.tiles.reset(); this.sprites.reset();
    this.cpu.reset(); this.snd.reset(); this.ym.reset(); this.k007232[0].reset();
    if (this.upd) { this.upd.reset(); this.title.reset(); }
  }

  setColor(i) {
    const c = ((this.palRam[i * 2] & 0xFF) << 8) | (this.palRam[i * 2 + 1] & 0xFF), l = (v) => (v << 3) | (v >> 2);
    this.palette[i] = rgba(l(c & 31), l((c >> 5) & 31), l((c >> 10) & 31));
  }

  // ---------------------------------------------------------------- 68000

  tileOffset(a) { const o = (a - 0x100000) >> 1; return ((o & 0x3000) >> 1) | (o & 0x7FF); }

  read16(a) {
    a &= 0xFFFFFF;
    if (a < this.roms.main.length) return (this.roms.main[a] << 8) | this.roms.main[a + 1];
    if (a >= 0x60000 && a < 0x64000) { const o = a - 0x60000; return (this.ram[o] << 8) | this.ram[o + 1]; }
    if (a >= 0x40000 && a < 0x44000) { const o = a - 0x40000; return (this.ram2[o] << 8) | this.ram2[o + 1]; }
    if (a >= 0x80000 && a < 0x81000) return this.palRam[(a - 0x80000) >> 1];
    if (a >= 0x100000 && a < 0x108000) { const o = this.tileOffset(a); return (this.tiles.read(o) << 8) | this.tiles.read(o + 0x2000); }
    if (a >= 0x140000 && a < 0x140008) { const o = (a - 0x140000) & ~1; return (this.sprites.readReg(o) << 8) | this.sprites.readReg(o + 1); }
    if (a >= 0x140400 && a < 0x140800) { const o = (a - 0x140400) & ~1; return (this.sprites.read(o) << 8) | this.sprites.read(o + 1); }
    if (a >= 0xA0000 && a < 0xA0020) return this.ioRead(a & 0x1E);
    return 0xFFFF;
  }
  read8(a) { const w = this.read16(a & ~1); return a & 1 ? w & 0xFF : w >> 8; }

  write16(a, v) { this.write8(a & ~1, v >> 8, true); this.write8(a | 1, v & 0xFF, true); }
  write8(a, v) {
    a &= 0xFFFFFF;
    if (a >= 0x60000 && a < 0x64000) { this.ram[a - 0x60000] = v; return; }
    if (a >= 0x40000 && a < 0x44000) { this.ram2[a - 0x40000] = v; return; }
    if (a >= 0x80000 && a < 0x81000) {
      const i = (a - 0x80000) >> 1, w = this.palRam[i];
      this.palRam[i] = a & 1 ? (w & 0xFF00) | v : (w & 0xFF) | (v << 8);
      this.setColor(i >> 1);
      return;
    }
    if (a >= 0x100000 && a < 0x108000) { const o = this.tileOffset(a & ~1); this.tiles.write(a & 1 ? o + 0x2000 : o, v); return; }
    if (a >= 0x140000 && a < 0x140008) { this.sprites.writeReg(a - 0x140000, v); return; }
    if (a >= 0x140400 && a < 0x140800) { this.sprites.write(a - 0x140400, v); return; }
    if (!(a & 1)) return;
    switch (a) {
      case 0xA0001: {                              // coin counters, sound IRQ (bit 3 falling), IRQ enable, ROM reading
        if ((this.ctl & 0x08) && !(v & 0x08)) { this.snd.irqVector = 0xFF; this.snd.irq = true; }
        this.ctl = v; this.tiles.rmrd = v & 0x80;
        return;
      }
      case 0xA0009: this.latch = v; return;
      case 0xC0001: this.priority = (v & 0x0C) >> 2; return;
    }
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0x8800) return this.soundRam[a - 0x8000];
    if (a === 0x9000) return this.sres;
    if (a === 0xA000) return this.latch;
    if (a >= 0xB000 && a < 0xB00E) return this.k007232[0].read(a & 15);
    if (a === 0xC001) return this.ym.read();
    if (a === 0xF000) return this.upd && this.upd.busy() ? 0 : 1;
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0x8000 && a < 0x8800) this.soundRam[a - 0x8000] = v;
    else if (a >= 0xB000 && a < 0xB00E) this.k007232[0].write(a & 15, v);
    else if (a === 0xC000) this.ym.select(v);
    else if (a === 0xC001) this.ym.write(v);
    else if (this.upd) {
      if (a === 0x9000) {                          // uPD7759 reset (bit 1), title music (bit 2)
        this.upd.resetLine(v & 2);
        if (v & 4) { if (!this.title.playing) { this.title.playing = 1; this.title.pos = 0; } } else this.title.playing = 0;
        this.sres = v;
      } else if (a === 0xD000) this.upd.data(v);
      else if (a === 0xE000) this.upd.start(v);
    }
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const mainLine = MAIN_CLOCK / 60 / LINES, soundLine = SOUND_CLOCK / 60 / LINES, samples = RATE / 60 / LINES, dt = 1 / 60 / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK) { this.render(); if (this.ctl & 0x20) this.cpu.irq = 5; }
      this.cycleCarry += mainLine;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.ym.timers(dt);
      this.soundCarry += soundLine;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  render() {
    const p = this.palette, f = this.frame, pr = this.pri;
    pr.fill(0);
    this.tiles.draw(2, f, pr, p, WIN, { opaque: true });
    if (this.priority & 1) this.sprites.draw(f, pr, p, WIN, { min: 0, max: 0 });
    this.tiles.draw(1, f, pr, p, WIN);
    if (!(this.priority & 1)) this.sprites.draw(f, pr, p, WIN, { min: 0, max: 0 });
    this.tiles.draw(0, f, pr, p, WIN);
  }

  // Player inputs (active low): left, right, up, down, buttons 1-3, start (80).
  player(s) {
    return 0xFF & ~((s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0)
      | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0) | (s.fire3 ? 0x40 : 0));
  }
}

// ---------------------------------------------------------------- M.I.A.

export class MissingInAction extends KonamiTMNT {
  constructor(roms) { super(roms); this.button2 = 'Weapon'; this.button3 = 'Knife'; }
  ioRead(o) {
    switch (o) {
      case 0x00: return this.in[0];
      case 0x02: return this.in[1];
      case 0x04: return 0xFF;
      case 0x10: return this.dsw1;
      case 0x12: return this.dsw2;
      case 0x18: return this.dsw3;
    }
    return 0xFF;
  }
  tileCallback(layer, bank, code, color) {
    const flags = color & 0x04 ? 1 : 0;
    if (layer === 0) return { code: code | ((color & 0x01) << 8), color: ((color & 0x80) >> 5) + ((color & 0x10) >> 1), flags };
    return { code: code | ((color & 0x01) << 8) | ((color & 0x18) << 6) | (bank << 11), color: [0, 32, 40][layer] + ((color & 0xE0) >> 5), flags };
  }
  spriteCallback(code, color) { return { code, color: 16 + (color & 0x0F) }; }
  // Coin (01), starts (08, 10); one player's stick and three buttons.
  setInputs(s) {
    this.in[0] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in[1] = this.player(s);
  }
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = 0x04 | v.lives | v.bonus | v.difficulty; this.dsw3 = 0xFF; }
}
MissingInAction.id = 'mia';
MissingInAction.title = 'M.I.A. - Missing in Action';
MissingInAction.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x03], ['3', 0x02], ['5', 0x01], ['7', 0x00]], default: 0x02 },
  { id: 'bonus', label: 'Bonus', options: [['30K 80K', 0x18], ['50K 100K', 0x10], ['50K', 0x08], ['100K', 0x00]], default: 0x10 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Very hard', 0x00]], default: 0x40 },
];

// ---------------------------------------------------------------- TMNT

// Teenage Mutant Ninja Turtles (1989, 4 players): each coin slot belongs to
// a turtle; insert a coin and that player joins. Attack and jump. A button
// per turtle drops a coin in that slot and hands the controls to that player.
export class TMNT extends KonamiTMNT {
  constructor(roms) {
    super(roms);
    this.button2 = 'Jump';
    this.startLabels = ['Leo', 'Mike', 'Don', 'Raph'];
    this.startsCoin = true;
    this.slot = 0;
  }
  ioRead(o) {
    switch (o) {
      case 0x00: return this.in[0];
      case 0x02: return this.in[1];
      case 0x04: return this.in[2];
      case 0x06: return this.in[3];
      case 0x14: return this.in[4];
      case 0x10: return this.dsw1;
      case 0x12: return this.dsw2;
      case 0x18: return this.dsw3;
    }
    return 0xFF;
  }
  tileCallback(layer, bank, code, color) {
    return { code: code | ((color & 0x03) << 8) | ((color & 0x10) << 6) | ((color & 0x0C) << 9) | (bank << 13), color: [0, 32, 40][layer] + ((color & 0xE0) >> 5) };
  }
  spriteCallback(code, color) { return { code: code | ((color & 0x10) << 9), color: 16 + (color & 0x0F) }; }
  // Coins 1-4 (bits 0-3) and players 1-4 (Leonardo, Michelangelo, Donatello, Raphael).
  // Coin alone goes in the slot of the turtle last picked.
  setInputs(s) {
    const picked = [s.start1, s.start2, s.start3, s.start4].findIndex(Boolean);
    if (picked >= 0) this.slot = picked;
    this.in[0] = 0xFF & ~(s.coin || picked >= 0 ? 1 << this.slot : 0);
    for (let i = 0; i < 4; i++) this.in[[1, 2, 3, 4][i]] = i === this.slot ? this.player(s) : 0xFF;
  }
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = 0x1C | v.lives | v.difficulty; this.dsw3 = 0xFF; }
}
TMNT.tmnt = true;
TMNT.id = 'tmnt';
TMNT.title = 'Teenage Mutant Ninja Turtles';
TMNT.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x03], ['2', 0x02], ['3', 0x01], ['5', 0x00]], default: 0x03 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Very hard', 0x00]], default: 0x40 },
];
