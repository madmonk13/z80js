// Taito The Legend of Kage (1984): a Z80 at 6 MHz runs the game, a second Z80
// plays music on two YM2203s, and a 68705 microcontroller talks to the main
// CPU through a pair of latches. The main CPU also reads a 16K data ROM
// through its I/O ports (4000-7FFF).
//
// Video: three 32x32 maps of 8x8 tiles (background, foreground, text), each
// scrolling, and 24 sprites of 16x16 or 16x32, all at 4 bits per pixel; a
// 1024-color palette in RAM (4 bits per gun). A sprite's priority bit puts it
// behind the foreground. 240x224 shown.

import { Z80 } from './z80.js';
import { M6805 } from './m6805.js';
import { YM2203 } from './ym2203.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 240, H = 224, LEFT = 16, TOP = 16;
const LINES = 256, REFRESH = 60;

const STATE = ['ram', 'pal', 'vreg', 'scroll', 'sprites', 'vram', 'soundRam', 'mcuRam', 'latch', 'nmiOn', 'nmiPending',
  'fromMain', 'fromMcu', 'mainSent', 'mcuSent', 'portA', 'portB', 'portC', 'ddr', 'portAIn',
  'cycleCarry', 'zCarry', 'mCarry', 'sampleCarry', 'svc', 'in1', 'cpu', 'snd', 'mcu', 'ym'];

export class LegendOfKage {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 1024; i++) this.setColor(i); }

  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Jump';
    this.roms = roms;
    this.ram = new Uint8Array(0x800);
    this.pal = new Uint8Array(0x800);
    this.vreg = new Uint8Array(4);
    this.scroll = new Uint8Array(6);
    this.sprites = new Uint8Array(0x60);
    this.vram = new Uint8Array(0xC00);
    this.soundRam = new Uint8Array(0x800);
    this.mcuRam = new Uint8Array(0x80);
    this.ddr = new Uint8Array(3);
    this.palette = new Uint32Array(1024).fill(0xFF000000);
    this.frame = new Uint32Array(W * H);
    this.pri = new Uint8Array(W * H);

    const q = roms.gfx.length / 4 * 8;
    this.tilePix = decodeTiles(roms.gfx, { count: roms.gfx.length / 32, width: 8, height: 8, planes: [q, 0, 3 * q, 2 * q], xs: [7, 6, 5, 4, 3, 2, 1, 0], ys: run(0, 8, 8), size: 64 });
    this.spritePix = decodeTiles(roms.gfx, {
      count: roms.gfx.length / 128, width: 16, height: 16, planes: [q, 0, 3 * q, 2 * q],
      xs: [7, 6, 5, 4, 3, 2, 1, 0, 71, 70, 69, 68, 67, 66, 65, 64], ys: [...run(0, 8, 8), ...run(128, 8, 8)], size: 256,
    });

    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v), input: (p) => this.input(p) });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.snd = new Z80({ read: (a) => this.sRead(a), write: (a, v) => this.sWrite(a, v) });
    this.mcu = new M6805({ read: (a) => this.mRead(a), write: (a, v) => this.mWrite(a, v) });
    this.ym = [new YM2203(4000000, 0.8), new YM2203(4000000, 0.8)];
    this.sound = new SoundMix(this.ym, 0.8);
    this.svc = 0xCB; this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.pal, this.vreg, this.scroll, this.sprites, this.vram, this.soundRam, this.mcuRam, this.ddr]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.latch = 0; this.nmiOn = 0; this.nmiPending = 0;
    this.fromMain = 0; this.fromMcu = 0; this.mainSent = 0; this.mcuSent = 0;
    this.portA = 0; this.portB = 0; this.portC = 0; this.portAIn = 0;
    this.cycleCarry = this.zCarry = this.mCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.mcu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0xE000) return this.roms.main[a];
    if (a < 0xE800) return this.ram[a - 0xE000];
    if (a < 0xF000) return this.pal[a - 0xE800];
    if (a < 0xF004) return this.vreg[a - 0xF000];
    if (a >= 0xF0C0 && a < 0xF0C6) return this.scroll[a - 0xF0C0];
    if (a >= 0xF100 && a < 0xF160) return this.sprites[a - 0xF100];
    if (a >= 0xF400) return this.vram[(a - 0xF400) % 0xC00];
    switch (a) {
      case 0xF062: this.mcuSent = 0; return this.fromMcu;
      case 0xF080: return this.dsw[0];
      case 0xF081: return this.dsw[1];
      case 0xF082: return this.dsw[2];
      case 0xF083: return this.svc;
      case 0xF084: return this.in1;
      case 0xF086: return 0xFF;
      case 0xF087: return (this.mainSent ? 0 : 1) | (this.mcuSent ? 2 : 0);   // MCU ready to take a byte / has one for us
    }
    return 0xFF;
  }

  write(a, v) {
    if (a < 0xE000) return;
    if (a < 0xE800) { this.ram[a - 0xE000] = v; return; }
    if (a < 0xF000) { this.pal[a - 0xE800] = v; this.setColor((a - 0xE800) >> 1); return; }
    if (a < 0xF004) { this.vreg[a - 0xF000] = v; return; }
    if (a >= 0xF0C0 && a < 0xF0C6) { this.scroll[a - 0xF0C0] = v; return; }
    if (a >= 0xF100 && a < 0xF160) { this.sprites[a - 0xF100] = v; return; }
    if (a >= 0xF400) { if (a < 0x10000) this.vram[(a - 0xF400) % 0xC00] = v; return; }
    switch (a) {
      case 0xF060: this.latch = v; if (this.nmiOn) this.snd.nmi(); else this.nmiPending = 1; return;
      case 0xF062: this.fromMain = v; this.mainSent = 1; this.mcu.irq = true; return;
    }
  }

  // I/O reads at 4000-7FFF fetch from the data ROM.
  input(p) { return p >= 0x4000 && p < 0x8000 ? this.roms.data[p - 0x4000] : 0xFF; }

  // Little-endian xxxxRRRR GGGGBBBB.
  setColor(i) {
    const lo = this.pal[i * 2], hi = this.pal[i * 2 + 1];
    this.palette[i] = rgba((hi & 15) * 17, (lo >> 4) * 17, (lo & 15) * 17);
  }

  // ---------------------------------------------------------------- sound CPU

  sRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0x8800) return this.soundRam[a - 0x8000];
    switch (a) {
      case 0x9000: return this.ym[0].status();
      case 0xA000: return this.ym[1].status();
      case 0xB000: return this.latch;
    }
    return 0xFF;
  }
  sWrite(a, v) {
    if (a >= 0x8000 && a < 0x8800) { this.soundRam[a - 0x8000] = v; return; }
    switch (a) {
      case 0x9000: this.ym[0].select(v); break;
      case 0x9001: this.ym[0].write(v); break;
      case 0xA000: this.ym[1].select(v); break;
      case 0xA001: this.ym[1].write(v); break;
      case 0xB001: this.nmiOn = 1; if (this.nmiPending) { this.snd.nmi(); this.nmiPending = 0; } break;
      case 0xB002: this.nmiOn = 0; break;
    }
  }

  // ---------------------------------------------------------------- MCU

  // Port A carries the bytes; port B bit 1 (falling) takes the main CPU's
  // byte, bit 2 (rising) hands one back; port C reports the two latches.
  mRead(a) {
    a &= 0x7FF;
    if (a === 0) return (this.portA & this.ddr[0]) | (this.portAIn & ~this.ddr[0]);
    if (a === 1) return (this.portB & this.ddr[1]) | (0xFF & ~this.ddr[1]);
    if (a === 2) { const inp = (this.mainSent ? 1 : 0) | (this.mcuSent ? 0 : 2); return (this.portC & this.ddr[2]) | (inp & ~this.ddr[2]); }
    if (a >= 0x10 && a < 0x80) return this.mcuRam[a];
    if (a >= 0x80) return this.roms.mcu[a];
    return 0;
  }
  mWrite(a, v) {
    a &= 0x7FF;
    switch (a) {
      case 0: this.portA = v; return;
      case 1: {
        const d = this.ddr[1];
        if ((d & 2) && !(v & 2) && (this.portB & 2)) { this.portAIn = this.fromMain; this.mainSent = 0; this.mcu.irq = false; }
        if ((d & 4) && (v & 4) && !(this.portB & 4)) { this.fromMcu = this.portA; this.mcuSent = 1; }
        this.portB = v;
        return;
      }
      case 2: this.portC = v; return;
      case 4: case 5: case 6: this.ddr[a - 4] = v; return;
    }
    if (a >= 0x10 && a < 0x80) this.mcuRam[a] = v;
  }

  // ---------------------------------------------------------------- inputs

  // IN1: button 1, button 2, left, right, down, up (active low). Service: starts (low), coins (high).
  setInputs(s) {
    this.in1 = 0xFF & ~((s.fire ? 1 : 0) | (s.fire2 ? 2 : 0) | (s.left ? 4 : 0) | (s.right ? 8 : 0) | (s.down ? 0x10 : 0) | (s.up ? 0x20 : 0));
    this.svc = 0x0B & ~((s.start1 ? 1 : 0) | (s.start2 ? 2 : 0)) | (s.coin ? 0x10 : 0);
  }
  applySwitches(v) { this.dsw = [0x67 | v.lives, 0x00, 0xF2 | v.difficulty]; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const mc = 6000000 / REFRESH / LINES, mcu = 1000000 / REFRESH / LINES, samples = 48000 / REFRESH / LINES, dt = 1 / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === 240) this.cpu.irq = true;      // vertical blank
      this.cycleCarry += mc;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.mCarry += mcu;
      this.mCarry -= this.mcu.run(Math.floor(this.mCarry));
      this.snd.irq = this.ym[0].irq;
      this.zCarry += mc;
      this.zCarry -= this.snd.run(Math.floor(this.zCarry));
      this.ym[0].timers(dt); this.ym[1].timers(dt);
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    this.render();
  }

  render() {
    const out = this.frame, pri = this.pri, pal = this.palette, v = this.vreg, vram = this.vram;
    pri.fill(0);
    const layer = (base, codeOff, palBase, sx, sy, dx, opaque, priVal) => {
      for (let y = 0; y < H; y++) {
        const my = (y + TOP + sy) & 255;
        for (let x = 0; x < W; x++) {
          const mx = (x + LEFT + sx + dx) & 255;
          const code = vram[base + (my >> 3) * 32 + (mx >> 3)] + codeOff;
          const p = this.tilePix[(code % (this.tilePix.length / 64)) * 64 + (my & 7) * 8 + (mx & 7)];
          if (!p && !opaque) continue;
          out[y * W + x] = pal[palBase + p];
          pri[y * W + x] |= priVal;
        }
      }
    };
    if ((v[2] & 0xF0) === 0xF0) {
      layer(0x800, 256 * (v[1] & 0x08 ? 5 : 1), 0x300 + (v[1] & 0xF0), this.scroll[4], this.scroll[5], -5, true, 1);
      layer(0x400, 256 * (v[0] & 0x04 ? 1 : 0), 0x200 + (v[1] & 0xF0), this.scroll[2], this.scroll[3], -3, false, v[1] & 2 ? 2 : 4);
      layer(0x000, 0, 0x110, this.scroll[0], this.scroll[1], -1, false, 4);
    } else {
      layer(0x000, 0, 0x110, this.scroll[0], this.scroll[1], -1, true, 0);
    }
    // Sprites: a pixel shows unless a layer with a priority bit in its mask covers it.
    const s = this.sprites, count = this.spritePix.length / 256;
    for (let o = 0; o < 0x60; o += 4) {
      const attr = s[o + 2], color = ((attr >> 4) & 7) * 16;
      const fx = attr & 1, fy = attr & 2, h = attr & 8 ? 2 : 1;
      const sx = s[o] - 15, sy = 256 - 16 * h - s[o + 1];
      let num = s[o + 3] + ((attr & 4) << 6);
      if (h === 2 && !fy) num ^= 1;
      const mask = attr & 0x80 ? 0xFC : 0xF0;
      for (let k = 0; k < h; k++) {
        const code = (num ^ k) % count;
        for (let y = 0; y < 16; y++) {
          const py = sy + 16 * k + y - TOP;
          if (py < 0 || py >= H) continue;
          for (let x = 0; x < 16; x++) {
            const px = ((sx + x) & 0xFF) - LEFT;
            if (px < 0 || px >= W) continue;
            const pen = this.spritePix[code * 256 + (fy ? 15 - y : y) * 16 + (fx ? 15 - x : x)];
            if (!pen || ((1 << pri[py * W + px]) & mask)) continue;
            out[py * W + px] = pal[color + pen];
          }
        }
      }
    }
  }
}

LegendOfKage.id = 'lkage';
LegendOfKage.title = 'The Legend of Kage';
LegendOfKage.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x18], ['4', 0x10], ['5', 0x08], ['255 (cheat)', 0x00]], default: 0x18 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x0C], ['Normal', 0x08], ['Hard', 0x04], ['Hardest', 0x00]], default: 0x0C },
];
