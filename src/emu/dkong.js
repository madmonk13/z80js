// Nintendo Donkey Kong (1981) board: a Z80 running the game, an 8035 playing
// the music through a DAC, a 32x32 tile layer colored per 4-row block, up to
// 96 sprites, and analog sound effects. Same raster as Galaxian: 3.072 MHz,
// 264 lines of 192 cycles, 60.606 Hz, a 256x224 picture on a vertical monitor.

import { Z80 } from './z80.js';
import { I8035 } from './i8035.js';
import { DKongSound } from './dkong-sound.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const NATIVE_W = 256, NATIVE_H = 224, TOP = 16;
const LINES = 264, LINE_CYCLES = 192, VBLANK_LINE = 240;
const SOUND_CYCLES = [8, 8, 9];                 // the 8035's 25 cycles per line, in thirds

const DKONG_STATE = ['ram', 'vram', 'nmiEnable', 'spriteBank', 'paletteBank', 'tileBank', 'latch', 'page', 'mcuStatus', 'p1In', 'p2In', 't', 'in0', 'in1', 'in2', 'cpu', 'snd', 'sound'];

export class DonkeyKong {
  // Save states: everything that changes while running (not ROM-derived data).
  saveState() { return capture(this, DKONG_STATE); }
  loadState(s) { apply(this, DKONG_STATE, s); }

  // roms: { main 16K, sound 4K, tiles 4K (two 2K bitplanes), sprites 8K, palLow, palHigh, colors }
  constructor(roms) {
    this.width = NATIVE_H;
    this.height = NATIVE_W;
    this.refresh = 60.606;
    this.controls = 'four-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x1400);           // 6000-73FF (sprites at 6900/6B00)
    this.vram = new Uint8Array(0x400);           // 7400-77FF
    this.sound = new DKongSound();
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.snd = new I8035({
      rom: roms.sound,
      read: (port) => this.soundBusRead(port),
      portIn: (n) => (n === 1 ? this.p1In : this.p2In),
      portOut: (n, v) => this.soundPortWrite(n, v),
      test: (n) => this.t[n],
    });
    this.in0 = 0; this.in1 = 0; this.in2 = 0;
    this.applySwitches(defaultSwitches(DonkeyKong.switches));
    this.frame = new Uint32Array(this.width * this.height);
    this.native = new Uint32Array(NATIVE_W * 256);

    // Tiles: 256 of 8x8, planes in the two 2K halves (second half = high bit).
    const tileHalf = roms.tiles.length * 4;
    this.tilePix = decodeTiles(roms.tiles, {
      count: roms.tiles.length / 16, width: 8, height: 8, planes: [tileHalf, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64,
    });
    // Sprites: 128 of 16x16; left and right halves in separate ROMs, planes in
    // the two halves of the set.
    const quarter = roms.sprites.length * 2;     // bits in one 2K ROM
    this.spritePix = decodeTiles(roms.sprites, {
      count: 128, width: 16, height: 16, planes: [quarter * 2, 0],
      xs: [...run(0, 8), ...run(quarter, 8)], ys: run(0, 16, 8), size: 128,
    });

    // Palette: two 256x4 PROMs feeding inverting open-collector outputs. Pen 0
    // of every color is the black background.
    this.palette = new Uint32Array(256);
    const lo = roms.palLow, hi = roms.palHigh;
    for (let i = 0; i < 256; i++) {
      if ((i & 3) === 0) { this.palette[i] = rgba(0, 0, 0); continue; }
      const bit = (v, n) => (v >> n) & 1;
      const r = 255 - (0x21 * bit(hi[i], 1) + 0x47 * bit(hi[i], 2) + 0x97 * bit(hi[i], 3));
      const g = 255 - (0x21 * bit(lo[i], 2) + 0x47 * bit(lo[i], 3) + 0x97 * bit(hi[i], 0));
      const b = 255 - (0x55 * bit(lo[i], 0) + 0xAA * bit(lo[i], 1));
      this.palette[i] = rgba(r, g, b);
    }
    this.colorCodes = roms.colors;               // tile color per column and 4-row block
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0);
    this.cpu.reset();
    this.snd.reset();
    this.sound.reset();
    this.nmiEnable = false;
    this.spriteBank = 0;
    this.tileBank = 0;            // Donkey Kong Jr. has a second set of 256 tiles
    this.paletteBank = 0;
    // Sound CPU interface.
    this.latch = 0x0F;            // tune select (written inverted)
    this.page = 0;                // P2 bits: external ROM page, latch select
    this.mcuStatus = 0;           // reported to the main CPU in IN2 bit 6
    this.p1In = 0xFF; this.p2In = 0xFF;
    this.t = [1, 1];
  }

  // ---------------------------------------------------------------- main CPU bus

  read(a) {
    if (a < 0x4000) return this.roms.main[a];
    if (a >= 0x6000 && a < 0x7400) return this.ram[a - 0x6000];
    if (a >= 0x7400 && a < 0x7800) return this.vram[a - 0x7400];
    switch (a) {
      case 0x7C00: return this.in0;
      case 0x7C80: return this.in1;
      case 0x7D00: return this.in2 | (this.mcuStatus << 6);
      case 0x7D80: return this.dsw;
    }
    return 0;
  }

  write(a, v) {
    if (a >= 0x6000 && a < 0x7400) { this.ram[a - 0x6000] = v; return; }
    if (a >= 0x7400 && a < 0x7800) { this.vram[a - 0x7400] = v; return; }
    if (a >= 0x7D00 && a < 0x7D08) { this.soundSignal(a & 7, v); return; }
    switch (a) {
      case 0x7C00: this.latch = v ^ 0x0F; return;                    // tune select
      case 0x7D80: this.snd.int = v !== 0; return;                   // sound CPU interrupt
      case 0x7D83: this.spriteBank = v & 1; return;
      case 0x7D84: this.nmiEnable = !!(v & 1); return;
      case 0x7D86: case 0x7D87: {
        const bit = a & 1;
        this.paletteBank = (this.paletteBank & ~(1 << bit)) | ((v & 1) << bit);
        return;
      }
      // 7800-780F DMA controller, 7D82 flip screen, 7D85 DMA request: not needed.
    }
  }

  // 7D00-7D07: analog sounds and lines into the 8035.
  soundSignal(n, v) {
    if (n <= 2) this.sound.trigger(['walk', 'jump', 'stomp'][n], v);
    else if (n === 3) this.p2In = (this.p2In & ~0x20) | ((v & 1) ? 0 : 0x20);   // active low
    else if (n === 4) this.t[1] = ~v & 1;
    else if (n === 5) this.t[0] = ~v & 1;
  }

  // ---------------------------------------------------------------- sound CPU

  // MOVX reads the upper half of the sound ROM, 256 bytes at a time (P2 bits
  // 0-2 pick the page), or the tune latch when P2 bit 6 selects it.
  soundBusRead(port) {
    if ((this.page & 0x40) && port === 0x20) return this.latch;
    return this.roms.sound[0x800 + (this.page & 7) * 256 + (port & 0xFF)] ?? 0;
  }

  soundPortWrite(n, v) {
    if (n === 1) { this.sound.dac = v; return; }                 // P1: the DAC
    this.sound.discharge = !(v & 0x80);                          // P2.7: DAC envelope
    this.page = v & 0x47;
    this.mcuStatus = (~v & 0x10) >> 4;                           // P2.4: status to the main CPU
  }

  // ---------------------------------------------------------------- inputs

  // IN0: right, left, up, down, jump (active high). IN2: start 1, start 2,
  // sound status, coin.
  setInputs(s) {
    this.in0 = (s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.up ? 0x04 : 0) | (s.down ? 0x08 : 0) | (s.fire ? 0x10 : 0);
    this.in1 = 0;
    this.in2 = (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0) | (s.coin ? 0x80 : 0);
  }

  // DIP switches: 1 coin 1 credit, upright.
  applySwitches(v) {
    this.dsw = v.lives | v.bonus | 0x80;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) {
        if (this.nmiEnable) this.cpu.nmi();
        this.render();
      }
      this.cpu.run(LINE_CYCLES);
      for (const c of SOUND_CYCLES) { this.snd.run(c); this.sound.sample(); }
    }
  }

  render() {
    const out = this.native, pal = this.palette, bank = this.paletteBank * 16;

    // Tiles: color from the PROM per column and 4-row block.
    for (let row = 2; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const idx = row * 32 + col;
        const color = ((this.colorCodes[col + 32 * (row >> 2)] & 0x0F) + bank) * 4;
        const pix = (this.vram[idx] + this.tileBank * 256) * 64;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y) * NATIVE_W + col * 8;
          for (let x = 0; x < 8; x++) out[o++] = pal[color + this.tilePix[pix + y * 8 + x]];
        }
      }
    }

    // Sprites: 96 slots of 4 bytes in the selected bank; y 0 means unused.
    const base = 0x900 + this.spriteBank * 0x200;
    for (let s = 0; s < 96; s++) {
      const o = base + s * 4, y0 = this.ram[o];
      if (!y0) continue;
      const attr = this.ram[o + 2];
      const code = (this.ram[o + 1] & 0x7F) + ((attr & 0x40) << 1);
      const color = ((attr & 0x0F) + bank) * 4;
      const x = this.ram[o + 3] - 8, y = 240 - y0 + 7;
      this.drawSprite(code, color, attr & 0x80, this.ram[o + 1] & 0x80, x, y);
      this.drawSprite(code, color, attr & 0x80, this.ram[o + 1] & 0x80, x + 256, y);   // wraparound
    }

    rotate90(out.subarray(TOP * NATIVE_W, (TOP + NATIVE_H) * NATIVE_W), NATIVE_W, NATIVE_H, this.frame);
  }

  drawSprite(code, color, flipX, flipY, sx, sy) {
    const out = this.native, pix = (code & 0x7F) * 256;
    for (let y = 0; y < 16; y++) {
      const py = sy + y;
      if (py < TOP || py >= TOP + NATIVE_H) continue;
      const srcY = flipY ? 15 - y : y;
      for (let x = 0; x < 16; x++) {
        const px = sx + x;
        if (px < 0 || px >= NATIVE_W) continue;
        const pen = this.spritePix[pix + srcY * 16 + (flipX ? 15 - x : x)];
        if (pen) out[py * NATIVE_W + px] = this.palette[color + pen];
      }
    }
  }
}

DonkeyKong.id = 'dkong';
DonkeyKong.title = 'Donkey Kong';
DonkeyKong.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x00], ['4', 0x01], ['5', 0x02], ['6', 0x03]], default: 0x00 },
  { id: 'bonus', label: 'Bonus life', options: [['7K', 0x00], ['10K', 0x04], ['15K', 0x08], ['20K', 0x0C]], default: 0x00 },
];

// Donkey Kong Jr. (1982): the same board with a 24K program, a second bank of
// tiles, and different sound wiring. Its tune latch isn't inverted, the
// directly triggered effects (recorded samples on MAME, modeled here) are
// climb, jump, land, roar, snapjaw, death and drop, and nothing interrupts the
// sound CPU.
export class DonkeyKongJr extends DonkeyKong {
  read(a) {
    if (a < 0x6000) return this.roms.main[a];
    return super.read(a);
  }

  write(a, v) {
    switch (a) {
      case 0x7C00: this.latch = v; return;                              // tune select
      case 0x7C80: this.tileBank = v & 1; return;
      case 0x7C81: this.p2In = (this.p2In & ~0x40) | ((v & 1) ? 0 : 0x40); return;   // active low
      case 0x7D80: this.sound.trigger('death', v); return;
      case 0x7D81: this.sound.trigger('drop', v); return;
    }
    super.write(a, v);
  }

  soundSignal(n, v) {
    const effect = ['climb', 'jump', 'land', 'roar', null, null, 'snapjaw', null][n];
    if (effect) this.sound.trigger(effect, v);
    else if (n === 4) this.t[1] = ~v & 1;
    else if (n === 5) this.t[0] = ~v & 1;
  }
}

DonkeyKongJr.id = 'dkongjr';
DonkeyKongJr.title = 'Donkey Kong Jr.';
DonkeyKongJr.switches = DonkeyKong.switches;
