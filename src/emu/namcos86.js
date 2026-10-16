// Namco System 86 (1986-87): Rolling Thunder, Wonder Momo, Genpei ToumaDen,
// The Return of Ishtar, Hopping Mappy, Sky Kid Deluxe. Two 6809s at 1.536 MHz share
// the video RAM and the sprite RAM; they synchronize through a semaphore in
// RAM, so they run in short interleaved slices. An HD63701 MCU (a 6801 with
// extra instructions, running its own internal program plus a ROM) reads the
// controls and DIP switches and plays the sound: a YM2151 and the CUS30
// waveform chip, whose RAM it shares with the main CPU. Rolling Thunder adds
// a ROM/voice board: 256K of banked data for the main CPU and a 63701X
// sample player for the voices (Wonder Momo and Genpei too). The sub CPU's
// and MCU's address maps differ from game to game (each class's `map`).
//
// Both 6809s must keep kicking a shared watchdog; if either stops (stuck in
// the handshake), the board resets, as the real one does.
//
// Video: four scrolling 64x32 layers of 8x8 tiles at 3 bits per pixel (pen 7
// transparent), each with its own priority (0-7), from two tile ROM sets; up
// to 127 sprites cut from 32x32 cells (4, 8, 16 or 32 pixels on a side), each
// with a priority that puts it above the layers at or below it. Colors go
// through lookup PROMs into a 512-color palette PROM. 288x224 shown.

import { M6809 } from './m6809.js';
import { M6803 } from './m6803.js';
import { YM2151 } from './ym2151.js';
import { CUS30 } from './cus30.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 288, H = 224, X0 = 67, Y0 = 16;           // the visible window within the 512x256 picture
// The CPUs' handshake needs fine interleaving (MAME uses 800 slices; 1600 is safer here).
const REFRESH = 60.606, CLOCK = 49152000 / 32, SLICES = 1600, WATCHDOG = 60;
const XDISP = [47, 49, 46, 48];

// The 63701X: an MCU programmed as a two-voice sample player (6 kHz). Each
// 64K block of the voice ROM starts with a table of sample offsets; samples
// are 8-bit unsigned, 0xFF ends one, and 00 nn stands for nn+1 silent samples.
const VOL = [26, 84, 200, 258];
class Voices {
  constructor(rom, gain) { this.rom = rom; this.gain = gain; this.reset(); }
  reset() {
    this.select = [0, 0]; this.playing = [0, 0]; this.base = [0, 0]; this.pos = [0, 0]; this.vol = [0, 0]; this.silence = [0, 0];
    this.level = [0, 0]; this.acc = 0; this.out = 0;
  }
  saveState() { return capture(this, ['select', 'playing', 'base', 'pos', 'vol', 'silence', 'level', 'acc']); }
  loadState(s) { apply(this, ['select', 'playing', 'base', 'pos', 'vol', 'silence', 'level', 'acc'], s); }

  write(reg, v) {
    const ch = reg >> 1;
    if (reg & 1) { this.select[ch] = v; return; }
    const sel = this.select[ch];
    if (!(sel & 0x1F)) return;
    const base = 0x10000 * (sel >> 5), t = base + 2 * ((sel & 0x1F) - 1);
    this.playing[ch] = 1; this.base[ch] = base; this.pos[ch] = (this.rom[t] << 8) | this.rom[t + 1];
    this.vol[ch] = v >> 6; this.silence[ch] = 0;
  }

  sample() {
    this.acc += 6000 / RATE;
    while (this.acc >= 1) {
      this.acc -= 1;
      for (let ch = 0; ch < 2; ch++) {
        if (!this.playing[ch]) { this.level[ch] = 0; continue; }
        if (this.silence[ch]) { this.silence[ch]--; this.level[ch] = 0; continue; }
        const at = (p) => this.rom[this.base[ch] + (p & 0xFFFF)] ?? 0xFF;
        const d = at(this.pos[ch]++);
        if (d === 0xFF) { this.playing[ch] = 0; this.level[ch] = 0; }
        else if (d === 0) { this.silence[ch] = at(this.pos[ch]++); this.level[ch] = 0; }
        else this.level[ch] = VOL[this.vol[ch]] * (d - 0x80) / 32768;
      }
    }
    this.out = (this.level[0] + this.level[1]) * this.gain;
  }
}

const STATE = ['vram1', 'vram2', 'spriteRam', 'soundRam', 'mcuRam', 'xscroll', 'yscroll', 'tileBank', 'backColor', 'bank1', 'bank2',
  'copySprites', 'kicked', 'quiet', 'in0', 'in1', 'in4', 'carry', 'sampleCarry', 'cpu', 'sub', 'mcu', 'ym', 'sound'];

export class NamcoSystem86 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (32K at 8000), sub (32K at 8000), subBank (32K), mcu (64K space), user (256K banked),
  //         voice (voice ROM), tiles1, tiles2 (planes as on the board), sprites, rg, b, tileCt, spriteCt, decoder }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'four-way';
    this.buttons = 2;
    this.button2 = 'Jump';
    this.roms = roms;
    this.vram1 = new Uint8Array(0x2000);
    this.vram2 = new Uint8Array(0x2000);
    this.spriteRam = new Uint8Array(0x2000);
    this.soundRam = new Uint8Array(0x400);
    this.mcuRam = new Uint8Array(0xC00);
    this.xscroll = new Uint16Array(4);
    this.yscroll = new Uint8Array(4);
    this.frame = new Uint32Array(W * H);
    this.pri = new Uint8Array(W * H);

    // Palette and color lookups.
    const lvl = (v) => 0x0E * (v & 1) + 0x1F * ((v >> 1) & 1) + 0x43 * ((v >> 2) & 1) + 0x8F * ((v >> 3) & 1);
    const pal = Array.from({ length: 512 }, (_, i) => rgba(lvl(roms.rg[i] & 15), lvl(roms.rg[i] >> 4), lvl(roms.b[i] & 15)));
    this.tileColors = Uint32Array.from(roms.tileCt, (v) => pal[v]);
    this.spriteColors = Uint32Array.from(roms.spriteCt, (v) => pal[v + 256]);

    this.tiles = [decodeTileSet(roms.tiles1), decodeTileSet(roms.tiles2)];
    this.spritePix = decodeSprites(roms.sprites);
    this.spriteCount = roms.sprites.length / 512;

    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sub = new M6809({ read: (a) => this.subRead(a), write: (a, v) => this.subWrite(a, v) });
    this.mcu = new M6803({ read: (a) => this.mcuRead(a), write: (a, v) => this.mcuWrite(a, v), portIn: (n) => (n === 1 ? this.in4 : 0xFF), hd63701: true });
    this.ym = new YM2151(3579580, 0.6);
    this.cus30 = new CUS30(this.soundRam, 0.5);
    this.voices = new Voices(roms.voice, 0.8);
    this.sound = new SoundMix([this.ym, this.cus30, this.voices], 2);
    this.in0 = this.in1 = this.in4 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.vram1.fill(0); this.vram2.fill(0); this.spriteRam.fill(0); this.soundRam.fill(0); this.mcuRam.fill(0);
    this.xscroll.fill(0); this.yscroll.fill(0);
    this.tileBank = 0; this.backColor = 0; this.bank1 = 0; this.bank2 = 0; this.copySprites = 0; this.kicked = 0; this.quiet = 0;
    this.carry = 0; this.sampleCarry = 0;
    this.cpu.reset(); this.sub.reset(); this.mcu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x2000) return this.vram1[a];
    if (a < 0x4000) return this.vram2[a - 0x2000];
    if (a < 0x4400) return this.soundRam[a - 0x4000];
    if (a < 0x6000) return this.spriteRam[a - 0x4000];
    if (a < 0x8000) return this.roms.user[this.bank1 * 0x2000 + a - 0x6000] ?? 0xFF;
    return this.roms.main[a - 0x8000];
  }

  write(a, v) {
    if (a < 0x2000) { this.vram1[a] = v; return; }
    if (a < 0x4000) { this.vram2[a - 0x2000] = v; return; }
    if (a < 0x4400) { this.soundRam[a - 0x4000] = v; return; }
    if (a < 0x6000) { this.spriteWrite(a - 0x4000, v); return; }
    if (a < 0x8000) {                                // the expansion board: voice control and data bank
      if (!this.constructor.expansion) return;
      const r = (a >> 9) & 15;
      if (r < 4) this.voices.write(r, v);
      else if (r === 4) this.bank1 = v & 0x1F;
      return;
    }
    if ((a & 0xFC00) === 0x8000) { this.kicked |= 1; return; }
    if ((a & 0xFC00) === 0x8400) { this.cpu.irq = false; return; }
    if ((a & 0xF800) === 0x8800) { this.tileBank = (a >> 10) & 1; return; }
    if ((a & 0xF800) === 0x9000) {                   // scroll and priority latches
      const layer = ((a >> 10) & 1) * 2 + ((a >> 2) & 1), r = a & 3;
      if (r === 0) this.xscroll[layer] = (this.xscroll[layer] & 0xFF) | (v << 8);
      else if (r === 1) this.xscroll[layer] = (this.xscroll[layer] & 0xFF00) | v;
      else if (r === 2) this.yscroll[layer] = v;
      else if (layer === 0 && !this.constructor.expansion) this.bank1 = v & 3;   // the 9D ROM's bank (no expansion board)
      return;
    }
    if ((a & 0xF000) === 0xA000) this.backColor = v;
  }

  // A write to the end of the list tells the sprite chip to take the new list.
  spriteWrite(o, v) {
    this.spriteRam[o] = v;
    if (o === 0x1FF2) this.copySprites = 1;
  }

  // ---------------------------------------------------------------- sub CPU

  // Each game puts the sprite RAM, the two video RAMs and the banked ROM at
  // its own 8K windows below 8000 (the first match wins, as in the hardware's
  // decoder); the program ROM is at 8000-FFFF.
  subRead(a) {
    if (a >= 0x8000) return this.roms.sub[a - 0x8000];
    const m = this.constructor.map, o = a & 0x1FFF, w = a & 0xE000;
    if (w === m.sprite) return this.spriteRam[o];
    if (w === m.video1) return this.vram1[o];
    if (w === m.video2) return this.vram2[o];
    if (w === m.rom && this.roms.subBank) return this.roms.subBank[this.bank2 * 0x2000 + o];
    return 0xFF;
  }

  subWrite(a, v) {
    const m = this.constructor.map, o = a & 0x1FFF, w = a & 0xE000;
    if (a < 0x8000) {
      if (w === m.sprite) this.spriteWrite(o, v);
      else if (w === m.video1) this.vram1[o] = v;
      else if (w === m.video2) this.vram2[o] = v;
      return;
    }
    if (a === m.wdog) this.kicked |= 2;
    else if (a === m.ack) this.sub.irq = false;
    else if (a === m.bank) this.bank2 = v & 3;
  }

  // ---------------------------------------------------------------- MCU

  mcuRead(a) {
    const m = this.constructor.map;
    if (a >= 0x1000 && a < 0x1400) return this.soundRam[a - 0x1000];
    if (a >= 0x1400 && a < 0x2000) return this.mcuRam[a - 0x1400];
    if ((a & 0xF800) === m.input) {
      switch ((a >> 4) & 3) {
        case 0: return this.ym.read();
        case 2: return a & 1 ? this.in1 : this.in0;
        case 3: return a & 1 ? this.dsw1 : this.dsw0;
      }
    }
    if (a >= 0xF000 || (a >= 0x8000 && a < 0xC000) || (a >= m.lowrom && a < m.lowrom + 0x4000)) return this.roms.mcu[a];
    return 0xFF;
  }

  mcuWrite(a, v) {
    if (a >= 0x1000 && a < 0x1400) { this.soundRam[a - 0x1000] = v; return; }
    if (a >= 0x1400 && a < 0x2000) { this.mcuRam[a - 0x1400] = v; return; }
    if ((a & 0xF830) === this.constructor.map.input) { if (a & 1) this.ym.write(v); else this.ym.select(v); }
  }

  // ---------------------------------------------------------------- inputs

  setInputs(s) {
    this.in0 = 0xFF & ~((s.fire2 ? 0x02 : 0) | (s.down ? 0x04 : 0) | (s.coin ? 0x20 : 0) | (s.start1 ? 0x40 : 0));
    this.in1 = 0xFF & ~((s.up ? 0x04 : 0) | (s.start2 ? 0x40 : 0));
    this.in4 = 0xFF & ~((s.fire ? 0x08 : 0) | (s.left ? 0x10 : 0) | (s.right ? 0x20 : 0));
  }

  // The MCU reads the two switch banks through two ports, interleaved.
  applySwitches(v) {
    const [a, b] = this.constructor.dsw(v);
    const bits = (x, list) => list.reduce((r, [from, to]) => r | (((x >> from) & 1) << to), 0);
    this.dsw0 = bits(a, [[0, 4], [2, 5], [4, 6], [6, 7]]) | bits(b, [[0, 0], [2, 1], [4, 2], [6, 3]]);
    this.dsw1 = bits(a, [[1, 4], [3, 5], [5, 6], [7, 7]]) | bits(b, [[1, 0], [3, 1], [5, 2], [7, 3]]);
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const per = CLOCK / REFRESH / SLICES, samples = RATE / REFRESH / SLICES;
    for (let i = 0; i < SLICES; i++) {
      this.carry += per;
      const n = Math.floor(this.carry);
      this.carry -= n;
      this.cpu.run(n);
      this.sub.run(n);
      this.mcu.run(n);
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    this.render();
    if (this.copySprites) {                          // the sprite chip copies bytes 4-9 of each entry to 10-15
      const sr = this.spriteRam;
      for (let i = 0x1800; i < 0x2000; i += 16) for (let j = 10; j < 16; j++) sr[i + j] = sr[i + j - 6];
      this.copySprites = 0;
    }
    this.cpu.irq = true; this.sub.irq = true; this.mcu.irq = true;   // vertical blank
    if (this.kicked === 3) { this.kicked = 0; this.quiet = 0; }
    else if (++this.quiet > WATCHDOG) this.reset();
  }

  render() {
    const out = this.frame, pri = this.pri, tc = this.tileColors;
    out.fill(tc[8 * this.backColor + 7]);
    pri.fill(0);
    const dec = this.roms.decoder;
    for (let p = 0; p < 8; p++) {
      for (let layer = 3; layer >= 0; layer--) {
        if (((this.xscroll[layer] >> 9) & 7) !== p) continue;
        const vram = layer < 2 ? this.vram1 : this.vram2, vo = (layer & 1) * 0x1000;
        const set = this.tiles[layer >> 1], count = set.length / 64;
        const sx = this.xscroll[layer] - XDISP[layer], sy = this.yscroll[layer] + 9;
        for (let y = 0; y < H; y++) {
          const ty = (y + Y0 + sy) & 255, row = (ty >> 3) * 64, fy = (ty & 7) * 8, o = y * W;
          // A tile run at a time: the tile code and colors are looked up once per run.
          for (let x = 0; x < W;) {
            const tx = (x + X0 + sx) & 511, n = Math.min(8 - (tx & 7), W - x);
            const idx = vo + 2 * (row + (tx >> 3)), attr = vram[idx + 1];
            let code = vram[idx];
            if (layer & 2) code += ((dec[((layer & 1) << 4) + (attr & 3)] & 0xE0) >> 5) * 0x100;
            else code += ((dec[((layer & 1) << 4) + ((attr & 3) << 2)] & 0x0E) >> 1) * 0x100 + this.tileBank * 0x800;
            const src = (code % count) * 64 + fy + (tx & 7), cb = attr * 8;
            for (let i = 0; i < n; i++) {
              const pen = set[src + i];
              if (pen === 7) continue;
              out[o + x + i] = tc[cb + pen];
              pri[o + x + i] = p;
            }
            x += n;
          }
        }
      }
    }
    this.drawSprites();
  }

  drawSprites() {
    const sr = this.spriteRam, S = 0x1800, out = this.frame, pri = this.pri, sc = this.spriteColors, pix = this.spritePix;
    const SIZE = [16, 8, 32, 4];
    const xoffs = sr[S + 0x7F5] + ((sr[S + 0x7F4] & 1) << 8), yoffs = sr[S + 0x7F7];
    const bankSize = this.spriteCount / 8;
    for (let s = S + 0x800 - 0x20; s >= S; s -= 16) {   // the last entry is the control block
      const attr1 = sr[s + 10], attr2 = sr[s + 14], color = sr[s + 12];
      const flipx = (attr1 >> 5) & 1, flipy = attr2 & 1;
      const sizex = SIZE[attr1 >> 6], sizey = SIZE[(attr2 >> 1) & 3];
      const tx = (attr1 & 0x18) & ~(sizex - 1), ty = (attr2 & 0x18) & ~(sizey - 1);
      const code = (sr[s + 11] & (bankSize - 1)) + (attr1 & 7) * bankSize;
      const p = attr2 >> 5;
      const px = ((sr[s + 13] + ((color & 1) << 8) + xoffs) & 0x1FF) - X0;
      const py = (((-sr[s + 15] - sizey - yoffs + 1) + 16) & 0xFF) - 16 - Y0;
      const cbase = (color >> 1) * 16, src = code * 1024;
      for (let y = 0; y < sizey; y++) {
        const oy = py + y;
        if (oy < 0 || oy >= H) continue;
        const sy = ty + (flipy ? sizey - 1 - y : y);
        for (let x = 0; x < sizex; x++) {
          const ox = px + x;
          if (ox < 0 || ox >= W) continue;
          const pen = pix[src + sy * 32 + tx + (flipx ? sizex - 1 - x : x)];
          if (pen === 15) continue;
          const o = oy * W + ox;
          if (pri[o] <= p) out[o] = sc[cbase + pen];
          pri[o] = 31;                                 // later (lower) sprites still draw over this pixel... as on the hardware
        }
      }
    }
  }
}

// Tiles: 8x8, three planes. The first two thirds of the ROM hold planes 1 and 2
// (two pixels' worth of each per byte pair), the last third plane 0, inverted.
function decodeTileSet(rom) {
  const twoThirds = rom.length * 2 / 3, count = twoThirds / 16;
  const out = new Uint8Array(count * 64);
  for (let t = 0; t < count; t++) {
    for (let y = 0; y < 8; y++) {
      const d1 = rom[t * 16 + y * 2], d2 = rom[t * 16 + y * 2 + 1], mono = ~rom[twoThirds + t * 8 + y] & 0xFF;
      const lo = ((d1 & 15) << 4) | (d2 & 15), mid = (d1 & 0xF0) | (d2 >> 4);
      for (let x = 0; x < 8; x++) {
        const b = 7 - x;
        out[t * 64 + y * 8 + x] = (((mono >> b) & 1) << 2) | (((mid >> b) & 1) << 1) | ((lo >> b) & 1);
      }
    }
  }
  return out;
}

// Sprites: 32x32 cells of 4-bit pixels, two to a byte, in four 16x16 quarters.
function decodeSprites(rom) {
  const count = rom.length / 512, out = new Uint8Array(count * 1024);
  for (let t = 0; t < count; t++) {
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const byte = rom[t * 512 + (y >> 4) * 256 + (x >> 4) * 128 + (y & 15) * 8 + ((x & 15) >> 1)];
        out[t * 1024 + y * 32 + x] = x & 1 ? byte & 15 : byte >> 4;
      }
    }
  }
  return out;
}

// Address maps: the sub CPU's 8K windows (sprite RAM, the two video RAMs,
// banked ROM), its watchdog / IRQ-acknowledge / bank addresses, and the
// MCU's switch-and-sound page and low ROM. 0x4000 marks unused windows
// (MAME's convention: the sprite RAM there shadows the rest).
const U = 0x4000;
const map = (sprite, video1, video2, rom, bank, wdog, ack, lowrom, input) => ({ sprite, video1, video2, rom, bank, wdog, ack, lowrom, input });
// Two switch banks, A and B, as one function of the game's switch settings.
const coinsA = 0xFF;

export class RollingThunder extends NamcoSystem86 {}
RollingThunder.id = 'rthunder'; RollingThunder.title = 'Rolling Thunder';
RollingThunder.expansion = true;
RollingThunder.map = map(0x0000, 0x2000, 0x4000, 0x6000, 0xD803, 0x8000, 0x8800, 0x4000, 0x2000);
RollingThunder.dsw = (v) => [coinsA, v.lives | v.bonus | v.timer | v.difficulty | 0x08 | 0x06 | v.continues];
RollingThunder.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x80], ['5', 0x00]], default: 0x80 },
  { id: 'bonus', label: 'Bonus life', options: [['70K, 200K', 0x40], ['100K, 300K', 0x00]], default: 0x40 },
  { id: 'timer', label: 'Timer', options: [['120 seconds', 0x20], ['150 seconds', 0x00]], default: 0x00 },
  { id: 'difficulty', label: 'Difficulty', options: [['Normal', 0x10], ['Easy', 0x00]], default: 0x10 },
  { id: 'continues', label: 'Continues', options: [['3', 0x00], ['6', 0x01]], default: 0x01 },
];

export class WonderMomo extends NamcoSystem86 {}
WonderMomo.id = 'wndrmomo'; WonderMomo.title = 'Wonder Momo';
WonderMomo.expansion = true;
WonderMomo.map = map(0x2000, 0x4000, 0x6000, U, -1, 0xC000, 0xC800, 0x4000, 0x3800);
WonderMomo.switches = [];
WonderMomo.dsw = () => [coinsA, 0xFB];

export class Genpei extends NamcoSystem86 { constructor(roms) { super(roms); this.controls = 'eight-way'; } }
Genpei.id = 'genpeitd'; Genpei.title = 'Genpei ToumaDen';
Genpei.expansion = true;
Genpei.map = map(0x4000, 0x0000, 0x2000, U, -1, 0xB000, 0x8800, 0x4000, 0x2800);
Genpei.switches = [
  { id: 'candle', label: 'Candle', options: [['40', 0x80], ['50', 0xC0], ['60', 0x40], ['70', 0x00]], default: 0xC0 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x20], ['Normal', 0x30], ['Hard', 0x10], ['Hardest', 0x00]], default: 0x30 },
];
Genpei.dsw = (v) => [coinsA, v.candle | v.difficulty | 0x0C];

// Two characters, two sticks: Gil (left stick) and Ki (right stick, the aim side here).
export class ReturnOfIshtar extends NamcoSystem86 {
  constructor(roms) { super(roms); this.controls = 'eight-way'; this.twinStick = true; this.buttons = 0; }   // (buttons: keyboard/gamepad)
  setInputs(s) {
    const a = s.aim || {};
    this.in0 = 0xFF & ~((s.fire2 ? 0x02 : 0) | (s.down ? 0x04 : 0) | (a.down ? 0x08 : 0) | (a.right ? 0x10 : 0) | (s.coin ? 0x20 : 0) | (s.start1 ? 0x40 : 0));
    this.in1 = 0xFF & ~((s.up ? 0x04 : 0) | (a.up ? 0x08 : 0) | (s.start2 ? 0x40 : 0));
    this.in4 = 0xFF & ~((s.fire ? 0x08 : 0) | (s.left ? 0x10 : 0) | (s.right ? 0x20 : 0) | (a.left ? 0x80 : 0));
  }
}
ReturnOfIshtar.id = 'roishtar'; ReturnOfIshtar.title = 'The Return of Ishtar';
ReturnOfIshtar.map = map(0x0000, 0x6000, 0x4000, U, -1, 0xA000, 0xB000, 0x0000, 0x6000);
ReturnOfIshtar.switches = [];
ReturnOfIshtar.dsw = () => [coinsA, 0xBF];

export class HoppingMappy extends NamcoSystem86 { constructor(roms) { super(roms); this.controls = 'eight-way'; this.buttons = 1; } }
HoppingMappy.id = 'hopmappy'; HoppingMappy.title = 'Hopping Mappy';
HoppingMappy.map = map(U, U, U, U, -1, 0x9000, U, U, 0x2000);
HoppingMappy.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x10], ['2', 0x08], ['3', 0x18], ['5', 0x00]], default: 0x18 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x80], ['Hard', 0x00]], default: 0x80 },
];
HoppingMappy.dsw = (v) => [0xE7 | v.lives, 0x7F | v.difficulty];

export class SkyKidDeluxe extends NamcoSystem86 { constructor(roms) { super(roms); this.controls = 'eight-way'; this.button2 = 'Loop'; } }
SkyKidDeluxe.id = 'skykiddx'; SkyKidDeluxe.title = 'Sky Kid Deluxe';
SkyKidDeluxe.map = map(U, U, U, U, -1, 0x9000, 0x9400, U, 0x2000);
SkyKidDeluxe.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x80], ['2', 0x40], ['3', 0xC0], ['5', 0x00]], default: 0xC0 },
];
SkyKidDeluxe.dsw = (v) => [coinsA, 0x3F | v.lives];
