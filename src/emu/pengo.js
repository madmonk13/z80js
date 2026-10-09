// Sega Pengo (1982): Pac-Man's video and sound hardware (the same tiles,
// sprites and 3-voice waveform generator) behind a different memory map, with
// two banks of graphics, two banks of color lookup, and a Sega encrypted Z80:
// opcodes and data decode differently. The CPU runs at 3.072 MHz with Pac-Man's
// 60.6 Hz timing.

import { PacMan } from './pacman.js';
import { decodeTiles, rotate90, run } from './video.js';

// Sega's 315-5010 encryption flips bits 3, 5 and 7 of each byte by one of a
// few patterns, chosen by address lines 0, 4, 8 and 12, whether the byte is
// an opcode or data, and bits 3 and 5 of the byte itself (bit 7 mirrors the
// choice). These are the patterns, then Pengo's key: for each of the 16
// address cases, the pattern for opcodes and the pattern for data.
const PATTERNS = [
  [0xA0, 0x80, 0xA8, 0x88], [0x28, 0xA8, 0x08, 0x88], [0xA0, 0x80, 0x20, 0x00], [0x08, 0x28, 0x88, 0xA8],
  [0x08, 0x00, 0x88, 0x80], [0x00, 0x08, 0x20, 0x28], [0x88, 0x80, 0x08, 0x00],
];
const PENGO_KEY = [
  [0, 1], [1, 0], [2, 2], [3, 0], [4, 1], [2, 4], [2, 2], [2, 5],
  [6, 2], [6, 5], [3, 3], [0, 2], [4, 6], [5, 6], [3, 3], [4, 2],
];

function segaDecrypt(rom, key) {
  const ops = new Uint8Array(rom.length), data = new Uint8Array(rom.length);
  for (let a = 0; a < rom.length; a++) {
    const v = rom[a];
    const row = (a & 1) | ((a >> 3) & 2) | ((a >> 6) & 4) | ((a >> 9) & 8);
    let col = ((v >> 3) & 1) | ((v >> 4) & 2), flip = 0;
    if (v & 0x80) { col = 3 - col; flip = 0xA8; }
    ops[a] = (v & ~0xA8) | (PATTERNS[key[row][0]][col] ^ flip);
    data[a] = (v & ~0xA8) | (PATTERNS[key[row][1]][col] ^ flip);
  }
  return { ops, data };
}

export class Pengo extends PacMan {
  // roms: { main 32K (encrypted), tiles 8K, sprites 8K, palette 32, lut 256+, wave 256 }
  constructor(roms) {
    const { ops, data } = segaDecrypt(roms.main, PENGO_KEY);
    super({ ...roms, main: data });
    this.cpu.opRead = (a) => (a < 0x8000 ? ops[a] : this.read(a));
    this.buttons = 1;
    this.tilePix = decodeTiles(roms.tiles, {
      count: 512, width: 8, height: 8, planes: [0, 4], xs: [64, 65, 66, 67, 0, 1, 2, 3], ys: run(0, 8, 8), size: 128,
    });
    this.spritePix = decodeTiles(roms.sprites, {
      count: 128, width: 16, height: 16, planes: [0, 4],
      xs: [...run(64, 4), ...run(128, 4), ...run(192, 4), ...run(0, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    // Colors 0-63 use the lookup PROM as is, 64-127 the same with the palette's upper half.
    this.lut = Uint8Array.from({ length: 512 }, (_, i) => (roms.lut[i & 0xFF] & 15) + (i & 0x100 ? 16 : 0));
    this.coinFrames = 0; this.coinWas = false; this.stick = 0;
  }

  reset() {
    super.reset();
    this.banks = { gfx: 0, colors: 0, palette: 0 };
  }

  saveState() { return { ...super.saveState(), banks: { ...this.banks }, coin: [this.coinFrames, this.coinWas, this.stick] }; }
  loadState(s) { super.loadState(s); this.banks = { ...s.banks }; [this.coinFrames, this.coinWas, this.stick] = s.coin; }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x8000) return this.roms.main[a];
    if (a < 0x9000) return this.ram[a - 0x8000];
    switch (a & 0xFFC0) {
      case 0x9000: return this.dsw1;
      case 0x9040: return this.dsw0;
      case 0x9080: return this.in1;
      case 0x90C0: return this.in0;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a < 0x8000) return;
    if (a < 0x9000) { this.ram[a - 0x8000] = v; return; }
    if (a < 0x9020) { this.wsg.write(a & 0x1F, v); return; }
    if (a < 0x9030) { this.spritePos[a & 0x0F] = v; return; }
    switch (a) {
      case 0x9040: this.irqEnable = !!(v & 1); if (!this.irqEnable) this.cpu.irq = false; break;
      case 0x9041: this.wsg.enabled = !!(v & 1); break;
      case 0x9042: this.banks.palette = v & 1; break;
      case 0x9046: this.banks.colors = v & 1; break;
      case 0x9047: this.banks.gfx = v & 1; break;
      // 9043 flip screen, 9044-9045 coin counters, 9070 watchdog
    }
  }

  // ---------------------------------------------------------------- inputs

  // Active low. IN0: up, down, left, right, coin, push. IN1: starts.
  // The coin line must stay low for 2-9 frames, so each press is a short pulse.
  setInputs(s) {
    if (s.coin && !this.coinWas) this.coinFrames = 3;
    this.coinWas = !!s.coin;
    this.stick = (s.up ? 0x01 : 0) | (s.down ? 0x02 : 0) | (s.left ? 0x04 : 0) | (s.right ? 0x08 : 0) | (s.fire ? 0x80 : 0);
    this.in1 = 0xFF & ~((s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0));
    this.updateIn0();
  }
  updateIn0() { this.in0 = 0xFF & ~(this.stick | (this.coinFrames > 0 ? 0x10 : 0)); }

  // DSW0: bonus, demo sounds, upright, lives, rack test off, difficulty. DSW1: 1 coin 1 credit.
  applySwitches(v) {
    this.dsw0 = v.bonus | 0x00 | 0x00 | v.lives | 0x20 | v.difficulty;
    this.dsw1 = 0xCC;
  }

  runFrame() {
    super.runFrame();
    if (this.coinFrames > 0) { this.coinFrames--; this.updateIn0(); }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, ram = this.ram, pal = this.palette, lut = this.lut;
    const bank = (this.banks.colors << 5) | (this.banks.palette << 6), gfx = this.banks.gfx;
    for (let row = 0; row < 28; row++) {
      for (let col = 0; col < 36; col++) {
        const r = row + 2, c = col - 2;
        const offs = (c & 0x20) ? r + ((c & 0x1F) << 5) : c + (r << 5);
        const pix = (ram[offs] | (gfx << 8)) * 64, color = ((ram[0x400 + offs] & 0x1F) | bank) * 4;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y) * 288 + col * 8;
          for (let x = 0; x < 8; x++) out[o++] = pal[lut[color + this.tilePix[pix + y * 8 + x]]];
        }
      }
    }
    for (let n = 7; n >= 0; n--) {
      const code = ram[0xFF0 + n * 2], color = ((ram[0xFF1 + n * 2] & 0x1F) | bank) * 4;
      const sx = 272 - this.spritePos[n * 2 + 1], sy = this.spritePos[n * 2] - 31 + (n <= 2 ? 1 : 0);
      this.drawSprite((code >> 2) | (gfx << 6), color, code & 1, code & 2, sx, sy);
    }
    rotate90(out, 288, 224, this.frame);
  }
}

Pengo.id = 'pengo';
Pengo.title = 'Pengo';
Pengo.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x18], ['3', 0x10], ['4', 0x08], ['5', 0x00]], default: 0x10 },
  { id: 'bonus', label: 'Bonus', options: [['30K', 0x00], ['50K', 0x01]], default: 0x00 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0xC0], ['Medium', 0x80], ['Hard', 0x40], ['Hardest', 0x00]], default: 0x80 },
];
