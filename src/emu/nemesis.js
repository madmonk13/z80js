// Konami Nemesis hardware as used by Salamander (1986): a 68000 at 9.2 MHz
// with no graphics ROMs at all: the program uploads every tile and sprite
// into 64K of character RAM (4 bits a pixel, two pixels a byte). Two 64x32
// maps of 8x8 tiles scroll per line horizontally and per column vertically;
// each tile picks one of two priority groups and whether its pen 0 is
// transparent. Up to 256 sprites from 8x8 to 64x64, zoomable, sorted by a
// priority byte. 2048 colors of xBBBBBGGGGGRRRRR, each held in the low bytes
// of two words.
//
// Sound: a Z80 with a YM2151, a K007232 (sample volumes from its port) and a
// VLM5030 speaking from its own ROM. 256x224 at 60.6 Hz.

import { M68000 } from './m68000.js';
import { Z80 } from './z80.js';
import { YM2151 } from './ym2151.js';
import { K007232 } from './k007232.js';
import { VLM5030 } from './vlm5030.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16, LINES = 264, VBLANK = 240, REFRESH = 18432000 / 4 / (288 * 264);
const CPU_CLOCK = 18432000 / 2, SOUND_CLOCK = 3579545;
// Sprite sizes by bits 3-5 of the size byte.
const SIZES = [[32, 32], [16, 32], [32, 16], [64, 64], [8, 8], [16, 8], [8, 16], [16, 16]];
const STATE = ['ram', 'palRam', 'vram', 'charRam', 'spriteRam', 'scrollRam', 'soundRam', 'irqOn', 'latch', 'wd',
  'in', 'cycleCarry', 'soundCarry', 'sampleCarry', 'cpu', 'snd', 'ym', 'k007232', 'vlm'];

export class Salamander {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 2048; i++) this.setColor(i); }

  // roms: { main (68000, big-endian), sound (Z80), speech (VLM5030), samples (K007232) }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Missile';
    this.roms = roms;
    this.ram = new Uint16Array(0x4000);          // 080000-087FFF
    this.palRam = new Uint16Array(0x1000);       // 090000-091FFF
    this.vram = new Uint16Array(0x2000);         // 100000-103FFF: codes (back, front), colors (back, front)
    this.charRam = new Uint16Array(0x8000);      // 120000-12FFFF
    this.spriteRam = new Uint16Array(0x800);     // 180000-180FFF
    this.scrollRam = new Uint16Array(0x1000);    // 190000-191FFF
    this.soundRam = new Uint8Array(0x800);
    this.palette = new Uint32Array(2048).fill(0xFF000000);

    this.cpu = new M68000({
      read8: (a) => this.read8(a), read16: (a) => this.read16(a),
      write8: (a, v) => this.write8(a, v), write16: (a, v) => this.write16(a, v),
    });
    this.cpu.onIrqAck = () => { this.cpu.irq = 0; };
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.ym = new YM2151(SOUND_CLOCK, 1);
    this.k007232 = new K007232(SOUND_CLOCK, roms.samples, 0.3);
    this.k007232.onPort = (v) => { this.k007232.setVolume(0, (v >> 4) / 15); this.k007232.setVolume(1, (v & 15) / 15); };
    this.vlm = new VLM5030(SOUND_CLOCK, roms.speech, 0.6);
    this.sound = new SoundMix([this.ym, this.k007232, this.vlm], 1);
    this.frame = new Uint32Array(W * H);
    this.in = new Uint8Array(3);
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.palRam, this.vram, this.charRam, this.spriteRam, this.scrollRam, this.soundRam]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.irqOn = 0; this.latch = 0; this.wd = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.ym.reset(); this.k007232.reset(); this.vlm.reset(); this.sound.reset();
  }

  // A color's two words: the first's low byte is the high half.
  setColor(i) {
    const d = ((this.palRam[i * 2] & 0xFF) << 8) | (this.palRam[i * 2 + 1] & 0xFF), c5 = (v) => ((v & 31) << 3) | ((v & 31) >> 2);
    this.palette[i] = rgba(c5(d), c5(d >> 5), c5(d >> 10));
  }

  // The word RAMs by address: [start, words, array].
  region(a) {
    if (a >= 0x080000 && a < 0x088000) return [this.ram, (a - 0x080000) >> 1];
    if (a >= 0x100000 && a < 0x104000) return [this.vram, (a - 0x100000) >> 1];
    if (a >= 0x120000 && a < 0x130000) return [this.charRam, (a - 0x120000) >> 1];
    if (a >= 0x180000 && a < 0x181000) return [this.spriteRam, (a - 0x180000) >> 1];
    if (a >= 0x190000 && a < 0x192000) return [this.scrollRam, (a - 0x190000) >> 1];
    if (a >= 0x090000 && a < 0x092000) return [this.palRam, (a - 0x090000) >> 1];
    return null;
  }

  read16(a) {
    a &= 0xFFFFFE;
    if (a < 0x80000) return (this.roms.main[a] << 8) | this.roms.main[a + 1];
    const r = this.region(a);
    if (r) return r[0][r[1]];
    switch (a) {
      case 0x0C0002: return 0xFF;                 // DSW0: 1 coin 1 credit
      case 0x0C2000: return this.in[0];
      case 0x0C2002: return this.in[1];
      case 0x0C2004: return this.in[2];
      case 0x0C2006: return this.dsw1;
    }
    return 0xFFFF;
  }
  read8(a) { const w = this.read16(a & ~1); return a & 1 ? w & 0xFF : w >> 8; }

  write16(a, v) {
    a &= 0xFFFFFE;
    const r = this.region(a);
    if (r) { r[0][r[1]] = v; if (r[0] === this.palRam) this.setColor(r[1] >> 1); return; }
    if (a === 0x0A0000) this.irqOn = v & 0xFF;
    else if (a === 0x0C0000) { this.latch = v & 0xFF; this.snd.irq = true; }
  }
  write8(a, v) {
    const r = this.region(a & ~1);
    if (r) {
      const w = r[0][r[1]];
      r[0][r[1]] = a & 1 ? (w & 0xFF00) | v : (w & 0xFF) | (v << 8);
      if (r[0] === this.palRam) this.setColor(r[1] >> 1);
      return;
    }
    if ((a & ~1) === 0x0A0000 && a & 1) this.irqOn = v;
    else if (a === 0x0C0001) { this.latch = v; this.snd.irq = true; }
  }

  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0x8800) return this.soundRam[a - 0x8000];
    if (a === 0xA000) return this.latch;
    if (a >= 0xB000 && a < 0xB00E) return this.k007232.read(a & 15);
    if (a === 0xC001) return this.ym.read();
    if (a === 0xE000) { this.wd ^= 1; return this.wd; }
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0x8000 && a < 0x8800) this.soundRam[a - 0x8000] = v;
    else if (a >= 0xB000 && a < 0xB00E) this.k007232.write(a & 15, v);
    else if (a === 0xC000) this.ym.select(v);
    else if (a === 0xC001) this.ym.write(v);
    else if (a === 0xD000) this.vlm.write(v);
    else if (a === 0xF000) { this.vlm.setSt(1); this.vlm.setSt(0); }
  }

  // IN0: coin, starts (active high), flip and service off. IN1: left, right, up, down, fire, missile.
  setInputs(s) {
    this.in[0] = 0xE0 | (s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0);
    this.in[1] = (s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0) | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0);
    this.in[2] = 0;
  }
  // DSW1: lives, two coin slots, max credits 9, difficulty, demo sounds on.
  applySwitches(v) { this.dsw1 = v.lives | v.difficulty; }

  runFrame() {
    const main = CPU_CLOCK / REFRESH / LINES, snd = SOUND_CLOCK / REFRESH / LINES, samples = RATE / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK) { this.render(); if (this.irqOn) this.cpu.irq = 1; }
      this.cycleCarry += main;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.ym.timers(1 / REFRESH / LINES);
      this.soundCarry += snd;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // One 4-bit pixel from character RAM (two pixels a byte, rows packed).
  pixel(byteAddr, x) {
    const a = (byteAddr + (x >> 1)) & 0xFFFF, w = this.charRam[a >> 1], b = a & 1 ? w & 0xFF : w >> 8;
    return x & 1 ? b & 15 : b >> 4;
  }

  render() {
    const out = this.frame, pal = this.palette, v = this.vram, sc = this.scrollRam;
    // Layer A ("back": codes 101000, colors 103000) scrolls by 190400/190F00; layer B ("front": 100000/102000) by 190000/190F80.
    const layers = [
      { codes: 0x800, colors: 0x1800, xs: 0x200, ys: 0x780 },
      { codes: 0x000, colors: 0x1000, xs: 0x000, ys: 0x7C0 },
    ];
    const res = [0, 0];
    for (let y = 0; y < H; y++) {
      const line = y + TOP;
      for (let x = 0; x < W; x++) {
        // Draw order: B group 0, A group 0, B group 1, A group 1.
        let best = -1, color = 0;
        for (let l = 0; l < 2; l++) {
          const L = layers[l];
          const sx = (sc[L.xs + line] & 0xFF) + ((sc[L.xs + 0x100 + line] & 1) << 8);
          const tx = (x + sx) & 511, col = tx >> 3, ty = (line + sc[L.ys + col]) & 255;
          const i = (ty >> 3) * 64 + col, code = v[L.codes + i];
          res[l] = -1;
          if (!(code & 0xF800)) continue;
          const attr = v[L.colors + i], px = attr & 0x80 ? 7 - (tx & 7) : tx & 7, py = code & 0x800 ? 7 - (ty & 7) : ty & 7;
          const pen = this.pixel((code & 0x7FF) * 32 + py * 4, px);
          const opaque = !(code & 0x2000) || (code & 0xC000) === 0x4000;
          if (!pen && !opaque) continue;
          const rank = ((code >> 12) & 1) * 2 + (l === 0 ? 1 : 0);
          if (rank > best) { best = rank; color = (attr & 0x7F) * 16 + pen; }
        }
        out[y * W + x] = pal[best < 0 ? 0 : color];
      }
    }
    this.drawSprites(out);
  }

  // Sprites: 8 words each; higher priority bytes in front, then later entries; the first drawn at a pixel wins.
  drawSprites(out) {
    const s = this.spriteRam, pal = this.palette, taken = this.taken || (this.taken = new Uint8Array(W * H));
    taken.fill(0);
    const order = [];
    for (let a = s.length - 8; a >= 0; a -= 8) order.push(a);
    order.sort((p, q) => (s[q] & 0xFF) - (s[p] & 0xFF));     // stable: equal priorities keep high-to-low addresses
    for (const a of order) {
      let zoom = s[a + 2] & 0xFF;
      let code = !(s[a + 2] & 0xFF00) && (s[a + 3] & 0xFF00) !== 0xFF00 ? s[a + 3] : s[a + 3] & 0xFF;
      code += (s[a + 4] & 0xC0) << 2;
      if (zoom === 0xFF && !code) continue;
      const size = s[a + 1];
      zoom += (size & 0xC0) << 2;
      if (!zoom) continue;
      let sx = s[a + 5] & 0xFF;
      const sy = (s[a + 6] & 0xFF) - TOP;
      if (s[a + 4] & 1) sx -= 0x100;
      const color = ((s[a + 4] & 0x1E) >> 1) * 16, fx = s[a + 1] & 1, fy = s[a + 4] & 0x20;
      const [w, h] = SIZES[(size >> 3) & 7];
      const tile = Math.floor(code * 128 / (w * h)), base = tile * (w * h / 2);
      const scale = Math.floor(0x10000 * 0x80 / zoom) + 0x2AB;
      const dw = (w * scale + 0x8000) >> 16, dh = (h * scale + 0x8000) >> 16;
      for (let dy = 0; dy < dh; dy++) {
        const py = sy + dy;
        if (py < 0 || py >= H) continue;
        let ry = Math.floor(dy * h / dh);
        if (fy) ry = h - 1 - ry;
        const row = base + ry * (w / 2);
        for (let dx = 0; dx < dw; dx++) {
          const px = sx + dx;
          if (px < 0 || px >= W || taken[py * W + px]) continue;
          let rx = Math.floor(dx * w / dw);
          if (fx) rx = w - 1 - rx;
          const pen = this.pixel(row, rx);
          if (!pen) continue;
          out[py * W + px] = pal[color + pen];
          taken[py * W + px] = 1;
        }
      }
    }
  }
}
Salamander.id = 'salamand';
Salamander.title = 'Salamander';
Salamander.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x03], ['3', 0x02], ['5', 0x01], ['7', 0x00]], default: 0x02 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Hardest', 0x00]], default: 0x40 },
];
