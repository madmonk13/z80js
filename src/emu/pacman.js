// Namco Pac-Man (1980) board: one Z80, a 36x28 tile layer, 8 sprites and the
// 3-voice Namco waveform sound generator. The same timing as Galaga: 3.072 MHz,
// 264 lines of 192 cycles, 60.606 Hz, and a 288x224 picture on a vertical
// monitor.

import { Z80 } from './z80.js';
import { WSG } from './wsg.js';
import { decodeTiles, promPalette, rotate90, run } from './video.js';
import { capture, apply } from './state.js';

const NATIVE_W = 288, NATIVE_H = 224;
const LINES = 264, LINE_CYCLES = 192, VBLANK_LINE = 224;

const PACMAN_STATE = ['ram', 'spritePos', 'irqEnable', 'in0', 'in1', 'cpu', 'wsg'];

export class PacMan {
  // Save states: everything that changes while running (not ROM-derived data).
  saveState() { return capture(this, PACMAN_STATE); }
  loadState(s) { apply(this, PACMAN_STATE, s); }

  // roms: { main 16K, tiles 4K, sprites 4K, palette 32, lut 256, wave 256 }
  constructor(roms) {
    this.width = NATIVE_H;           // as displayed (rotated)
    this.height = NATIVE_W;
    this.refresh = 60.606;
    this.controls = 'four-way';
    this.buttons = 0;                // no fire button
    this.roms = roms;
    this.ram = new Uint8Array(0x1000);           // 4000-4FFF: tiles, colors, work RAM, sprite codes
    this.spritePos = new Uint8Array(16);         // 5060-506F
    this.wsg = new WSG(roms.wave);
    this.sound = this.wsg;
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v), output: (port, v) => this.out(port, v) });
    // The vblank interrupt is held until the CPU takes it.
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.in0 = 0xFF;
    this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(PacMan.switches));
    this.frame = new Uint32Array(this.width * this.height);
    this.native = new Uint32Array(NATIVE_W * NATIVE_H);

    // Tiles: 256 of 8x8, 2 bits per pixel, planes at bits 0 and 4 of each byte.
    this.tilePix = decodeTiles(roms.tiles, {
      count: 256, width: 8, height: 8, planes: [0, 4],
      xs: [64, 65, 66, 67, 0, 1, 2, 3], ys: run(0, 8, 8), size: 128,
    });
    // Sprites: 64 of 16x16 in the same packing.
    this.spritePix = decodeTiles(roms.sprites, {
      count: 64, width: 16, height: 16, planes: [0, 4],
      xs: [...run(64, 4), ...run(128, 4), ...run(192, 4), ...run(0, 4)],
      ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    this.palette = promPalette(roms.palette, 32);
    this.lut = Uint8Array.from(roms.lut, (v) => v & 0x0F);   // color code x pen -> palette entry
    this.reset();
  }

  reset() {
    this.ram.fill(0);
    this.spritePos.fill(0);
    this.cpu.reset();
    this.irqEnable = false;
    this.wsg.reset();
    this.wsg.enabled = false;
  }

  // ---------------------------------------------------------------- bus
  // A15 isn't connected, and 6000-7FFF mirror 4000-5FFF.

  read(a) {
    a &= 0x7FFF;
    if (a < 0x4000) return this.roms.main[a];
    a &= 0x5FFF;
    if (a < 0x4800) return this.ram[a - 0x4000];
    if (a < 0x4C00) return 0xBF;                       // unconnected
    if (a < 0x5000) return this.ram[a - 0x4000];
    switch (a & 0xC0) {
      case 0x00: return this.in0;
      case 0x40: return this.in1;
      case 0x80: return this.dsw1;
      default: return 0xFF;
    }
  }

  write(a, v) {
    a &= 0x7FFF;
    if (a < 0x4000) return;
    a &= 0x5FFF;
    if (a < 0x5000) { if (a < 0x4800 || a >= 0x4C00) this.ram[a - 0x4000] = v; return; }
    const io = a & 0xFF;
    if (io < 0x40) {
      switch (io & 7) {
        case 0: this.irqEnable = !!(v & 1); if (!this.irqEnable) this.cpu.irq = false; break;
        case 1: this.wsg.enabled = !!(v & 1); break;
        // 2 unused, 3 flip screen (cocktail), 4-5 lamps, 6 coin lockout, 7 coin counter
      }
    } else if (io < 0x60) this.wsg.write(io & 0x1F, v);
    else if (io < 0x70) this.spritePos[io & 0x0F] = v;
    // 50C0: watchdog
  }

  // OUT (0),A sets the interrupt vector (the CPU runs in IM 2).
  out(port, v) {
    if ((port & 0xFF) === 0) { this.cpu.irqVector = v; this.cpu.irq = false; }
  }

  // ---------------------------------------------------------------- inputs

  // IN0: up, left, right, down, rack test, coin 1, coin 2, service (active low).
  // IN1: player 2 stick, test, start 1, start 2, cabinet (1 = upright).
  setInputs(s) {
    this.in0 = 0xFF & ~((s.up ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.right ? 0x04 : 0) | (s.down ? 0x08 : 0) | (s.coin ? 0x20 : 0));
    this.in1 = 0xFF & ~((s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0));
  }

  // DIP switches: coinage stays 1 coin 1 credit.
  applySwitches(v) {
    this.dsw1 = 0x01 | v.lives | v.bonus | v.difficulty | 0x80;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const cpu = this.cpu;
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) {
        if (this.irqEnable) cpu.irq = true;
        this.render();
      }
      cpu.run(LINE_CYCLES);
      this.wsg.line(false);
    }
  }

  render() {
    const out = this.native, ram = this.ram, pal = this.palette, lut = this.lut;

    // Tiles: 36x28, the playfield in 32 columns plus 2 on each side (score, lives).
    for (let row = 0; row < 28; row++) {
      for (let col = 0; col < 36; col++) {
        const r = row + 2, c = col - 2;
        const offs = (c & 0x20) ? r + ((c & 0x1F) << 5) : c + (r << 5);
        const pix = ram[offs] * 64, color = (ram[0x400 + offs] & 0x1F) * 4;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y) * NATIVE_W + col * 8;
          for (let x = 0; x < 8; x++) out[o++] = pal[lut[color + this.tilePix[pix + y * 8 + x]]];
        }
      }
    }

    // Sprites: drawn 7 down to 0 so lower numbers are on top. The first three
    // sit one pixel lower on the real board.
    for (let n = 7; n >= 0; n--) {
      const code = ram[0xFF0 + n * 2], color = (ram[0xFF1 + n * 2] & 0x1F) * 4;
      const sx = 272 - this.spritePos[n * 2 + 1], sy = this.spritePos[n * 2] - 31 + (n <= 2 ? 1 : 0);
      this.drawSprite(code >> 2, color, code & 1, code & 2, sx, sy);
    }

    rotate90(out, NATIVE_W, NATIVE_H, this.frame);
  }

  drawSprite(code, color, flipX, flipY, sx, sy) {
    const out = this.native, pix = code * 256;
    for (let y = 0; y < 16; y++) {
      const py = sy + y;
      if (py < 0 || py >= NATIVE_H) continue;
      const srcY = flipY ? 15 - y : y;
      for (let x = 0; x < 16; x++) {
        const px = sx + x;
        if (px < 16 || px >= 272) continue;          // sprites stop at the playfield edges
        const entry = this.lut[color + this.spritePix[pix + srcY * 16 + (flipX ? 15 - x : x)]];
        if (entry) out[py * NATIVE_W + px] = this.palette[entry];   // palette entry 0 is transparent
      }
    }
  }
}

PacMan.id = 'pacman';
PacMan.title = 'Pac-Man';
PacMan.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x00], ['2', 0x04], ['3', 0x08], ['5', 0x0C]], default: 0x08 },
  { id: 'bonus', label: 'Bonus life', options: [['10K', 0x00], ['15K', 0x10], ['20K', 0x20], ['None', 0x30]], default: 0x00 },
  { id: 'difficulty', label: 'Difficulty', options: [['Normal', 0x40], ['Hard', 0x00]], default: 0x40 },
];

export function defaultSwitches(list) {
  return Object.fromEntries(list.map((s) => [s.id, s.default]));
}
