// Konami Roc'n Rope (1983): Konami's encrypted 6809 at 1.6 MHz, a 32x32 map
// of 8x8 tiles and 24 16x16 sprites, 4 bits per pixel through lookup PROMs
// into a 32-color palette, and the Time Pilot sound board. The game writes
// its interrupt vectors into latches that cover the top of the ROM.
//
// One IRQ a frame (when enabled), 60 Hz; the picture is 256x224 on a
// vertical monitor.

import { Konami1 } from './m6809.js';
import { TimePilotSound } from './tpsound.js';
import { decodeTiles, rgba, rotate270, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16, LINES = 256, REFRESH = 60, CLOCK = 1600000;
const STATE = ['ram', 'vectors', 'irqEnable', 'cycleCarry', 'in0', 'in1', 'cpu', 'tp'];

export class RocNRope {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (6000-FFFF), sound, chars 16K, sprites 32K, palette 32, spriteLut 256, charLut 256 }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = REFRESH;
    this.controls = 'four-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x2000);         // 4000-5FFF: sprites, color and video RAM, work RAM
    this.vectors = new Uint8Array(12);         // FFF2-FFFD
    this.cpu = new Konami1({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    // One opcode doesn't decode right from the dumped ROM; the board's own fix.
    const decrypt = this.cpu.fetchOp.bind(this.cpu);
    this.cpu.fetchOp = () => (this.cpu.pc === 0x703D ? (this.cpu.fetch(), 0x98) : decrypt());
    this.cpu.onTaken = (kind) => { if (kind === 'irq') this.cpu.irq = false; };
    this.tp = new TimePilotSound(roms.sound);
    this.sound = this.tp.sound;

    this.charPix = decodeTiles(roms.chars, {
      count: 512, width: 8, height: 8, planes: [0x2000 * 8 + 4, 0x2000 * 8, 4, 0],
      xs: [...run(0, 4), ...run(64, 4)], ys: run(0, 8, 8), size: 128,
    });
    this.spritePix = decodeTiles(roms.sprites, {
      count: 256, width: 16, height: 16, planes: [256 * 64 * 8 + 4, 256 * 64 * 8, 4, 0],
      xs: [...run(0, 4), ...run(64, 4), ...run(128, 4), ...run(192, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    // Palette PROM: red bits 0-2, green 3-5, blue 6-7.
    const lvl = (b0, b1, b2) => 0x21 * b0 + 0x47 * b1 + 0x97 * b2;
    this.palette = Uint32Array.from(roms.palette, (v) =>
      rgba(lvl(v & 1, (v >> 1) & 1, (v >> 2) & 1), lvl((v >> 3) & 1, (v >> 4) & 1, (v >> 5) & 1), lvl(0, (v >> 6) & 1, (v >> 7) & 1)));
    this.spriteLut = Uint8Array.from(roms.spriteLut, (v) => v & 0x0F);
    this.charLut = Uint8Array.from(roms.charLut, (v) => v & 0x0F);
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vectors.fill(0xFF);
    this.irqEnable = 0; this.cycleCarry = 0;
    this.cpu.reset(); this.tp.reset();
  }

  read(a) {
    if (a >= 0xFFF2 && a < 0xFFFE) return this.vectors[a - 0xFFF2];
    if (a >= 0x6000) return this.roms.main[a - 0x6000];
    if (a >= 0x4000) return this.ram[a - 0x4000];
    switch (a) {
      case 0x3080: return this.in0;
      case 0x3081: return this.in1;
      case 0x3082: return 0xFF;
      case 0x3083: return this.dsw0;
      case 0x3000: return this.dsw1;
      case 0x3100: return this.dsw2;
    }
    return 0xFF;
  }
  write(a, v) {
    if (a >= 0x4000 && a < 0x6000) { this.ram[a - 0x4000] = v; return; }
    if (a >= 0x8182 && a <= 0x818D) { this.vectors[a - 0x8182] = v; return; }
    switch (a) {
      case 0x8081: this.tp.trigger(v); return;
      case 0x8087: this.irqEnable = v & 1; if (!this.irqEnable) this.cpu.irq = false; return;
      case 0x8100: this.tp.command(v); return;
    }
  }

  // IN0: coin, starts. IN1: left, right, up, down, fire.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0) | (s.fire ? 0x10 : 0));
  }
  // DSW0: 1 coin 1 credit. DSW1: lives, upright, difficulty, demo sounds. DSW2: bonus.
  applySwitches(v) { this.dsw0 = 0xFF; this.dsw1 = v.lives | v.difficulty; this.dsw2 = v.bonus | 0x38; }

  runFrame() {
    const cyc = CLOCK / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === TOP + H && this.irqEnable) this.cpu.irq = true;
      this.cycleCarry += cyc;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.tp.run(1 / REFRESH / LINES);
    }
    this.render();
  }

  render() {
    const out = this.native, ram = this.ram, pal = this.palette;
    // Tiles: 4C00 codes, 4800 attributes (bank, flips, color).
    for (let row = 2; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const i = row * 32 + col, attr = ram[0x800 + i];
        const code = ram[0xC00 + i] + 2 * (attr & 0x80), color = (attr & 0x0F) * 16;
        const fx = attr & 0x40, fy = attr & 0x20;
        for (let y = 0; y < 8; y++) {
          const src = code * 64 + (fy ? 7 - y : y) * 8;
          let o = ((row - 2) * 8 + y) * W + col * 8;
          for (let x = 0; x < 8; x++, o++) out[o] = pal[this.charLut[color + this.charPix[src + (fx ? 7 - x : x)]]];
        }
      }
    }
    // Sprites: 4400 (x, code) and 4000 (attributes, y); the first pair on top.
    for (let offs = 0x2E; offs >= 0; offs -= 2) {
      const attr = ram[offs], sy = ram[offs + 1] - TOP, sx = 240 - ram[0x400 + offs], code = ram[0x400 + offs + 1];
      const color = (attr & 0x0F) * 16, fx = attr & 0x40, fy = !(attr & 0x80);
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        const src = code * 256 + (fy ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= W) continue;
          const c = this.spriteLut[color + this.spritePix[src + (fx ? 15 - x : x)]];
          if (c) out[py * W + px] = pal[c];
        }
      }
    }
    rotate270(out, W, H, this.frame);
  }
}
RocNRope.id = 'rocnrope';
RocNRope.title = "Roc'n Rope";
RocNRope.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x03], ['4', 0x02], ['5', 0x01], ['255 (cheat)', 0x00]], default: 0x03 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x78], ['Normal', 0x58], ['Hard', 0x18], ['Hardest', 0x00]], default: 0x78 },
  { id: 'bonus', label: 'First bonus', options: [['20000', 0x07], ['30000', 0x05], ['40000', 0x04], ['50000', 0x03]], default: 0x07 },
];
