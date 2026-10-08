// Namco Dig Dug (1982): the Galaga board design (three Z80s, the 06xx bus
// interface with a 51xx for coins and controls, the waveform sound generator)
// plus a 53xx that reads the DIP switches, an Atari EAROM for high scores, and
// different video: a background playfield read straight from a map ROM (four
// pictures and a color bank to choose from), a 1-bit character layer, and
// Galaga-style sprites with a different 2x2 numbering.

import { Galaga, NATIVE_W, NATIVE_H } from './galaga.js';
import { decodeTiles, promPalette, rotate90, run } from './video.js';

export class DigDug extends Galaga {
  // roms: { main 16K, sub 8K, sound 4K, chars 2K, sprites 16K, bgTiles 4K,
  //         bgMap 4K, palette 32, spriteLut 256, bgLut 256, wave 256 }
  constructor(roms) {
    super(roms);
    this.controls = 'four-way';
    this.earom = new Uint8Array(0x40);         // high scores (kept only while running)
  }

  reset() {
    super.reset();
    this.bgSelect = 0; this.bgDisable = 0; this.bgBank = 0; this.txColorMode = 0;
    this.count53 = 0;
  }

  saveState() {
    return { ...super.saveState(), dd: [this.bgSelect, this.bgDisable, this.bgBank, this.txColorMode, this.count53], earom: this.earom.slice() };
  }
  loadState(s) {
    super.loadState(s);
    [this.bgSelect, this.bgDisable, this.bgBank, this.txColorMode, this.count53] = s.dd;
    this.earom.set(s.earom);
  }

  // ---------------------------------------------------------------- bus

  read(cpu, a) {
    if (a >= 0xB800 && a < 0xB840) return this.earom[a & 0x3F];
    if (a >= 0x6800 && a < 0x6808) return 0xFF;            // no switches here; the 53xx reads them
    return super.read(cpu, a);
  }

  write(cpu, a, v) {
    if (a >= 0xA000 && a < 0xA008) {
      const bit = v & 1;
      switch (a & 7) {
        case 0: case 1: this.bgSelect = (this.bgSelect & ~(1 << (a & 1))) | (bit << (a & 1)); break;   // background picture
        case 2: this.txColorMode = bit; break;
        case 3: this.bgDisable = bit; break;
        case 4: case 5: { const sh = a & 7; this.bgBank = (this.bgBank & ~(1 << sh)) | (bit << sh); break; }  // background color bank
        // 6 unused, 7 flip screen
      }
      return;
    }
    if (a >= 0xB800 && a < 0xB840) { this.earom[a & 0x3F] = v; return; }
    if (a === 0xB840) return;                              // EAROM control
    super.write(cpu, a, v);
  }

  // The 53xx returns the two DIP switch banks in turn.
  read53() { return (this.count53++ & 1) ? this.dswB : this.dswA; }

  // ---------------------------------------------------------------- inputs

  // IN0 as Galaga (fire, starts, coins); IN1: up, right, down, left.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.fire ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0) | (s.coin ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.up ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.down ? 0x04 : 0) | (s.left ? 0x08 : 0));
  }

  // A: 1 coin 1 credit (coin B), bonus 20K/60K, lives. B: 1 coin 1 credit
  // (coin A), freeze off, demo sounds, continue allowed, upright, difficulty.
  applySwitches(v) {
    this.dswA = 0x01 | 0x18 | v.lives;
    this.dswB = 0x20 | v.demoSounds | 0x04 | v.difficulty;
  }

  // ---------------------------------------------------------------- video

  decodeGraphics() {
    const { chars, sprites, bgTiles, palette, spriteLut, bgLut } = this.roms;
    // Characters: 1 bit per pixel, lowest bit leftmost.
    this.charPix = decodeTiles(chars, { count: chars.length / 8, width: 8, height: 8, planes: [0], xs: run(7, 8, -1), ys: run(0, 8, 8), size: 64 });
    // Sprites: Galaga's 16x16 layout.
    this.spritePix = decodeTiles(sprites, {
      count: sprites.length / 64, width: 16, height: 16, planes: [0, 4],
      xs: [...run(0, 4), ...run(64, 4), ...run(128, 4), ...run(192, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    // Background tiles: Galaga's 8x8 character layout.
    this.bgPix = decodeTiles(bgTiles, {
      count: bgTiles.length / 16, width: 8, height: 8, planes: [0, 4], xs: [64, 65, 66, 67, 0, 1, 2, 3], ys: run(0, 8, 8), size: 128,
    });
    this.palette = promPalette(palette, 32, [0x47, 0x97]);
    this.spriteLut = Uint8Array.from(spriteLut, (v) => v & 0x0F);
    this.bgLut = Uint8Array.from(bgLut, (v) => v & 0x0F);
  }

  render() {
    const out = this.native, ram = this.ram, pal = this.palette, map = this.roms.bgMap;

    // Background playfield, then the character layer over it: 36x28 tiles,
    // mapped from the 32x32 layout as on Galaga.
    for (let row = 0; row < 28; row++) {
      for (let col = 0; col < 36; col++) {
        const r = row + 2, c = col - 2;
        const offs = (c & 0x20) ? r + ((c & 0x1F) << 5) : c + (r << 5);
        const bgCode = map[offs | (this.bgSelect << 10)];
        const bgColor = ((this.bgDisable ? 0x0F : bgCode >> 4) | this.bgBank) * 4;
        const tx = ram[0x8000 + offs];
        const txColor = this.txColorMode ? tx & 0x0F : ((tx >> 4) & 0x0E) | ((tx >> 3) & 2);
        const bgPix = bgCode * 64, txPix = (tx & 0x7F) * 64;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y) * NATIVE_W + col * 8;
          for (let x = 0; x < 8; x++, o++) {
            const i = y * 8 + x;
            out[o] = this.charPix[txPix + i] ? pal[txColor] : pal[this.bgLut[bgColor + this.bgPix[bgPix + i]]];
          }
        }
      }
    }

    // Sprites: registers in the top 128 bytes of each work RAM. Big (2x2)
    // sprites number their quarters differently from Galaga.
    for (let offs = 0; offs < 0x80; offs += 2) {
      let code = ram[0x8B80 + offs];
      const color = (ram[0x8B81 + offs] & 0x3F) * 4;
      const flipX = ram[0x9B80 + offs] & 1, flipY = (ram[0x9B80 + offs] >> 1) & 1;
      const size = code >> 7;
      if (size) code = (code & 0xC0) | ((code & 0x3F) << 2);
      const sx = ram[0x9381 + offs] - 40 + 1;
      let sy = 256 - ram[0x9380 + offs] + 1 - 16 * size;
      sy = (sy & 0xFF) - 32;
      for (let ty = 0; ty <= size; ty++) for (let tx = 0; tx <= size; tx++) {
        const tile = (code + [[0, 1], [2, 3]][ty ^ (size & flipY)][tx ^ (size & flipX)]) & 0xFF;
        const x = (sx + 16 * tx) & 0xFF;
        this.drawDigDugSprite(tile, color, flipX, flipY, x, sy + 16 * ty);
        this.drawDigDugSprite(tile, color, flipX, flipY, x + 0x100, sy + 16 * ty);   // wraparound
      }
    }

    rotate90(out, NATIVE_W, NATIVE_H, this.frame);
  }

  drawDigDugSprite(tile, color, flipX, flipY, sx, sy) {
    const out = this.native, pix = tile * 256;
    for (let y = 0; y < 16; y++) {
      const py = sy + y;
      if (py < 0 || py >= NATIVE_H) continue;
      const srcY = flipY ? 15 - y : y;
      for (let x = 0; x < 16; x++) {
        const px = sx + x;
        if (px < 16 || px >= 272) continue;
        const v = this.spriteLut[color + this.spritePix[pix + srcY * 16 + (flipX ? 15 - x : x)]];
        if (v !== 0x0F) out[py * NATIVE_W + px] = this.palette[0x10 + v];
      }
    }
  }
}

DigDug.id = 'digdug';
DigDug.title = 'Dig Dug';
DigDug.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x00], ['2', 0x40], ['3', 0x80], ['5', 0xC0]], default: 0x80 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x00], ['Med', 0x02], ['Hard', 0x01], ['Hardest', 0x03]], default: 0x00 },
  { id: 'demoSounds', label: 'Demo sounds', options: [['On', 0x00], ['Off', 0x10]], default: 0x00 },
];
