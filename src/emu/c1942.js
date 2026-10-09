// Capcom 1942 (1984): a Z80 at 4 MHz with 16K ROM banks, a second Z80 at
// 3 MHz driving two AY-3-8910s, a scrolling layer of 16x16 tiles (3 bits per
// pixel, four palette banks), 32 sprites of 16x16 that stack two or four high,
// and a layer of 8x8 text on top. Colors come from three 4-bit PROMs through
// lookup PROMs per layer.
//
// The main CPU takes two interrupts a frame (RST 08 mid-frame for the sound
// commands, RST 10 at vblank); the sound CPU four. 60 Hz; the visible picture
// is 256x224 on a vertical monitor mounted counter-clockwise.

import { Z80 } from './z80.js';
import { AY8910 } from './ay8910.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, rotate270, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16;
const LINES = 262, LINE_CYCLES = 4000000 / 60 / LINES, SOUND_LINE_CYCLES = 3000000 / 60 / LINES;
const SAMPLES_PER_LINE = 48000 / 60 / LINES;
const STATE = ['ram', 'fgRam', 'bgRam', 'spriteRam', 'soundRam', 'bank', 'scroll', 'palBank', 'latch', 'soundReset',
  'cycleCarry', 'soundCarry', 'sampleCarry', 'in0', 'in1', 'cpu', 'sndCpu', 'sound'];

export class C1942 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 32K, banks 48K (three 16K banks), sound 16K, chars 8K, tiles 48K, sprites 64K,
  //         red/green/blue 256 each, charLut, tileLut, spriteLut 256 each }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = 60;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Loop';
    this.roms = roms;
    this.ram = new Uint8Array(0x1000);         // E000-EFFF
    this.fgRam = new Uint8Array(0x800);        // D000-D3FF codes, D400-D7FF colors
    this.bgRam = new Uint8Array(0x400);        // D800-DBFF: per column, 16 codes then 16 attributes
    this.spriteRam = new Uint8Array(0x80);     // CC00-CC7F
    this.soundRam = new Uint8Array(0x800);

    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.sndCpu = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.sndCpu.onIrqAck = () => { this.sndCpu.irq = false; };
    this.ay = [new AY8910(1500000, () => 0xFF, 1.5), new AY8910(1500000, () => 0xFF, 1.5)];
    this.sound = new SoundMix(this.ay);

    this.charPix = decodeTiles(roms.chars, {
      count: 512, width: 8, height: 8, planes: [4, 0], xs: [0, 1, 2, 3, 8, 9, 10, 11], ys: run(0, 8, 16), size: 128,
    });
    const third = roms.tiles.length / 3 * 8;
    this.tilePix = decodeTiles(roms.tiles, {
      count: 512, width: 16, height: 16, planes: [0, third, third * 2],
      xs: [...run(0, 8), ...run(128, 8)], ys: run(0, 16, 8), size: 256,
    });
    const half = roms.sprites.length / 2 * 8;
    this.spritePix = decodeTiles(roms.sprites, {
      count: 512, width: 16, height: 16, planes: [half + 4, half, 4, 0],
      xs: [0, 1, 2, 3, 8, 9, 10, 11, 256, 257, 258, 259, 264, 265, 266, 267], ys: run(0, 16, 16), size: 512,
    });

    // Each PROM gives 4 bits through 220/470/1K/2.2K-ish weights.
    const level = (v) => 0x0E * (v & 1) + 0x1F * ((v >> 1) & 1) + 0x43 * ((v >> 2) & 1) + 0x8F * ((v >> 3) & 1);
    const base = Uint32Array.from({ length: 256 }, (_, i) => rgba(level(roms.red[i]), level(roms.green[i]), level(roms.blue[i])));
    // Chars use colors 80-8F, tiles 00-3F (16 per bank), sprites 40-4F.
    this.charPal = Uint32Array.from(roms.charLut, (v) => base[0x80 | (v & 15)]);
    this.tilePal = Uint32Array.from({ length: 4 * 256 }, (_, i) => base[((i >> 8) << 4) | (roms.tileLut[i & 0xFF] & 15)]);
    this.spritePal = Uint32Array.from(roms.spriteLut, (v) => base[0x40 | (v & 15)]);

    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.fgRam.fill(0); this.bgRam.fill(0); this.spriteRam.fill(0); this.soundRam.fill(0);
    this.bank = 0; this.scroll = 0; this.palBank = 0; this.latch = 0; this.soundReset = false;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sndCpu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x8000) return this.roms.main[a];
    if (a < 0xC000) return this.roms.banks[this.bank * 0x4000 + (a - 0x8000)] ?? 0xFF;
    if (a >= 0xE000 && a < 0xF000) return this.ram[a - 0xE000];
    if (a >= 0xD000 && a < 0xD800) return this.fgRam[a - 0xD000];
    if (a >= 0xD800 && a < 0xDC00) return this.bgRam[a - 0xD800];
    if (a >= 0xCC00 && a < 0xCC80) return this.spriteRam[a - 0xCC00];
    switch (a) {
      case 0xC000: return this.in0;
      case 0xC001: return this.in1;
      case 0xC002: return 0xFF;
      case 0xC003: return this.dswA;
      case 0xC004: return this.dswB;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0xE000 && a < 0xF000) this.ram[a - 0xE000] = v;
    else if (a >= 0xD000 && a < 0xD800) this.fgRam[a - 0xD000] = v;
    else if (a >= 0xD800 && a < 0xDC00) this.bgRam[a - 0xD800] = v;
    else if (a >= 0xCC00 && a < 0xCC80) this.spriteRam[a - 0xCC00] = v;
    else switch (a) {
      case 0xC800: this.latch = v; break;
      case 0xC802: this.scroll = (this.scroll & 0xFF00) | v; break;
      case 0xC803: this.scroll = (this.scroll & 0xFF) | (v << 8); break;
      case 0xC804:                               // bit 4 holds the sound CPU in reset; bit 7 flip (unused upright)
        this.soundReset = !!(v & 0x10);
        if (this.soundReset) this.sndCpu.reset();
        break;
      case 0xC805: this.palBank = v & 3; break;
      case 0xC806: this.bank = v & 3; break;
    }
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x4000) return this.roms.sound[a];
    if (a >= 0x4000 && a < 0x4800) return this.soundRam[a - 0x4000];
    if (a === 0x6000) return this.latch;
    return 0xFF;
  }

  soundWrite(a, v) {
    if (a >= 0x4000 && a < 0x4800) { this.soundRam[a - 0x4000] = v; return; }
    const chip = a === 0x8000 || a === 0x8001 ? this.ay[0] : a === 0xC000 || a === 0xC001 ? this.ay[1] : null;
    if (!chip) return;
    if (a & 1) chip.write(v); else chip.select(v);
  }

  // ---------------------------------------------------------------- inputs

  // Active low. IN0: start 1, start 2, coin. IN1: right, left, down, up, fire, loop.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.start1 ? 0x01 : 0) | (s.start2 ? 0x02 : 0) | (s.coin ? 0x80 : 0));
    this.in1 = 0xFF & ~((s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.down ? 0x04 : 0) | (s.up ? 0x08 : 0)
      | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0));
  }
  // DSWA: 1 coin 1 credit, upright, bonus, lives. DSWB: 1 coin 1 credit,
  // service off, no flip, difficulty, freeze off.
  applySwitches(v) {
    this.dswA = 0x07 | v.bonus | v.lives;
    this.dswB = 0x07 | 0x08 | 0x10 | v.difficulty | 0x80;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === 112) { this.cpu.irqVector = 0xCF; this.cpu.irq = true; }      // RST 08
      if (line === 240) { this.cpu.irqVector = 0xD7; this.cpu.irq = true; this.render(); }   // RST 10: vblank
      if (!this.soundReset && line % 66 === 0) this.sndCpu.irq = true;           // four a frame
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.soundCarry += SOUND_LINE_CYCLES;
      if (this.soundReset) this.soundCarry = 0;
      else this.soundCarry -= this.sndCpu.run(Math.floor(this.soundCarry));
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, bg = this.bgRam, fg = this.fgRam;

    // Background: 32 columns of 16 tiles, 512 pixels across, scrolling
    // sideways (upward on the vertical monitor). Attribute: code bit 8,
    // flips, color.
    const palBase = this.palBank * 256;
    for (let y = 0; y < H; y++) {
      const ty = y + TOP;
      for (let x = 0; x < W; x++) {
        const tx = (x + this.scroll) & 0x1FF;
        const o = (tx >> 4) * 32 + (ty >> 4), attr = bg[o + 16];
        let px = tx & 15, py = ty & 15;
        if (attr & 0x20) px = 15 - px;
        if (attr & 0x40) py = 15 - py;
        const pen = this.tilePix[(bg[o] + ((attr & 0x80) << 1)) * 256 + py * 16 + px];
        out[y * W + x] = this.tilePal[palBase + (attr & 0x1F) * 8 + pen];
      }
    }

    // Sprites, last to first: code, attributes (code bits, height, x bit 8,
    // color), y, x. Pen 15 is see-through.
    const spr = this.spriteRam;
    for (let offs = 0x7C; offs >= 0; offs -= 4) {
      const b0 = spr[offs], b1 = spr[offs + 1];
      const code = (b0 & 0x7F) + 4 * (b1 & 0x20) + 2 * (b0 & 0x80), color = (b1 & 15) * 16;
      const sx = spr[offs + 3] - 16 * (b1 & 0x10), sy = spr[offs + 2] - TOP;
      let n = (b1 & 0xC0) >> 6;
      if (n === 2) n = 3;
      for (; n >= 0; n--) {
        const top = sy + 16 * n, src = (code + n) * 256;
        for (let y = 0; y < 16; y++) {
          const py = top + y;
          if (py < 0 || py >= H) continue;
          for (let x = 0; x < 16; x++) {
            const px = sx + x;
            if (px < 0 || px >= W) continue;
            const pen = this.spritePix[src + y * 16 + x];
            if (pen !== 15) out[py * W + px] = this.spritePal[color + pen];
          }
        }
      }
    }

    // Text layer: code bit 8 and color in the color byte; pen 0 see-through.
    for (let row = 2; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const i = row * 32 + col, c = fg[0x400 + i];
        const src = (fg[i] + ((c & 0x80) << 1)) * 64, color = (c & 0x3F) * 4;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y - TOP) * W + col * 8;
          for (let x = 0; x < 8; x++, o++) {
            const pen = this.charPix[src + y * 8 + x];
            if (pen) out[o] = this.charPal[color + pen];
          }
        }
      }
    }

    rotate270(out, W, H, this.frame);
  }
}

C1942.id = '1942';
C1942.title = '1942';
C1942.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x80], ['2', 0x40], ['3', 0xC0], ['5', 0x00]], default: 0xC0 },
  { id: 'bonus', label: 'Bonus', options: [['20K/80K', 0x30], ['20K/100K', 0x20], ['30K/80K', 0x10], ['30K/100K', 0x00]], default: 0x30 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x40], ['Normal', 0x60], ['Difficult', 0x20], ['Very difficult', 0x00]], default: 0x60 },
];
