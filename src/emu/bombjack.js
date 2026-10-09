// Tehkan Bomb Jack (1984): a Z80 at 4 MHz, a background picture of 16x16
// tiles picked from a map ROM, a layer of 8x8 characters, 16x16 and 32x32
// sprites, all 3 bits per pixel, with 128 colors in palette RAM; and a sound
// Z80 driving three AY-3-8910s. Both CPUs get an NMI each frame.
//
// 60 Hz; the visible picture is 256x224 on a vertical monitor.

import { Z80 } from './z80.js';
import { AY8910 } from './ay8910.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16;
const LINES = 262, VBLANK_LINE = 240, LINE_CYCLES = 4000000 / 60 / LINES, SOUND_LINE_CYCLES = 3072000 / 60 / LINES;
const SAMPLES_PER_LINE = 48000 / 60 / LINES;
const STATE = ['ram', 'palRam', 'background', 'nmiEnable', 'latch', 'cycleCarry', 'soundCarry', 'sampleCarry',
  'in0', 'in2', 'cpu', 'sndCpu', 'soundRam', 'sound'];

// 16x16 tiles (and sprites) are four 8x8 quarters: left half, then right.
const XS16 = [...run(0, 8), ...run(64, 8)], YS16 = [...run(0, 8, 8), ...run(128, 8, 8)];

export class BombJack {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.palRam.forEach((_, i) => { if (!(i & 1)) this.setColor(i >> 1); }); }

  // roms: { main (0000-7FFF, C000-DFFF), sound 8K, chars 12K, tiles 24K, sprites 24K, map 4K }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = 60;
    this.controls = 'eight-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x1880);         // 8000-8FFF work RAM, 9000-97FF video/color, 9800-987F sprites
    this.palRam = new Uint8Array(0x100);       // 9C00-9CFF: 128 colors, xxxxBBBB GGGGRRRR
    this.soundRam = new Uint8Array(0x400);
    this.palette = new Uint32Array(128).fill(0xFF000000);
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sndCpu = new Z80({
      read: (a) => this.soundRead(a), write: (a, v) => { if (a >= 0x4000 && a < 0x4400) this.soundRam[a - 0x4000] = v; },
      output: (p, v) => this.soundOut(p & 0xFF, v),
    });
    this.ay = [0, 1, 2].map(() => new AY8910(1500000, () => 0xFF, 1));
    this.sound = new SoundMix(this.ay, 0.5);

    const planes = (len) => [0, len * 8 / 3, len * 16 / 3];
    this.charPix = decodeTiles(roms.chars, { count: 512, width: 8, height: 8, planes: planes(roms.chars.length), xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    this.tilePix = decodeTiles(roms.tiles, { count: 256, width: 16, height: 16, planes: planes(roms.tiles.length), xs: XS16, ys: YS16, size: 256 });
    this.spritePix = decodeTiles(roms.sprites, { count: 128, width: 16, height: 16, planes: planes(roms.sprites.length), xs: XS16, ys: YS16, size: 256 });
    // 32x32 sprites: four 16x16 quarters, from 1000 in each plane.
    this.bigPix = decodeTiles(roms.sprites, {
      count: 32, width: 32, height: 32, planes: planes(roms.sprites.length), base: 0x1000 * 8,
      xs: [...XS16, ...XS16.map((x) => x + 256)], ys: [...YS16, ...YS16.map((y) => y + 512)], size: 1024,
    });
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.in0 = 0; this.in2 = 0xF0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.palRam.fill(0); this.soundRam.fill(0); this.palette.fill(0xFF000000);
    this.background = 0; this.nmiEnable = false; this.latch = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sndCpu.reset(); this.sound.reset();
  }

  setColor(n) {
    const lo = this.palRam[n * 2], hi = this.palRam[n * 2 + 1];
    this.palette[n] = rgba((lo & 15) * 17, (lo >> 4) * 17, (hi & 15) * 17);
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x8000) return this.roms.main[a];
    if (a < 0x9880) return this.ram[a - 0x8000];
    if (a >= 0xC000 && a < 0xE000) return this.roms.main[a - 0x4000];
    switch (a) {
      case 0xB000: return this.in0;
      case 0xB001: return 0;
      case 0xB002: return this.in2;
      case 0xB004: return this.dsw1;
      case 0xB005: return this.dsw2;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0x9880) { this.ram[a - 0x8000] = v; return; }
    if (a >= 0x9C00 && a < 0x9D00) { this.palRam[a - 0x9C00] = v; this.setColor((a - 0x9C00) >> 1); return; }
    switch (a) {
      case 0x9E00: this.background = v; break;
      case 0xB000: this.nmiEnable = !!(v & 1); break;
      case 0xB800: this.latch = v; break;
      // 9A00 sprite count for the video controller, B004 flip screen
    }
  }

  soundRead(a) {
    if (a < 0x2000) return this.roms.sound[a];
    if (a >= 0x4000 && a < 0x4400) return this.soundRam[a - 0x4000];
    if (a === 0x6000) { const v = this.latch; this.latch = 0; return v; }   // reading clears the command
    return 0xFF;
  }

  soundOut(p, v) {
    const chip = this.ay[p === 0x00 || p === 0x01 ? 0 : p === 0x10 || p === 0x11 ? 1 : p === 0x80 || p === 0x81 ? 2 : -1];
    if (!chip) return;
    if (p & 1) chip.write(v); else chip.select(v);
  }

  // ---------------------------------------------------------------- inputs

  // Active high. IN0: right, left, up, down, fire. IN2: coins, starts.
  setInputs(s) {
    this.in0 = (s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.up ? 0x04 : 0) | (s.down ? 0x08 : 0) | (s.fire ? 0x10 : 0);
    this.in2 = 0xF0 | (s.coin ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0);   // high bits idle high
  }
  // DSW1: 1 coin 1 credit, lives, upright, demo sounds. DSW2: bird speed, enemies, special coin.
  applySwitches(v) {
    this.dsw1 = v.lives | 0x40 | 0x80;
    this.dsw2 = v.birds | v.enemies;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) {
        this.render();
        if (this.nmiEnable) this.cpu.nmi();
        this.sndCpu.nmi();                       // the sound program's timer
      }
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.soundCarry += SOUND_LINE_CYCLES;
      this.soundCarry -= this.sndCpu.run(Math.floor(this.soundCarry));
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, ram = this.ram, pal = this.palette, map = this.roms.map;

    // Background: picture n (0-7) of the map ROM, 16x16 tiles; bit 4 turns it on.
    const bg = this.background, base = (bg & 7) * 0x200;
    for (let y = 0; y < H; y++) {
      const ty = y + TOP;
      for (let x = 0; x < W; x++) {
        const i = base + (ty >> 4) * 16 + (x >> 4), attr = map[i + 0x100];
        const code = bg & 0x10 ? map[i] : 0, py = attr & 0x80 ? 15 - (ty & 15) : ty & 15;
        out[y * W + x] = pal[(attr & 15) * 8 + this.tilePix[code * 256 + py * 16 + (x & 15)]];
      }
    }

    // Characters: code bit 8 and color in the color byte; pen 0 see-through.
    for (let row = 2; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const i = row * 32 + col, c = ram[0x1400 + i];
        const src = (ram[0x1000 + i] + ((c & 0x10) << 4)) * 64, color = (c & 15) * 8;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y - TOP) * W + col * 8;
          for (let x = 0; x < 8; x++, o++) {
            const pen = this.charPix[src + y * 8 + x];
            if (pen) out[o] = pal[color + pen];
          }
        }
      }
    }

    // Sprites, last to first: size/code, flips/color, y, x.
    for (let offs = 0x185C; offs >= 0x1820; offs -= 4) {
      const b0 = ram[offs], b1 = ram[offs + 1], big = b0 & 0x80, size = big ? 32 : 16;
      const pix = big ? this.bigPix : this.spritePix, src = (b0 & 0x7F) * size * size, color = (b1 & 15) * 8;
      const flipX = b1 & 0x40, flipY = b1 & 0x80;
      const sx = ram[offs + 3], sy = (big ? 225 : 241) - ram[offs + 2] - TOP;
      for (let y = 0; y < size; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        const row = src + (flipY ? size - 1 - y : y) * size;
        for (let x = 0; x < size; x++) {
          const px = sx + x;
          if (px < 0 || px >= W) continue;
          const pen = pix[row + (flipX ? size - 1 - x : x)];
          if (pen) out[py * W + px] = pal[color + pen];
        }
      }
    }

    rotate90(out, W, H, this.frame);
  }
}

BombJack.id = 'bombjack';
BombJack.title = 'Bomb Jack';
BombJack.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x30], ['3', 0x00], ['4', 0x10], ['5', 0x20]], default: 0x00 },
  { id: 'birds', label: 'Bird speed', options: [['Easy', 0x00], ['Medium', 0x08], ['Hard', 0x10], ['Hardest', 0x18]], default: 0x00 },
  { id: 'enemies', label: 'Enemies', options: [['Easy', 0x20], ['Medium', 0x00], ['Hard', 0x40], ['Hardest', 0x60]], default: 0x00 },
];
