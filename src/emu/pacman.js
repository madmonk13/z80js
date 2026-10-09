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
    this.applySwitches(defaultSwitches(this.constructor.switches));
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
        case 6: this.coinLockout(v); break;
        // 2 unused, 3 flip screen (cocktail), 4-5 lamps, 7 coin counter
      }
    } else if (io < 0x60) this.wsg.write(io & 0x1F, v);
    else if (io < 0x70) this.spritePos[io & 0x0F] = v;
    // 50C0: watchdog
  }

  coinLockout() {}

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

// ---------------------------------------------------------------- Ms. Pac-Man

// Ms. Pac-Man (1981) is a Pac-Man board with an add-on board on top. The
// add-on's ROMs (u5, u6, u7) are stored with their data and address lines
// scrambled; once unscrambled they supply 3000-3FFF and 8000-9FFF, and
// 8-byte patches from 8000-81EF replace pieces of the original Pac-Man code.
// The board starts out as plain Pac-Man and switches over during start-up
// (the start-up code's write to 5006 is a convenient trigger).

// Data lines: which input bit feeds each output bit.
function unscrambleData(e) {
  return ((e & 0x80) >> 3) | ((e & 0x40) >> 3) | (e & 0x20) | ((e & 0x10) << 2) |
    ((e & 0x08) >> 1) | ((e & 0x04) >> 1) | ((e & 0x02) >> 1) | ((e & 0x01) << 7);
}
// Address lines for the 4K ROMs (u6, u7) and the 2K ROM (u5).
function unscrambleAddr4k(e) {
  return (e & 0x807) | ((e & 0x400) >> 7) | ((e & 0x200) >> 2) | ((e & 0x100) << 1) | ((e & 0x80) << 3) |
    ((e & 0x40) << 2) | ((e & 0x20) << 1) | ((e & 0x10) << 1) | ((e & 0x08) << 1);
}
function unscrambleAddr2k(e) {
  return (e & 0x807) | ((e & 0x400) >> 2) | ((e & 0x200) >> 2) | ((e & 0x100) >> 3) | ((e & 0x80) << 2) |
    ((e & 0x40) << 4) | ((e & 0x20) << 1) | ((e & 0x10) >> 1) | ((e & 0x08) << 1);
}
// Where each 8-byte patch from the add-on lands in the Pac-Man program:
// [address in 0000-2FFF, source in 8000-81FF].
const PATCHES = [
  [0x0410, 0x8008], [0x08E0, 0x81D8], [0x0A30, 0x8118], [0x0BD0, 0x80D8], [0x0C20, 0x8120], [0x0E58, 0x8168],
  [0x0EA8, 0x8198], [0x1000, 0x8020], [0x1008, 0x8010], [0x1288, 0x8098], [0x1348, 0x8048], [0x1688, 0x8088],
  [0x16B0, 0x8188], [0x16D8, 0x80C8], [0x16F8, 0x81C8], [0x19A8, 0x80A8], [0x19B8, 0x81A8], [0x2060, 0x8148],
  [0x2108, 0x8018], [0x21A0, 0x81A0], [0x2298, 0x80A0], [0x23E0, 0x80E8], [0x2418, 0x8000], [0x2448, 0x8058],
  [0x2470, 0x8140], [0x2488, 0x8080], [0x24B0, 0x8180], [0x24D8, 0x80C0], [0x24F8, 0x81C0], [0x2748, 0x8050],
  [0x2780, 0x8090], [0x27B8, 0x8190], [0x2800, 0x8028], [0x2B20, 0x8100], [0x2B30, 0x8110], [0x2BF0, 0x81D0],
  [0x2CC0, 0x80D0], [0x2CD8, 0x80E0], [0x2CF0, 0x81E0], [0x2D60, 0x8160],
];

export class MsPacMan extends PacMan {
  // roms: Pac-Man's plus u5 (2K), u6 and u7 (4K each), scrambled as dumped.
  constructor(roms) {
    super(roms);
    const img = new Uint8Array(0xC000);
    img.set(roms.main.subarray(0, 0x3000));                     // Pac-Man 0000-2FFF
    for (let i = 0; i < 0x1000; i++) {
      img[0x3000 + unscrambleAddr4k(i)] = unscrambleData(roms.u7[i]);
      img[0x9000 + unscrambleAddr4k(i)] = unscrambleData(roms.u6[i]);
    }
    for (let i = 0; i < 0x800; i++) img[0x8000 + unscrambleAddr2k(i)] = unscrambleData(roms.u5[i]);
    img.copyWithin(0x8800, 0x9800, 0xA000);                     // second half of u6 also appears at 8800
    img.set(roms.main.subarray(0x2000, 0x4000), 0xA000);
    for (const [to, from] of PATCHES) img.copyWithin(to, from, from + 8);
    this.aux = img;
  }

  reset() {
    super.reset();
    this.auxOn = false;
  }

  saveState() { return { ...super.saveState(), auxOn: this.auxOn }; }
  loadState(s) { super.loadState(s); this.auxOn = !!s.auxOn; }

  read(a) {
    if (this.auxOn && (a < 0x4000 || (a >= 0x8000 && a < 0xC000))) return this.aux[a];
    return super.read(a);
  }

  coinLockout(v) { if (v === 1) this.auxOn = true; }
}

MsPacMan.id = 'mspacman';
MsPacMan.title = 'Ms. Pac-Man';
MsPacMan.switches = PacMan.switches;

// ---------------------------------------------------------------- Jr. Pac-Man

// Jr. Pac-Man (1983): the Pac-Man board with more program ROM (8000-DFFF),
// twice the graphics in switchable banks, a playfield 54 tiles long that
// scrolls under fixed score columns, colors set per column of the maze, two
// palette and lookup banks, and tiles that can be drawn over the sprites.
//
// The program ROMs are encrypted by PALs that flip bits 0, 2 and 7 in runs;
// this is the XOR pattern from address 0 up, as [run length, XOR value].
const JR_XOR = [
  [0x00C1, 0x00], [0x0002, 0x80], [0x0004, 0x00], [0x0006, 0x80], [0x0003, 0x00], [0x0002, 0x80], [0x0009, 0x00], [0x0004, 0x80],
  [0x9968, 0x00], [0x0001, 0x80], [0x0002, 0x00], [0x0001, 0x80], [0x0009, 0x00], [0x0002, 0x80], [0x0009, 0x00], [0x0001, 0x80],
  [0x00AF, 0x00], [0x000E, 0x04], [0x0002, 0x00], [0x0004, 0x04], [0x001E, 0x00], [0x0001, 0x80], [0x0002, 0x00], [0x0001, 0x80],
  [0x0002, 0x00], [0x0002, 0x80], [0x0009, 0x00], [0x0002, 0x80], [0x0009, 0x00], [0x0002, 0x80], [0x0083, 0x00], [0x0001, 0x04],
  [0x0001, 0x01], [0x0001, 0x00], [0x0002, 0x05], [0x0001, 0x00], [0x0003, 0x04], [0x0003, 0x01], [0x0002, 0x00], [0x0001, 0x04],
  [0x0003, 0x01], [0x0003, 0x00], [0x0003, 0x04], [0x0001, 0x01], [0x002E, 0x00], [0x0078, 0x01], [0x0001, 0x04], [0x0001, 0x05],
  [0x0001, 0x00], [0x0001, 0x01], [0x0001, 0x04], [0x0002, 0x00], [0x0001, 0x01], [0x0001, 0x04], [0x0002, 0x00], [0x0001, 0x01],
  [0x0001, 0x04], [0x0002, 0x00], [0x0001, 0x01], [0x0001, 0x04], [0x0001, 0x05], [0x0001, 0x00], [0x0001, 0x01], [0x0001, 0x04],
  [0x0002, 0x00], [0x0001, 0x01], [0x0001, 0x04], [0x0002, 0x00], [0x0001, 0x01], [0x0001, 0x04], [0x0001, 0x05], [0x0001, 0x00],
  [0x01B0, 0x01], [0x0001, 0x00], [0x0002, 0x01], [0x00AD, 0x00], [0x0031, 0x01], [0x005C, 0x00], [0x0005, 0x01], [0x604E, 0x00],
];

const JR_STATE = ['charBank', 'spriteBank', 'paletteBank', 'lutBank', 'bgPriority', 'scroll'];

export class JrPacMan extends PacMan {
  // roms: { main (0000-DFFF image), tiles 8K, sprites 8K, palette 32, lut 256, wave 256 }
  constructor(roms) {
    const main = roms.main.slice();
    let a = 0;
    for (const [n, x] of JR_XOR) for (let i = 0; i < n && a < main.length; i++) main[a++] ^= x;
    super({ ...roms, main });
    this.tilePix = decodeTiles(roms.tiles, {
      count: 512, width: 8, height: 8, planes: [0, 4], xs: [64, 65, 66, 67, 0, 1, 2, 3], ys: run(0, 8, 8), size: 128,
    });
    this.spritePix = decodeTiles(roms.sprites, {
      count: 128, width: 16, height: 16, planes: [0, 4],
      xs: [...run(64, 4), ...run(128, 4), ...run(192, 4), ...run(0, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
  }

  reset() {
    super.reset();
    this.charBank = this.spriteBank = this.paletteBank = this.lutBank = this.bgPriority = this.scroll = 0;
  }
  saveState() { return { ...super.saveState(), ...capture(this, JR_STATE) }; }
  loadState(s) { super.loadState(s); apply(this, JR_STATE, s); }

  read(a) {
    if (a < 0x4000 || (a >= 0x8000 && a < 0xE000)) return this.roms.main[a];
    if (a < 0x5000) return this.ram[a - 0x4000];
    if (a < 0x5100) return [this.in0, this.in1, this.dsw1, 0xFF][(a >> 6) & 3];
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x4000 && a < 0x5000) { this.ram[a - 0x4000] = v; return; }
    switch (a) {
      case 0x5070: this.paletteBank = v & 1; return;
      case 0x5071: this.lutBank = v & 1; return;
      case 0x5073: this.bgPriority = v & 1; return;
      case 0x5074: this.charBank = v & 1; return;
      case 0x5075: this.spriteBank = v & 1; return;
      case 0x5080: this.scroll = v; return;
    }
    if (a >= 0x5000 && a < 0x5080) super.write(a, v);          // interrupt and sound enables, sound, sprite positions
  }

  // A color code (5 bits plus the two bank latches) and pen to a palette entry.
  colorOf(code, pen) {
    const e = this.lut[((code & 0x3F) * 4) + pen];
    return code & 0x40 ? 0x10 + e : e;
  }

  render() {
    const out = this.native, ram = this.ram, pal = this.palette;
    const banks = (this.lutBank << 5) | (this.paletteBank << 6);
    const tileAt = (x, y) => {                    // -> [code, color code] for a screen pixel
      const col = x >> 3;
      const ty = col >= 2 && col < 34 ? (y + this.scroll) % 432 : y;
      const row = (ty >> 3) + 2, c = col - 2;
      let offs;
      if ((c & 0x20) && (row & 0x20)) offs = 0;
      else if (c & 0x20) offs = row + (((c & 3) | 0x38) << 5);
      else offs = c + (row << 5);
      const colorAt = offs < 1792 ? offs & 0x1F : offs + 0x80;
      return [offs, (ram[colorAt] & 0x1F) | banks, ty & 7];
    };
    const tiles = (front) => {
      for (let y = 0; y < NATIVE_H; y++) {
        for (let x = 0; x < NATIVE_W; x += 8) {
          const [offs, color, py] = tileAt(x, y);
          const pix = (ram[offs] | (this.charBank << 8)) * 64 + py * 8;
          for (let i = 0; i < 8; i++) {
            const pen = this.tilePix[pix + i];
            if (!front || pen) out[y * NATIVE_W + x + i] = pal[this.colorOf(color, pen)];
          }
        }
      }
    };
    if (this.bgPriority) out.fill(pal[0]); else tiles(false);

    for (let n = 7; n >= 0; n--) {
      const code = ram[0xFF0 + n * 2], color = (ram[0xFF1 + n * 2] & 0x1F) | banks;
      const sx = 272 - this.spritePos[n * 2 + 1], sy = this.spritePos[n * 2] - 31 + (n <= 2 ? 1 : 0);
      this.drawJrSprite((code >> 2) | (this.spriteBank << 6), color, code & 1, code & 2, sx, sy);
    }
    if (this.bgPriority) tiles(true);
    rotate90(out, NATIVE_W, NATIVE_H, this.frame);
  }

  drawJrSprite(code, color, flipX, flipY, sx, sy) {
    const out = this.native, pix = code * 256;
    for (let y = 0; y < 16; y++) {
      const py = sy + y;
      if (py < 0 || py >= NATIVE_H) continue;
      const srcY = flipY ? 15 - y : y;
      for (let x = 0; x < 16; x++) {
        const px = sx + x;
        if (px < 16 || px >= 272) continue;
        const pen = this.spritePix[pix + srcY * 16 + (flipX ? 15 - x : x)];
        if (this.lut[(color & 0x3F) * 4 + pen]) out[py * NATIVE_W + px] = this.palette[this.colorOf(color, pen)];
      }
    }
  }
}
JrPacMan.id = 'jrpacman';
JrPacMan.title = 'Jr. Pac-Man';
JrPacMan.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x00], ['2', 0x04], ['3', 0x08], ['5', 0x0C]], default: 0x08 },
  { id: 'bonus', label: 'Bonus life', options: [['10K', 0x00], ['15K', 0x10], ['20K', 0x20], ['30K', 0x30]], default: 0x00 },
  { id: 'difficulty', label: 'Difficulty', options: [['Normal', 0x40], ['Hard', 0x00]], default: 0x40 },
];

// ---------------------------------------------------------------- Pac-Man board variants

const swapBits = (v, a, b) => (((v >> a) & 1) === ((v >> b) & 1) ? v : v ^ ((1 << a) | (1 << b)));

// Piranha (1981): a Pac-Man variant whose program ROMs have data lines 3 and
// 5 swapped, and graphics ROMs data lines 4 and 6 and address lines 0 and 2
// swapped. Its interrupt vector is also written as FA where the code needs 78.
export class Piranha extends PacMan {
  constructor(roms) {
    const main = roms.main.map((v) => swapBits(v, 3, 5));
    const gfx = (rom) => {
      const out = new Uint8Array(rom.length);
      for (let i = 0; i < rom.length; i++) out[i] = swapBits(rom[(i & ~7) | (((i >> 2) & 1) | (i & 2) | ((i & 1) << 2))], 4, 6);
      return out;
    };
    super({ ...roms, main, tiles: gfx(roms.tiles), sprites: gfx(roms.sprites) });
  }
  out(port, v) { super.out(port, v === 0xFA ? 0x78 : v); }
}
Piranha.id = 'piranha';
Piranha.title = 'Piranha';
Piranha.switches = PacMan.switches;

// Crush Roller (1981): Pac-Man hardware with a protection device. It answers
// reads in the switch areas (5080-50FF) depending on where the program is,
// and a few instructions are replaced in the instruction stream only (so the
// program's own ROM checksum still passes).
const CRUSH_PATCHES = [[0x0415, 0xC9], [0x1978, 0x18], [0x238E, 0xC9], [0x3AE5, 0xE6], [0x3AE7, 0x00], [0x3AE8, 0xC9],
  [0x3AED, 0x86], [0x3AEE, 0xC0], [0x3AEF, 0xB0]];

export class CrushRoller extends PacMan {
  constructor(roms) {
    super(roms);
    this.ops = roms.main.slice(0, 0x4000);
    for (const [a, v] of CRUSH_PATCHES) this.ops[a] = v;
    this.cpu.opRead = (a) => (a < 0x4000 ? this.ops[a] : this.read(a));
  }

  read(a) {
    a &= 0x7FFF;
    if (a >= 0x5080 && a < 0x5100) {
      const pc = this.cpu.opPc, off = a & 0x3F;
      if (a < 0x50C0) {
        if (pc === 0x1973 || pc === 0x2389) return this.dsw1 | 0x40;
        if (off === 1 || off === 4) return this.dsw1 | 0x40;
        if (off === 5) return this.dsw1 | 0xC0;
        return this.dsw1 & 0x3F;
      }
      if (pc === 0x040E) return 0x20;
      if (pc === 0x115E || pc === 0x3AE2) return 0x00;
      return off === 0x00 ? 0x1F : off === 0x09 ? 0x30 : off === 0x0C ? 0x00 : 0x20;
    }
    return super.read(a);
  }

  // IN0: stick, coin (cabinet switch upright). IN1: starts.
  setInputs(s) {
    this.in0 = 0xEF & ~((s.up ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.right ? 0x04 : 0) | (s.down ? 0x08 : 0) | (s.coin ? 0x20 : 0));
    this.in1 = 0x6F & ~((s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0));
  }
  // Switches: 1 coin 1 credit, lives, first pattern, teleport holes.
  applySwitches(v) { this.dsw1 = 0x01 | v.lives | 0x10 | v.teleport; }
}
CrushRoller.id = 'crush';
CrushRoller.title = 'Crush Roller';
CrushRoller.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x00], ['4', 0x04], ['5', 0x08], ['6', 0x0C]], default: 0x00 },
  { id: 'teleport', label: 'Teleport holes', options: [['On', 0x00], ['Off', 0x20]], default: 0x20 },
];
