// Tecmo's late-80s board (Rygar, Gemini Wing, Silkworm): a Z80 at 6 MHz with
// a 2K window onto banked ROM, a second Z80 at 4 MHz driving a YM3812 and an
// MSM5205 (its ADPCM samples fed from ROM a nibble at a time), two scrolling
// layers of 16x16 tiles and a text layer of 8x8, sprites built from 8x8
// cells in blocks up to 64x64, and 1024 colors in RAM (4 bits per gun).
//
// Sprites have two priority bits that tuck them behind the text, the
// foreground or both playfields. The main CPU is interrupted at vblank; the
// sound CPU takes an NMI for each command and the YM3812's timer IRQ.
//
// Silkworm is a two-player game with a different vehicle per side: player 1
// flies the helicopter, player 2 drives the jeep. Either start button begins
// a one-player game with that vehicle, so the touch controls follow
// whichever start was pressed.

import { Z80 } from './z80.js';
import { YM3812 } from './ym3812.js';
import { MSM5205 } from './msm5205.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16;
const LINES = 262, MAIN_CLOCK = 6000000, SOUND_CLOCK = 4000000;
const ADPCM_RATE = 8000;
const STATE = ['ram', 'bgRam', 'fgRam', 'txRam', 'spriteRam', 'palRam', 'soundRam', 'bank', 'bgScroll', 'fgScroll',
  'latch', 'adpcmPos', 'adpcmEnd', 'adpcmNibble', 'player', 'ports', 'cycleCarry', 'soundCarry', 'sampleCarry',
  'adpcmCarry', 'cpu', 'sndCpu', 'ym', 'msm'];

// Sprite cells within a block, by row and column (8x8 cells numbered in 16x16 quarters).
const CELL = [
  [0, 1, 4, 5, 16, 17, 20, 21], [2, 3, 6, 7, 18, 19, 22, 23], [8, 9, 12, 13, 24, 25, 28, 29], [10, 11, 14, 15, 26, 27, 30, 31],
  [32, 33, 36, 37, 48, 49, 52, 53], [34, 35, 38, 39, 50, 51, 54, 55], [40, 41, 44, 45, 56, 57, 60, 61], [42, 43, 46, 47, 58, 59, 62, 63],
];
// Which layers hide a sprite, by its priority (layer bits: 1 background, 2 foreground, 4 text).
const HIDDEN_BY = [0, 4, 6, 7];

export class Tecmo {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 1024; i++) this.setColor(i); }

  // roms: { main (0000-BFFF, then banks from 10000), sound, chars, sprites, fg, bg tiles, adpcm }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = 60;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.roms = roms;
    this.ram = new Uint8Array(0x1000);
    this.bgRam = new Uint8Array(0x400);         // codes, then attributes (color, code bits)
    this.fgRam = new Uint8Array(0x400);
    this.txRam = new Uint8Array(0x800);
    this.spriteRam = new Uint8Array(0x800);
    this.palRam = new Uint8Array(0x800);
    this.soundRam = new Uint8Array(0x800);
    this.palette = new Uint32Array(1024).fill(0xFF000000);

    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.sndCpu = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.ym = new YM3812(4000000, 1);
    this.msm = new MSM5205(0.5);
    this.sound = new SoundMix([this.ym, this.msm], 1);

    const cells = (rom) => decodeTiles(rom, {
      count: rom.length / 32, width: 8, height: 8, planes: [0, 1, 2, 3], xs: run(0, 8, 4), ys: run(0, 8, 32), size: 256,
    });
    const tiles = (rom) => decodeTiles(rom, {
      count: rom.length / 128, width: 16, height: 16, planes: [0, 1, 2, 3],
      xs: [...run(0, 8, 4), ...run(256, 8, 4)], ys: [...run(0, 8, 32), ...run(512, 8, 32)], size: 1024,
    });
    this.charPix = cells(roms.chars);
    this.spritePix = cells(roms.sprites);
    this.spriteCount = roms.sprites.length / 32;
    this.fgPix = tiles(roms.fg);
    this.bgPix = tiles(roms.bg);
    this.fgCount = roms.fg.length / 128; this.bgCount = roms.bg.length / 128;

    this.frame = new Uint32Array(W * H);
    this.pri = new Uint8Array(W * H);
    this.ports = new Uint8Array(16);
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const r of [this.ram, this.bgRam, this.fgRam, this.txRam, this.spriteRam, this.palRam, this.soundRam]) r.fill(0);
    this.palette.fill(0xFF000000);
    this.bank = 0; this.bgScroll = new Uint8Array(3); this.fgScroll = new Uint8Array(3);
    this.latch = 0; this.adpcmPos = 0; this.adpcmEnd = 0; this.adpcmNibble = -1;
    this.player = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = this.adpcmCarry = 0;
    this.cpu.reset(); this.sndCpu.reset(); this.ym.reset(); this.msm.reset();
  }

  // ---------------------------------------------------------------- main CPU (Silkworm's map)

  read(a) {
    if (a < 0xC000) return this.roms.main[a];
    if (a < 0xC400) return this.bgRam[a - 0xC000];
    if (a < 0xC800) return this.fgRam[a - 0xC400];
    if (a < 0xD000) return this.txRam[a - 0xC800];
    if (a < 0xE000) return this.ram[a - 0xD000];
    if (a < 0xE800) return this.spriteRam[a - 0xE000];
    if (a < 0xF000) return this.palRam[a - 0xE800];
    if (a < 0xF800) return this.roms.main[0x10000 + this.bank * 0x100 + (a - 0xF000)] ?? 0xFF;
    if (a < 0xF810) return this.ports[a & 15];
    return 0xFF;
  }

  write(a, v) {
    if (a < 0xC000) return;
    if (a < 0xC400) this.bgRam[a - 0xC000] = v;
    else if (a < 0xC800) this.fgRam[a - 0xC400] = v;
    else if (a < 0xD000) this.txRam[a - 0xC800] = v;
    else if (a < 0xE000) this.ram[a - 0xD000] = v;
    else if (a < 0xE800) this.spriteRam[a - 0xE000] = v;
    else if (a < 0xF000) { this.palRam[a - 0xE800] = v; this.setColor((a - 0xE800) >> 1); }
    else if (a >= 0xF800 && a < 0xF803) this.fgScroll[a - 0xF800] = v;
    else if (a >= 0xF803 && a < 0xF806) this.bgScroll[a - 0xF803] = v;
    else if (a === 0xF806) { this.latch = v; this.sndCpu.nmi(); }
    else if (a === 0xF808) this.bank = v & 0xF8;
    // F807 flip screen (cocktail only), F809/F80B unknown.
  }

  // Palette: two bytes per color, xxxxBBBB RRRRGGGG.
  setColor(i) {
    const hi = this.palRam[i * 2], lo = this.palRam[i * 2 + 1];
    this.palette[i] = rgba((lo >> 4) * 17, (lo & 15) * 17, (hi & 15) * 17);
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a] ?? 0xFF;
    if (a < 0x8800) return this.soundRam[a - 0x8000];
    if (a === 0xC000) return this.latch;
    return 0xFF;
  }

  soundWrite(a, v) {
    if (a >= 0x8000 && a < 0x8800) this.soundRam[a - 0x8000] = v;
    else if (a === 0xA000) this.ym.select(v);
    else if (a === 0xA001) this.ym.write(v);
    else if (a === 0xC000) { this.adpcmPos = v << 8; this.msm.hold(false); }
    else if (a === 0xC400) this.adpcmEnd = (v + 1) << 8;
    else if (a === 0xC800) this.msm.gain = 0.5 * (v & 15) / 15;
    // CC00: NMI acknowledge.
  }

  // The sample clock: each tick plays the next nibble, high first.
  adpcmTick() {
    if (this.adpcmPos >= this.adpcmEnd || this.adpcmPos >= this.roms.adpcm.length) { this.msm.hold(true); return; }
    if (this.adpcmNibble >= 0) { this.msm.data(this.adpcmNibble & 15); this.adpcmNibble = -1; }
    else { const b = this.roms.adpcm[this.adpcmPos++]; this.adpcmNibble = b; this.msm.data(b >> 4); }
    this.msm.clock();
  }

  // ---------------------------------------------------------------- inputs

  // Each port is a nibble, active high. F800/F801 player 1's stick and
  // buttons, F802/F803 player 2's; F806-F809 the switches; F80F starts and coins.
  setInputs(s) {
    if (s.start1) this.player = 0;
    else if (s.start2) this.player = 1;
    const stick = (s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.down ? 4 : 0) | (s.up ? 8 : 0);
    const buttons = (s.fire2 ? 1 : 0) | (s.fire ? 2 : 0) | (s.fire3 ? 4 : 0);
    const p = this.ports;
    p[0] = p[1] = p[2] = p[3] = 0;
    p[this.player * 2] = stick; p[this.player * 2 + 1] = buttons;
    p[15] = (s.start1 ? 1 : 0) | (s.start2 ? 2 : 0) | (s.coin ? 4 : 0);
  }

  applySwitches(v) {
    const p = this.ports;
    p[6] = 0;                                    // 1 coin 1 credit
    p[7] = v.lives | v.demoSounds;
    p[8] = v.bonus;
    p[9] = v.difficulty;                         // continues allowed
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const mainLine = MAIN_CLOCK / 60 / LINES, soundLine = SOUND_CLOCK / 60 / LINES, dt = 1 / 60 / LINES;
    const samples = RATE / 60 / LINES, ticks = ADPCM_RATE / 60 / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === TOP + H) { this.cpu.irq = true; this.render(); }
      this.cycleCarry += mainLine;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.ym.timers(dt);
      this.sndCpu.irq = this.ym.irq;
      this.soundCarry += soundLine;
      this.soundCarry -= this.sndCpu.run(Math.floor(this.soundCarry));
      this.adpcmCarry += ticks;
      while (this.adpcmCarry >= 1) { this.adpcmCarry -= 1; this.adpcmTick(); }
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  // A 32x16 map of 16x16 tiles (512x256), scrolled; pen 0 is see-through.
  playfield(ram, pix, count, scroll, base, bit) {
    const out = this.frame, pri = this.pri, pal = this.palette;
    const sx = (scroll[0] | (scroll[1] << 8)) + 48, sy = scroll[2];
    for (let y = 0; y < H; y++) {
      const ty = (y + TOP + sy) & 0xFF, row = ty >> 4, py = ty & 15;
      for (let x = 0; x < W; x++) {
        const tx = (x + sx) & 0x1FF, i = row * 32 + (tx >> 4), attr = ram[i + 0x200];
        const code = (ram[i] + ((attr & 7) << 8)) % count;
        const pen = pix[code * 256 + py * 16 + (tx & 15)];
        if (!pen) continue;
        const o = y * W + x;
        out[o] = pal[base + (attr >> 4) * 16 + pen];
        pri[o] |= bit;
      }
    }
  }

  render() {
    const out = this.frame, pri = this.pri, pal = this.palette;
    out.fill(pal[0x100]); pri.fill(0);
    this.playfield(this.bgRam, this.bgPix, this.bgCount, this.bgScroll, 768, 1);
    this.playfield(this.fgRam, this.fgPix, this.fgCount, this.fgScroll, 512, 2);
    // Text: 32x32 cells of 8x8.
    const tx = this.txRam;
    for (let y = 0; y < H; y++) {
      const ty = y + TOP, row = ty >> 3, py = ty & 7;
      for (let x = 0; x < W; x++) {
        const i = row * 32 + (x >> 3), attr = tx[i + 0x400];
        const pen = this.charPix[(tx[i] + ((attr & 3) << 8)) * 64 + py * 8 + (x & 7)];
        if (!pen) continue;
        out[y * W + x] = pal[256 + (attr >> 4) * 16 + pen];
        pri[y * W + x] |= 4;
      }
    }
    this.drawSprites();
  }

  // Sprites, first entry in front (drawn first; later ones fill in behind):
  // bank/flags, code, size, priority/color/position high bits, y, x.
  drawSprites() {
    const out = this.frame, pri = this.pri, pal = this.palette, spr = this.spriteRam, pix = this.spritePix;
    for (let offs = 0; offs < spr.length; offs += 8) {
      const bank = spr[offs];
      if (!(bank & 4)) continue;
      const flags = spr[offs + 3], hide = HIDDEN_BY[flags >> 6], color = (flags & 15) * 16;
      const sizeBits = spr[offs + 2] & 3, size = 1 << sizeBits;
      let code = spr[offs + 1] + ((bank & 0xF8) << 5);
      code &= ~((1 << (sizeBits * 2)) - 1);
      const xpos = spr[offs + 5] - ((flags & 0x10) << 4), ypos = spr[offs + 4] - ((flags & 0x20) << 3) - TOP;
      const flipX = bank & 1, flipY = bank & 2;
      for (let cy = 0; cy < size; cy++) {
        for (let cx = 0; cx < size; cx++) {
          const c = ((code + CELL[cy][cx]) % this.spriteCount) * 64;
          const bx = xpos + 8 * (flipX ? size - 1 - cx : cx), by = ypos + 8 * (flipY ? size - 1 - cy : cy);
          for (let y = 0; y < 8; y++) {
            const py = by + y;
            if (py < 0 || py >= H) continue;
            const row = (flipY ? 7 - y : y) * 8;
            for (let x = 0; x < 8; x++) {
              const px = bx + x;
              if (px < 0 || px >= W) continue;
              const o = py * W + px;
              if (pri[o] & 0x80) continue;            // a nearer sprite is already here
              const pen = pix[c + row + (flipX ? 7 - x : x)];
              if (!pen) continue;
              if (!(pri[o] & hide)) out[o] = pal[color + pen];
              pri[o] |= 0x80;
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- Silkworm

export class Silkworm extends Tecmo {
  constructor(roms) {
    super(roms);
    this.buttons = 2;
    this.button2 = 'Jump';
    this.startLabels = ['Heli', 'Jeep'];           // the start button picks the vehicle
  }
}
Silkworm.id = 'silkworm';
Silkworm.title = 'Silkworm';
Silkworm.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x03], ['3', 0x00], ['4', 0x01], ['5', 0x02]], default: 0x00 },
  { id: 'demoSounds', label: 'Demo sounds', options: [['On', 0x08], ['Off', 0x00]], default: 0x08 },
  { id: 'bonus', label: 'Bonus', options: [['50K 200K 500K', 0x00], ['100K 300K 800K', 0x01], ['50K 200K', 0x02], ['100K 300K', 0x03],
    ['50K', 0x04], ['100K', 0x05], ['200K', 0x06], ['None', 0x07]], default: 0x00 },
  { id: 'difficulty', label: 'Difficulty', options: [['0', 0x00], ['1', 0x01], ['2', 0x02], ['3', 0x03], ['4', 0x04], ['5', 0x05]], default: 0x00 },
];
