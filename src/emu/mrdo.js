// Universal Mr. Do! (1982): one Z80 at 4 MHz, two 32x32 tile layers (the
// background one scrolls), 64 16x16 sprites, and two SN76489 sound chips.
// A protection check reads back the ROM byte at the address in HL.
//
// 262 lines of 249.6 CPU cycles (20 MHz / 4 / 312 per line), 61.17 Hz; the
// visible picture is 240x192 on a vertical monitor mounted counter-clockwise.

import { Z80 } from './z80.js';
import { SN76489 } from './sn76489.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, rotate270, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const NATIVE_W = 240, NATIVE_H = 192, LEFT = 8, TOP = 32;   // visible window of the 256x256 raster
const LINES = 262, LINE_CYCLES = 4000000 / (5000000 / 312);  // 249.6
const VBLANK_LINE = 224;
const SAMPLES_PER_LINE = 48000 / (5000000 / 312);           // about 3

const STATE = ['ram', 'work', 'sprites', 'scrollX', 'scrollY', 'cycleCarry', 'sampleCarry', 'in0', 'in1', 'cpu', 'sound'];

// The palette: each of red, green and blue gets 2 bits from each of two PROMs
// through 150/120 and 100/75 ohm resistors and a diode into a 200 ohm load.
function palette(hi, lo) {
  const R = [150, 120, 100, 75], PULL = 200, DIODE = 0.2;
  const volts = (bits) => {
    let g = 0;
    for (let k = 0; k < 4; k++) if (bits & (1 << k)) g += 1 / R[k];
    return g ? PULL / (PULL + 1 / g) - DIODE : 0;
  };
  const level = Array.from({ length: 16 }, (_, b) => Math.round((255 * volts(b)) / volts(15)));
  return Uint32Array.from({ length: 256 }, (_, i) => {
    const a = lo[((i >> 3) & 0x1C) | (i & 3)], b = hi[(i & 0x1C) | (i & 3)];
    const c = (sh) => level[((a >> sh) & 3) | (((b >> sh) & 3) << 2)];
    return rgba(c(0), c(2), c(4));
  });
}

export class MrDo {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 32K, fg 8K, bg 8K, sprites 8K, palHi 32, palLo 32, spriteLut 32 }
  constructor(roms) {
    this.width = NATIVE_H;
    this.height = NATIVE_W;
    this.refresh = 5000000 / 312 / LINES;
    this.controls = 'four-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x1000);         // 8000-8FFF: background then foreground (attributes, codes)
    this.work = new Uint8Array(0x1000);        // E000-EFFF
    this.sprites = new Uint8Array(0x100);      // 9000-90FF
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    // The vblank interrupt is held until the CPU takes it.
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.sn = [new SN76489(4000000), new SN76489(4000000)];
    this.sound = new SoundMix(this.sn, 1.2);
    this.frame = new Uint32Array(this.width * this.height);
    this.native = new Uint32Array(NATIVE_W * NATIVE_H);

    const chars = (rom) => decodeTiles(rom, {
      count: 512, width: 8, height: 8, planes: [0, 512 * 64], xs: run(7, 8, -1), ys: run(0, 8, 8), size: 64,
    });
    this.fgPix = chars(roms.fg);
    this.bgPix = chars(roms.bg);
    this.spritePix = decodeTiles(roms.sprites, {
      count: 128, width: 16, height: 16, planes: [4, 0],
      xs: [3, 2, 1, 0, 11, 10, 9, 8, 19, 18, 17, 16, 27, 26, 25, 24], ys: run(0, 16, 32), size: 512,
    });
    this.palette = palette(roms.palHi, roms.palLo);
    // Sprite colors 0-7 take the low nibble of the lookup PROM, 8-15 the high one.
    this.spriteLut = Uint8Array.from({ length: 64 }, (_, i) => {
      const bits = i < 32 ? roms.spriteLut[i] & 0x0F : roms.spriteLut[i & 0x1F] >> 4;
      return bits + ((bits & 0x0C) << 3);
    });
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.work.fill(0); this.sprites.fill(0);
    this.cpu.reset();
    this.sound.reset();
    this.scrollX = this.scrollY = 0;
    this.cycleCarry = this.sampleCarry = 0;
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x8000) return this.roms.main[a];
    if (a < 0x9000) return this.ram[a - 0x8000];
    if (a >= 0xE000 && a < 0xF000) return this.work[a - 0xE000];
    switch (a) {
      case 0x9803: return this.roms.main[this.cpu.hl & 0x7FFF];   // protection: the byte HL points at
      case 0xA000: return this.in0;
      case 0xA001: return this.in1;
      case 0xA002: return this.dsw0;
      case 0xA003: return this.dsw1;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0x9000) { this.ram[a - 0x8000] = v; return; }
    if (a >= 0x9000 && a < 0x9100) { this.sprites[a - 0x9000] = v; return; }
    if (a >= 0xE000 && a < 0xF000) { this.work[a - 0xE000] = v; return; }
    if (a >= 0xF000) { if (a < 0xF800) this.scrollX = v; else this.scrollY = v; return; }
    if (a === 0x9801) this.sn[0].write(v);
    else if (a === 0x9802) this.sn[1].write(v);
    // 9800 flip screen: upright only.
  }

  // ---------------------------------------------------------------- inputs

  // Active low. IN0: left, down, right, up, fire, start 1, start 2. IN1: coins.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.left ? 0x01 : 0) | (s.down ? 0x02 : 0) | (s.right ? 0x04 : 0) | (s.up ? 0x08 : 0)
      | (s.fire ? 0x10 : 0) | (s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0));
    this.in1 = 0xFF & ~(s.coin ? 0x40 : 0);
  }

  // DSW0: difficulty, rack test off, special/extra, upright, lives.
  // DSW1: 1 coin 1 credit for both slots.
  applySwitches(v) {
    this.dsw0 = v.difficulty | 0x04 | v.special | v.extra | v.lives;
    this.dsw1 = 0xFF;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) { this.render(); this.cpu.irq = true; }
      this.cycleCarry += LINE_CYCLES;
      const n = Math.floor(this.cycleCarry);
      this.cycleCarry -= n;
      this.cpu.run(n);
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, ram = this.ram, pal = this.palette;
    const layer = (base, pix, sx, sy) => {
      for (let y = 0; y < NATIVE_H; y++) {
        const ty = (y + TOP + sy) & 0xFF;
        for (let x = 0; x < NATIVE_W; x++) {
          const tx = (x + LEFT + sx) & 0xFF;
          const i = (ty >> 3) * 32 + (tx >> 3), attr = ram[base + i];
          const pen = pix[(ram[base + 0x400 + i] | ((attr & 0x80) << 1)) * 64 + (ty & 7) * 8 + (tx & 7)];
          // Pen 0 is see-through unless the tile is marked solid (bit 6).
          if (pen || (attr & 0x40)) out[y * NATIVE_W + x] = pal[(attr & 0x3F) * 4 + pen];
        }
      }
    };
    out.fill(pal[0]);
    layer(0x000, this.bgPix, this.scrollX, this.scrollY);
    layer(0x800, this.fgPix, 0, 0);

    // Sprites: 4 bytes each (code, y, attributes, x); the first is on top.
    const spr = this.sprites;
    for (let offs = 0xFC; offs >= 0; offs -= 4) {
      if (!spr[offs + 1]) continue;
      const code = spr[offs], attr = spr[offs + 2], color = (attr & 0x0F) * 4;
      const flipX = attr & 0x10, flipY = attr & 0x20;
      const sx = spr[offs + 3] - LEFT, sy = 256 - spr[offs + 1] - TOP;
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= NATIVE_H) continue;
        const src = code * 256 + (flipY ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= NATIVE_W) continue;
          const pen = this.spritePix[src + (flipX ? 15 - x : x)];
          if (pen) out[py * NATIVE_W + px] = pal[this.spriteLut[color + pen]];
        }
      }
    }

    rotate270(out, NATIVE_W, NATIVE_H, this.frame);
  }
}

MrDo.id = 'mrdo';
MrDo.title = 'Mr. Do!';
MrDo.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x00], ['3', 0xC0], ['4', 0x80], ['5', 0x40]], default: 0xC0 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x03], ['Med', 0x02], ['Hard', 0x01], ['Hardest', 0x00]], default: 0x03 },
  { id: 'special', label: 'Special', options: [['Easy', 0x08], ['Hard', 0x00]], default: 0x08 },
  { id: 'extra', label: 'Extra', options: [['Easy', 0x10], ['Hard', 0x00]], default: 0x10 },
];
