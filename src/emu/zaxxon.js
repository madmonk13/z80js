// Sega Zaxxon (1982): a Z80 at 3.04 MHz and the first isometric shooter. The
// background is a long map (32 x 512 tiles) in ROM; the hardware scrolls it
// and shears each line sideways by half the line number, which turns a
// plain scrolling map into the diagonal fortress. 32x32 sprites go on top,
// then a layer of 8x8 text colored per 4-row block. The sound effects were
// analog circuits triggered through an 8255 PPI's three ports; MAME plays
// recordings of them, which aren't in the ROM set, so small synthesized
// stand-ins play here.
//
// 60 Hz; the visible picture is 256x224 on a vertical monitor.

import { Z80 } from './z80.js';
import { RATE } from './mixer.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16;
const LINES = 264, LINE_CYCLES = 48660000 / 16 / 60 / LINES, VBLANK_LINE = 240;
const SAMPLES_PER_LINE = RATE / 60 / LINES;
const STATE = ['ram', 'vram', 'sprites', 'bgPos', 'bgEnable', 'bgColor', 'flip', 'irqEnable', 'coinPulse', 'coinWas',
  'cycleCarry', 'sampleCarry', 'in0', 'in2', 'cpu', 'sound'];

// Resistor weights (1K/470/220 for red and green, 470/220 for blue), scaled
// so all bits on is full brightness.
function weights(rs) { const g = rs.map((r) => 1 / r), sum = g.reduce((a, b) => a + b); return g.map((x) => (255 * x) / sum); }
const WRG = weights([1000, 470, 220]), WB = weights([470, 220]);
const level = (v, w, bits) => Math.round(bits.reduce((acc, b, k) => acc + (((v >> b) & 1) ? w[k] : 0), 0));

// ---------------------------------------------------------------- sound

// Port bits are active low. A: 0-1 ship engine volume, 2/3 ship engine,
// 4 homing missile, 5 base missile, 6 laser, 7 battleship. B: 4 small
// explosion, 5 big explosion, 7 cannon. C: 0 shot, 2/3 alarms.
const VOICES = 9;
class ZaxxonSound {
  constructor() { this.buffer = new Float32Array(1 << 15); this.rate = RATE; this.reset(); }
  saveState() { return capture(this, ['ports', 'env', 'phase', 't', 'noise', 'lp', 'dcIn', 'dcOut']); }
  loadState(s) { apply(this, ['ports', 'env', 'phase', 't', 'noise', 'lp', 'dcIn', 'dcOut'], s); }
  reset() {
    this.ports = Uint8Array.from([0xFF, 0xFF, 0xFF]);
    // 0 engine, 1 homing, 2 base missile, 3 laser, 4 battleship, 5 small exp, 6 big exp, 7 cannon/shot, 8 alarm
    this.env = new Float64Array(VOICES); this.phase = new Float64Array(VOICES); this.t = new Float64Array(VOICES);
    this.noise = 1; this.lp = new Float64Array(3); this.dcIn = this.dcOut = 0;
    this.writePos = this.readPos = 0;
  }
  start(n) { this.env[n] = 1; this.t[n] = 0; }
  write(port, v) {
    const fell = this.ports[port] & ~v;
    this.ports[port] = v;
    if (port === 1) { if (fell & 0x10) this.start(5); if (fell & 0x20) this.start(6); if (fell & 0x80) this.start(7); }
    if (port === 2) { if (fell & 0x01) this.start(7); if (fell & 0x0C) this.start(8); }
    if (port === 0 && fell & 0x20) this.start(2);
  }
  sample() {
    const dt = 1 / RATE, a = this.ports[0], env = this.env, ph = this.phase, t = this.t;
    for (let i = 0; i < 3; i++) this.noise = (this.noise >> 1) | ((((this.noise) ^ (this.noise >> 3)) & 1) << 16);
    const white = (this.noise & 1) * 2 - 1;
    let s = 0;
    // Engine: filtered noise while either engine bit is low, louder with the volume bits.
    if (!(a & 0x0C)) {
      this.lp[0] += (white - this.lp[0]) * 0.02;
      s += this.lp[0] * (0.6 + 0.3 * (a & 3));
    }
    // Homing missile, laser, battleship: held tones while their bits are low.
    if (!(a & 0x10)) { ph[1] = (ph[1] + (700 + 200 * Math.sin(t[1] * 30)) * dt) % 1; s += ph[1] < 0.5 ? 0.12 : -0.12; t[1] += dt; }
    if (!(a & 0x40)) { ph[3] = (ph[3] + 1800 * dt) % 1; s += ph[3] < 0.5 ? 0.1 : -0.1; }
    if (!(a & 0x80)) { ph[4] = (ph[4] + 90 * dt) % 1; s += ph[4] < 0.5 ? 0.15 : -0.15; }
    // Base missile: a falling whistle.
    if (env[2] > 0.001) { ph[2] = (ph[2] + 1500 * Math.exp(-t[2] * 2) * dt) % 1; s += env[2] * (ph[2] < 0.5 ? 0.15 : -0.15); env[2] *= Math.exp(-dt / 0.6); t[2] += dt; }
    // Explosions: decaying noise, the big one lower and longer.
    if (env[5] > 0.001) { this.lp[1] += (white - this.lp[1]) * 0.2; s += env[5] * this.lp[1] * 0.8; env[5] *= Math.exp(-dt / 0.15); }
    if (env[6] > 0.001) { this.lp[2] += (white - this.lp[2]) * 0.04; s += env[6] * this.lp[2] * 1.6; env[6] *= Math.exp(-dt / 0.6); }
    // Shot / cannon: a short falling zap.
    if (env[7] > 0.001) { ph[7] = (ph[7] + 2500 * Math.exp(-t[7] * 15) * dt) % 1; s += env[7] * (ph[7] < 0.5 ? 0.2 : -0.2); env[7] *= Math.exp(-dt / 0.08); t[7] += dt; }
    // Alarm: a two-tone beep.
    if (env[8] > 0.001) { ph[8] = (ph[8] + ((t[8] * 8) % 2 < 1 ? 900 : 1200) * dt) % 1; s += env[8] * (ph[8] < 0.5 ? 0.12 : -0.12); env[8] = t[8] < 1 ? 1 : 0; t[8] += dt; }
    const out = s * 0.6 - this.dcIn + 0.995 * this.dcOut;
    this.dcIn = s * 0.6; this.dcOut = out;
    const mask = this.buffer.length - 1;
    this.buffer[this.writePos] = out;
    this.writePos = (this.writePos + 1) & mask;
    if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
  }
  available() { return (this.writePos - this.readPos) & (this.buffer.length - 1); }
  pull(out, outRate) {
    const buf = this.buffer, mask = buf.length - 1, step = RATE / outRate;
    if (this.available() > RATE * 0.075) this.readPos = (this.writePos - Math.floor(RATE * 0.035)) & mask;
    let pos = this.frac || 0, last = this.last || 0;
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) { out[i] = last *= 0.995; continue; }
      const s0 = buf[this.readPos], s1 = buf[(this.readPos + 1) & mask];
      last = out[i] = s0 + (s1 - s0) * pos;
      pos += step;
      while (pos >= 1 && this.available() > 1) { pos -= 1; this.readPos = (this.readPos + 1) & mask; }
    }
    this.frac = pos; this.last = last;
  }
}

// ---------------------------------------------------------------- board

export class Zaxxon {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 20K, chars 4K, tiles 24K, sprites 24K, map 32K, palette 256, colors 256 }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = 60;
    this.controls = 'eight-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x1000);         // 6000-6FFF
    this.vram = new Uint8Array(0x400);         // 8000-83FF
    this.sprites = new Uint8Array(0x100);      // A000-A0FF
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sound = new ZaxxonSound();

    this.charPix = decodeTiles(roms.chars, { count: 256, width: 8, height: 8, planes: [0x800 * 8, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    const third = roms.tiles.length / 3 * 8;
    this.tilePix = decodeTiles(roms.tiles, { count: 1024, width: 8, height: 8, planes: [third * 2, third, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    const sthird = roms.sprites.length / 3 * 8;
    this.spritePix = decodeTiles(roms.sprites, {
      count: 64, width: 32, height: 32, planes: [sthird * 2, sthird, 0],
      xs: [...run(0, 8), ...run(64, 8), ...run(128, 8), ...run(192, 8)],
      ys: [...run(0, 8, 8), ...run(256, 8, 8), ...run(512, 8, 8), ...run(768, 8, 8)], size: 1024,
    });
    this.palette = Uint32Array.from(roms.palette, (v) => rgba(level(v, WRG, [0, 1, 2]), level(v, WRG, [3, 4, 5]), level(v, WB, [6, 7])));
    // The background map, pre-rendered: 256 x 4096 pens (plus color, as palette index).
    this.bgMap = this.buildBackground(roms.map);
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.in0 = 0; this.in2 = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  buildBackground(map) {
    const size = map.length / 2, out = new Uint8Array(256 * 4096);
    for (let row = 0; row < 512; row++) {
      for (let col = 0; col < 32; col++) {
        const i = row * 32 + col, attr = map[i + size];
        const code = map[i] + 256 * (attr & 3), color = (attr >> 4) * 8;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) out[(row * 8 + y) * 256 + col * 8 + x] = color + this.tilePix[code * 64 + y * 8 + x];
        }
      }
    }
    return out;
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.sprites.fill(0);
    this.bgPos = 0; this.bgEnable = 0; this.bgColor = 0; this.flip = 0; this.irqEnable = false;
    this.coinPulse = 0; this.coinWas = false;
    this.cycleCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x6000) return this.roms.main[a] ?? 0xFF;
    if (a < 0x7000) return this.ram[a - 0x6000];
    if (a >= 0x8000 && a < 0xA000) return this.vram[a & 0x3FF];
    if (a >= 0xA000 && a < 0xC000) return this.sprites[a & 0xFF];
    if (a >= 0xC000 && a < 0xE000) {
      if ((a & 0x100) === 0x100) return this.in2 | (this.coinPulse ? 0x20 : 0);
      switch (a & 3) { case 0: return this.in0; case 1: return 0; case 2: return this.dsw0; default: return this.dsw1; }
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x6000 && a < 0x7000) { this.ram[a - 0x6000] = v; return; }
    if (a >= 0x8000 && a < 0xA000) { this.vram[a & 0x3FF] = v; return; }
    if (a >= 0xA000 && a < 0xC000) { this.sprites[a & 0xFF] = v; return; }
    if (a >= 0xC000 && a < 0xE000) { if ((a & 7) === 6) this.flip = ~v & 1; return; }
    if (a >= 0xE000) {
      const r = a & 0xFF;
      if (r >= 0x3C && r <= 0x3E) this.sound.write(r - 0x3C, v);           // PPI ports A-C
      else if (r === 0x3F && !(v & 0x80)) {                                 // PPI: set/reset a port C bit
        const bit = 1 << ((v >> 1) & 7), c = this.sound.ports[2];
        this.sound.write(2, v & 1 ? c | bit : c & ~bit);
      } else if (r === 0xF0) { this.irqEnable = !!(v & 1); if (!this.irqEnable) this.cpu.irq = false; }
      else if (r === 0xF8) this.bgPos = (this.bgPos & 0x700) | v;
      else if (r === 0xF9) this.bgPos = (this.bgPos & 0xFF) | ((v << 8) & 0x700);
      else if (r === 0xFA) this.bgColor = (v & 1) * 0x80;
      else if (r === 0xFB) this.bgEnable = v & 1;
    }
  }

  // ---------------------------------------------------------------- inputs

  // SW00: right, left, down, up, fire. SW100: start 1, start 2, coin (a one-frame pulse).
  setInputs(s) {
    this.in0 = (s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.down ? 0x04 : 0) | (s.up ? 0x08 : 0) | (s.fire ? 0x10 : 0);
    this.in2 = (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0);
    if (s.coin && !this.coinWas) this.coinPulse = 2;
    this.coinWas = !!s.coin;
  }
  // DSW02: bonus, lives, demo sounds on, upright. DSW03: 1 coin 1 credit.
  applySwitches(v) { this.dsw0 = v.bonus | v.lives | 0x40; this.dsw1 = 0x33; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    if (this.coinPulse) this.coinPulse--;
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) { this.render(); if (this.irqEnable) this.cpu.irq = true; }
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, pal = this.palette, fm = this.flip ? 0xFF : 0;
    // Background: each line's source row comes from the scroll position, and
    // its start is sheared by half the line number (the isometric slant).
    if (this.bgEnable) {
      const bg = this.bgMap, base = this.bgColor, offs = this.flip ? 0x3F : 0x3F;
      for (let y = 0; y < H; y++) {
        const vf = (y + TOP) ^ fm;
        const srcy = (vf + ((this.bgPos << 1) ^ 0xFFF) + 1) & 0xFFF;
        const shear = ((vf >> 1) ^ 0xFF) + 1 + offs;
        for (let x = 0; x < W; x++) out[y * W + x] = pal[base + bg[srcy * 256 + (((x ^ fm) + shear) & 0xFF)]];
      }
    } else out.fill(pal[0] & 0xFF000000);

    // Sprites, last to first: y, code (bits 6/7 flips), color, x.
    const spr = this.sprites;
    const minY = (v) => {
      const fc = this.flip ? 0xEF : 0xF1;
      let y = 0;
      for (; y < 256; y += 16) if ((((v + fc + 1) + (y ^ fm)) & 0xE0) === 0xE0) break;
      while (((((v + fc + 1) + ((y - 1) ^ fm)) & 0xE0) === 0xE0)) y--;
      return (y + 1) & 0xFF;
    };
    for (let offs = 0x7C; offs >= 0; offs -= 4) {
      const c = spr[offs + 1], code = c & 0x3F, color = (spr[offs + 2] & 0x1F) * 8;
      const flipX = (c ^ fm) & 0x40, flipY = (c ^ fm) & 0x80;
      const sy = minY(spr[offs]);
      let sx = ((spr[offs + 3] + 0xF0) ^ fm) & 0xFF;
      if (fm) sx = (sx - 31) & 0xFF;
      for (let y = 0; y < 32; y++) {
        const py = ((sy + y) & 0xFF) - TOP;
        if (py < 0 || py >= H) continue;
        const row = code * 1024 + (flipY ? 31 - y : y) * 32;
        for (let x = 0; x < 32; x++) {
          const px = (sx + x) & 0xFF;
          const pen = this.spritePix[row + (flipX ? 31 - x : x)];
          if (pen) out[py * W + px] = pal[color + pen];
        }
      }
    }

    // Text: color per column and 4-row block, from the second PROM; pen 0 see-through.
    const codes = this.roms.colors, vram = this.vram;
    for (let row = 2; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const color = (codes[col + 32 * (row >> 2)] & 0x0F) * 8, src = vram[row * 32 + col] * 64;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y - TOP) * W + col * 8;
          for (let x = 0; x < 8; x++, o++) {
            const pen = this.charPix[src + y * 8 + x];
            if (pen) out[o] = pal[color + pen];
          }
        }
      }
    }
    rotate90(out, W, H, this.frame);
  }
}

Zaxxon.id = 'zaxxon';
Zaxxon.title = 'Zaxxon';
Zaxxon.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x30], ['4', 0x10], ['5', 0x20]], default: 0x30 },
  { id: 'bonus', label: 'Bonus', options: [['10K', 0x03], ['20K', 0x01], ['30K', 0x02], ['40K', 0x00]], default: 0x03 },
];
