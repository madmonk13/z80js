// Namco Galaxian (1979) board: one Z80, a 32x32 tile layer whose columns each
// scroll and take their own color, 8 sprites built from the same graphics,
// 8 bullets drawn by hardware, the star generator and an analog sound board.
// 3.072 MHz, 264 lines of 192 cycles, 60.606 Hz; the picture is 256x224 on a
// vertical monitor.

import { Z80 } from './z80.js';
import { GalaxianSound } from './galaxian-sound.js';
import { decodeTiles, promPalette, rgba, rotate90, run } from './video.js';
import { defaultSwitches } from './pacman.js';

const NATIVE_W = 256, NATIVE_H = 224;
const TOP = 16;                              // first visible line of the 256-line raster
const LINES = 264, LINE_CYCLES = 192, VBLANK_LINE = 240;
const SHELL = rgba(0xEF, 0xEF, 0xEF), MISSILE = rgba(0xEF, 0xEF, 0x00);

// The star generator: a 17-bit shift register clocked once per pixel over a
// 512-wide, 256-line field. A star shows where the register's low byte is all
// ones (and its top bit clear), in the color given by the next six bits.
// Computed once; each frame the field is offset by a scroll counter.
function generateStars() {
  const stars = [];
  let gen = 0;
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 512; x++) {
      const bit = ((~gen >> 16) & 1) ^ ((gen >> 4) & 1);
      gen = ((gen << 1) | bit) & 0x1FFFF;
      if (((~gen >> 16) & 1) && (gen & 0xFF) === 0xFF) {
        const color = ~(gen >> 8) & 0x3F;
        if (color) stars.push(x, y, color);
      }
    }
  }
  return stars;
}
const STARS = generateStars();
const STAR_LEVEL = [0x00, 0x88, 0xCC, 0xFF];
const STAR_COLORS = Array.from({ length: 64 }, (_, i) => rgba(STAR_LEVEL[i & 3], STAR_LEVEL[(i >> 2) & 3], STAR_LEVEL[(i >> 4) & 3]));

export class Galaxian {
  // roms: { main (up to 16K), gfx 4K (two 2K bitplanes), palette 32 }
  constructor(roms) {
    this.width = NATIVE_H;
    this.height = NATIVE_W;
    this.refresh = 60.606;
    this.controls = 'two-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x800);          // 4000-47FF
    this.vram = new Uint8Array(0x400);         // 5000-53FF
    this.obj = new Uint8Array(0x100);          // 5800-58FF: column attributes, sprites, bullets
    this.sound = new GalaxianSound();
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.in0 = 0; this.in1 = 0;
    this.applySwitches(defaultSwitches(Galaxian.switches));
    this.frame = new Uint32Array(this.width * this.height);
    this.native = new Uint32Array(NATIVE_W * 256);

    // Tiles and sprites share one ROM pair: plane 0 in the first half, plane 1
    // in the second. A sprite is four tiles: 16x16.
    const half = roms.gfx.length * 4;           // bits per plane
    this.tilePix = decodeTiles(roms.gfx, {
      count: 256, width: 8, height: 8, planes: [0, half], xs: run(0, 8), ys: run(0, 8, 8), size: 64,
    });
    this.spritePix = decodeTiles(roms.gfx, {
      count: 64, width: 16, height: 16, planes: [0, half],
      xs: [...run(0, 8), ...run(64, 8)], ys: [...run(0, 8, 8), ...run(128, 8, 8)], size: 256,
    });
    this.palette = promPalette(roms.palette, 32, [0x4F, 0xA8]);
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.obj.fill(0);
    this.cpu.reset();
    this.nmiEnable = false;
    this.starsOn = false;
    this.starScroll = 0;
    this.sound.reset();
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x4000) return a < this.roms.main.length ? this.roms.main[a] : 0;
    if (a < 0x4800) return this.ram[a - 0x4000];
    if (a >= 0x5000 && a < 0x5800) return this.vram[a & 0x3FF];
    if (a >= 0x5800 && a < 0x5900) return this.obj[a & 0xFF];
    if (a === 0x6000) return this.in0;
    if (a === 0x6800) return this.in1;
    if (a === 0x7000) return this.dsw;
    return 0;
  }

  write(a, v) {
    if (a < 0x4000) return;
    if (a < 0x4800) { this.ram[a - 0x4000] = v; return; }
    if (a >= 0x5000 && a < 0x5400) { this.vram[a & 0x3FF] = v; return; }
    if (a >= 0x5800 && a < 0x5900) { this.obj[a & 0xFF] = v; return; }
    const snd = this.sound;
    switch (a) {
      // 6000-6003: lamps, coin lockout, coin counter
      case 0x6004: case 0x6005: case 0x6006: case 0x6007: snd.write('lfo' + (a & 3), v); return;
      case 0x6800: case 0x6801: case 0x6802: snd.write('hum' + (a & 3), v); return;
      case 0x6803: snd.write('noise', v); return;
      case 0x6805: snd.write('shoot', v); return;
      case 0x6806: snd.write('vol0', v); return;
      case 0x6807: snd.write('vol1', v); return;
      case 0x7001: this.nmiEnable = !!(v & 1); return;
      case 0x7004: this.starsOn = !!(v & 1); if (!this.starsOn) this.starScroll = 0; return;
      // 7006/7007 flip screen (cocktail)
      case 0x7800: snd.write('pitch', v); return;
    }
  }

  // ---------------------------------------------------------------- inputs

  // IN0: coin 1, coin 2, left, right, fire (active high). IN1: start 1,
  // start 2, player 2 controls; bits 6-7 are coinage (00 = 1 coin 1 credit).
  setInputs(s) {
    this.in0 = (s.coin ? 0x01 : 0) | (s.left ? 0x04 : 0) | (s.right ? 0x08 : 0) | (s.fire ? 0x10 : 0);
    this.in1 = (s.start1 ? 0x01 : 0) | (s.start2 ? 0x02 : 0);
  }

  applySwitches(v) {
    this.dsw = v.bonus | v.lives;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) {
        if (this.nmiEnable) this.cpu.nmi();
        this.render();
        if (this.starsOn) this.starScroll = (this.starScroll + 1) & 0x1FFFF;
      }
      this.cpu.run(LINE_CYCLES);
      this.sound.line();
    }
  }

  render() {
    const out = this.native, obj = this.obj, pal = this.palette;
    out.fill(0xFF000000);

    if (this.starsOn) {
      for (let i = 0; i < STARS.length; i += 3) {
        const sx = STARS[i], sy = STARS[i + 1];
        const x = ((sx + this.starScroll) & 0x1FF) >> 1;
        const y = (sy + ((this.starScroll + sx) >> 9)) & 0xFF;
        // The circuit only lets alternate stars through, in a checkerboard.
        if (((y & 1) ^ ((x >> 3) & 1)) && y >= TOP && y < TOP + NATIVE_H) out[y * NATIVE_W + x] = STAR_COLORS[STARS[i + 2]];
      }
    }

    // Tiles: each column scrolls vertically and has its own color.
    for (let col = 0; col < 32; col++) {
      const scroll = obj[col * 2], color = (obj[col * 2 + 1] & 7) * 4;
      for (let y = TOP; y < TOP + NATIVE_H; y++) {
        const ty = (y + scroll) & 0xFF;
        const pix = this.vram[(ty >> 3) * 32 + col] * 64 + (ty & 7) * 8;
        let o = y * NATIVE_W + col * 8;
        for (let x = 0; x < 8; x++, o++) {
          const pen = this.tilePix[pix + x];
          if (pen) out[o] = pal[color + pen];
        }
      }
    }

    // Bullets: 4-pixel dashes; the last one is the player's yellow missile.
    for (let b = 0; b < 8; b++) {
      const y = 255 - obj[0x61 + b * 4], x = 255 - obj[0x63 + b * 4];
      if (y < TOP || y >= TOP + NATIVE_H) continue;
      for (let i = 1; i <= 4; i++) if (x - i >= 0) out[y * NATIVE_W + x - i] = b === 7 ? MISSILE : SHELL;
    }

    // Sprites, last to first so sprite 0 ends up on top.
    for (let s = 7; s >= 0; s--) {
      const o = 0x40 + s * 4;
      const attr = obj[o + 1], color = (obj[o + 2] & 7) * 4;
      const sx = (obj[o + 3] + 1) & 0xFF;
      const sy = ((240 - obj[o]) & 0xFF) + (s < 3 ? 1 : 0);
      this.drawSprite(attr & 0x3F, color, attr & 0x40, attr & 0x80, sx, sy);
    }

    // Crop to the visible lines and rotate for the vertical monitor.
    rotate90(out.subarray(TOP * NATIVE_W, (TOP + NATIVE_H) * NATIVE_W), NATIVE_W, NATIVE_H, this.frame);
  }

  drawSprite(code, color, flipX, flipY, sx, sy) {
    const out = this.native, pix = code * 256;
    for (let y = 0; y < 16; y++) {
      const py = sy + y;
      if (py < TOP || py >= TOP + NATIVE_H) continue;
      const srcY = flipY ? 15 - y : y;
      for (let x = 0; x < 16; x++) {
        const px = sx + x;
        if (px < 17 || px >= NATIVE_W) continue;
        const pen = this.spritePix[pix + srcY * 16 + (flipX ? 15 - x : x)];
        if (pen) out[py * NATIVE_W + px] = this.palette[color + pen];
      }
    }
  }
}

Galaxian.id = 'galaxian';
Galaxian.title = 'Galaxian';
Galaxian.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x00], ['3', 0x04]], default: 0x04 },
  { id: 'bonus', label: 'Bonus life', options: [['7K', 0x00], ['10K', 0x01], ['12K', 0x02], ['20K', 0x03]], default: 0x00 },
];
