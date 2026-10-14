// Konami Shao-lin's Road (1985): a 6809 at 1.25 MHz, a 32x32 map of 8x8
// tiles whose columns 4-31 scroll together (the first four hold the score),
// 24 16x16 sprites, 4 bits per pixel through lookup PROMs into eight banks of
// a 256-color resistor palette, and two SN76489s written directly.
//
// Each frame: one IRQ, and eight NMIs (when enabled) that drive the music.
// 60 Hz; the picture is 256x224 on a vertical monitor.

import { M6809 } from './m6809.js';
import { SN76489 } from './sn76489.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16, LINES = 256, REFRESH = 60, CLOCK = 1250000;
const STATE = ['ram', 'nmiEnable', 'palBank', 'scroll', 'cycleCarry', 'sampleCarry', 'in0', 'in1', 'cpu', 'sound'];

export class ShaolinsRoad {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (6000-FFFF), chars 16K, sprites 32K, red/green/blue 256 each, charLut, spriteLut }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = REFRESH;
    this.controls = 'four-way';
    this.buttons = 2;
    this.button2 = 'Jump';
    this.roms = roms;
    this.ram = new Uint8Array(0x1800);         // 2800-3FFF: work RAM, sprites (3100), color (3800) and video (3C00) RAM
    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onTaken = (kind) => { if (kind === 'irq') this.cpu.irq = false; };
    this.sn = [new SN76489(1536000), new SN76489(3072000)];
    this.sound = new SoundMix(this.sn, 0.8);

    this.charPix = decodeTiles(roms.chars, {
      count: 512, width: 8, height: 8, planes: [512 * 16 * 8 + 4, 512 * 16 * 8, 4, 0],
      xs: [...run(0, 4), ...run(64, 4)], ys: run(0, 8, 8), size: 128,
    });
    this.spritePix = decodeTiles(roms.sprites, {
      count: 256, width: 16, height: 16, planes: [256 * 64 * 8 + 4, 256 * 64 * 8, 4, 0],
      xs: [...run(0, 4), ...run(64, 4), ...run(128, 4), ...run(192, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    const lvl = (v) => 0x0E * (v & 1) + 0x1F * ((v >> 1) & 1) + 0x43 * ((v >> 2) & 1) + 0x8F * ((v >> 3) & 1);
    this.palette = Uint32Array.from({ length: 256 }, (_, i) => rgba(lvl(roms.red[i]), lvl(roms.green[i]), lvl(roms.blue[i])));
    this.frame = new Uint32Array(W * H);
    this.native = new Uint32Array(W * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0);
    this.nmiEnable = 0; this.palBank = 0; this.scroll = 0;
    this.cycleCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sound.reset();
  }

  read(a) {
    if (a >= 0x4000) return this.roms.main[a - 0x6000] ?? 0xFF;
    if (a >= 0x2800) return this.ram[a - 0x2800];
    switch (a) {
      case 0x0500: return this.dsw0;
      case 0x0600: return this.dsw1;
      case 0x0700: return this.in0;
      case 0x0701: return this.in1;
      case 0x0702: return 0xFF;
      case 0x0703: return 0xFF;
    }
    return 0xFF;
  }
  write(a, v) {
    if (a >= 0x2800 && a < 0x4000) { this.ram[a - 0x2800] = v; return; }
    switch (a) {
      case 0x0000: this.nmiEnable = v; return;     // bit 1: NMIs on
      case 0x0300: this.sn[0].write(v); return;
      case 0x0400: this.sn[1].write(v); return;
      case 0x1800: this.palBank = v & 7; return;
      case 0x2000: this.scroll = v; return;
    }
  }

  // IN0: coin, starts. IN1: left, right, up, down, kick, jump.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0) | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0));
  }
  // DSW0: lives, upright, bonus, difficulty, demo sounds. DSW1: no flip, single controls. DSW2 (coinage): 1 coin 1 credit.
  applySwitches(v) { this.dsw0 = v.lives | v.bonus | v.difficulty; this.dsw1 = 0xFF; }

  runFrame() {
    const cyc = CLOCK / REFRESH / LINES, samples = RATE / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      // Sixteen interrupt slots a frame: the first is the IRQ, every odd one an NMI.
      if (line % 16 === 0) {
        const slot = line / 16;
        if (slot === 0) this.cpu.irq = true;
        else if (slot & 1 && this.nmiEnable & 2) this.cpu.nmi();
      }
      this.cycleCarry += cyc;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    this.render();
  }

  render() {
    const out = this.native, ram = this.ram, pal = this.palette, lut = this.roms.charLut, slut = this.roms.spriteLut;
    const bank = this.palBank * 32;
    // Tiles: 3C00 codes, 3800 attributes; columns 4-31 scroll vertically.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const col = x >> 3, vy = col >= 4 ? (y + TOP + this.scroll + 1) & 0xFF : y + TOP;
        const i = (vy >> 3) * 32 + col, attr = ram[0x1000 + i];
        const code = ram[0x1400 + i] + ((attr & 0x40) << 2), fy = attr & 0x20;
        const pen = this.charPix[code * 64 + (fy ? 7 - (vy & 7) : vy & 7) * 8 + (x & 7)];
        out[y * W + x] = pal[(lut[(attr & 0x0F) * 16 + pen] & 0x0F) + bank + 16];
      }
    }
    // Sprites: 32 bytes each at 3100; the first on top.
    for (let offs = 0x300 - 32; offs >= 0; offs -= 32) {
      const s = 0x900 + offs;
      if (!ram[s] || !ram[s + 6]) continue;
      const code = ram[s + 8], attr = ram[s + 9], color = (attr & 0x0F) * 16;
      const fx = !(attr & 0x40), fy = attr & 0x80, sx = 240 - ram[s + 6], sy = 248 - ram[s + 4] - TOP;
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        const src = code * 256 + (fy ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= W) continue;
          const c = slut[color + this.spritePix[src + (fx ? 15 - x : x)]] & 0x0F;
          if (c) out[py * W + px] = pal[c + bank];
        }
      }
    }
    rotate90(out, W, H, this.frame);
  }
}
ShaolinsRoad.id = 'shaolins';
ShaolinsRoad.title = "Shao-lin's Road";
ShaolinsRoad.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x03], ['3', 0x02], ['5', 0x01], ['7', 0x00]], default: 0x02 },
  { id: 'bonus', label: 'Bonus life', options: [['30K, every 70K', 0x18], ['40K, every 80K', 0x10], ['40K', 0x08], ['50K', 0x00]], default: 0x18 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Medium', 0x40], ['Hard', 0x20], ['Hardest', 0x00]], default: 0x40 },
];
