// Konami Blades of Steel (1987): an HD6309 at 3 MHz with Konami's K007342
// (two 64x32 maps of 8x8 tiles; the back one also has per-row or per-column
// scrolling) and K007420 (64 zoomable sprites built from 8x8 tiles through a
// lookup PROM), 48 colors of xBBBBBGGGGGRRRRR, and a K051733 protection chip
// that does division, square roots and a collision test for the game.
//
// Sound: a 6809 with a YM2203 whose ports drive a uPD7759 (sample data and
// its 128K bank of the speech ROMs). Each frame: FIRQ at vblank (when the
// K007342 enables it) and an NMI. 256x224 on a vertical monitor at 60 Hz.

import { M6809 } from './m6809.js';
import { YM2203 } from './ym2203.js';
import { UPD7759 } from './upd7759.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16, LINES = 256, VBLANK = 240, REFRESH = 60;
const CPU_CLOCK = 3000000, SOUND_CLOCK = 2000000;
const XOFF = [0, 1, 4, 5], YOFF = [0, 2, 8, 10];
const STATE = ['ram', 'vram', 'scrollRam', 'spriteRam', 'palRam', 'regs', 'sxHi', 'protRam', 'bank', 'spriteBank', 'soundRam', 'latch',
  'speechBank', 'in', 'cycleCarry', 'soundCarry', 'sampleCarry', 'cpu', 'snd', 'ym', 'upd'];

export class BladesOfSteel {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 48; i++) this.setColor(i); this.setSpeechBank(this.speechBank); }

  // roms: { main (0x18000 region: banks at 10000, fixed 8000-FFFF), sound (8000-FFFF), tiles, sprites, spriteLut, speech }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 3;
    this.button2 = 'Pass';
    this.button3 = 'Check';
    this.roms = roms;
    this.ram = new Uint8Array(0x2000);           // 4000-5FFF
    this.vram = new Uint8Array(0x2000);          // 0000-1FFF: colors / codes for each layer
    this.scrollRam = new Uint8Array(0x200);
    this.spriteRam = new Uint8Array(0x200);
    this.palRam = new Uint8Array(0x60);
    this.regs = new Uint8Array(8);
    this.sxHi = new Uint16Array(2);              // the X scrolls' ninth bits
    this.protRam = new Uint8Array(0x20);
    this.soundRam = new Uint8Array(0x800);
    this.palette = new Uint32Array(48).fill(0xFF000000);

    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onTaken = (kind) => { if (kind === 'firq') this.cpu.firq = false; };
    this.snd = new M6809({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onTaken = (kind) => { if (kind === 'irq') this.snd.irq = false; };
    this.upd = new UPD7759(640000, 0.6, () => {}, new Uint8Array(0x20000));
    this.ym = new YM2203(3579545, 0.45);
    this.ym.ssg.portOut = (n, v) => { if (n === 0) this.upd.data(v); else this.setSpeechBank((v & 0x38) >> 3); };
    this.sound = new SoundMix([this.ym, this.upd], 1);

    this.tilePix = decodeTiles(roms.tiles, { count: roms.tiles.length / 32, width: 8, height: 8, planes: [0, 1, 2, 3], xs: [8, 12, 0, 4, 24, 28, 16, 20], ys: run(0, 8, 32), size: 256 });
    this.spritePix = decodeTiles(roms.sprites, { count: roms.sprites.length / 32, width: 8, height: 8, planes: [0, 1, 2, 3], xs: run(0, 8, 4), ys: run(0, 8, 32), size: 256 });
    this.frame = new Uint32Array(W * H);
    this.native = new Uint32Array(W * H);
    this.in = new Uint8Array(3).fill(0xFF);
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.vram, this.scrollRam, this.spriteRam, this.palRam, this.regs, this.sxHi, this.protRam, this.soundRam]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.bank = 0; this.spriteBank = 0; this.latch = 0; this.setSpeechBank(0);
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.ym.reset(); this.upd.reset(); this.sound.reset();
  }

  setSpeechBank(n) {
    this.speechBank = n;
    const s = this.roms.speech, base = n * 0x20000, view = new Uint8Array(0x20000);
    if (base < s.length) view.set(s.subarray(base, base + 0x20000));
    this.upd.rom = view;
  }

  setColor(i) {
    const d = (this.palRam[i * 2] << 8) | this.palRam[i * 2 + 1], c5 = (v) => ((v & 31) << 3) | ((v & 31) >> 2);
    this.palette[i] = rgba(c5(d), c5(d >> 5), c5(d >> 10));
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a >= 0x8000) return this.roms.main[a];
    if (a >= 0x6000) return this.roms.main[0x10000 + this.bank * 0x2000 + a - 0x6000];
    if (a >= 0x4000) return this.ram[a - 0x4000];
    if (a < 0x2000) return this.vram[a];
    if (a < 0x2200) return this.spriteRam[a - 0x2000];
    if (a < 0x2400) return this.scrollRam[a - 0x2200];
    if (a < 0x2460) return this.palRam[a - 0x2400];
    switch (a) {
      case 0x2E00: return this.in[0];
      case 0x2E01: return this.in[1];
      case 0x2E02: return this.in[2];
      case 0x2E03: return this.dsw2;
      case 0x2E40: return 0xFF;                    // DSW1: 1 coin 1 credit
    }
    if (a >= 0x2F00 && a < 0x2F04) return 0;        // trackballs (not on this version)
    if (a >= 0x2F80 && a < 0x2FA0) return this.protRead(a & 0x1F);
    return 0xFF;
  }
  write(a, v) {
    if (a >= 0x8000) return;
    if (a >= 0x4000) { if (a < 0x6000) this.ram[a - 0x4000] = v; return; }
    if (a < 0x2000) { this.vram[a] = v; return; }
    if (a < 0x2200) { this.spriteRam[a - 0x2000] = v; return; }
    if (a < 0x2400) { this.scrollRam[a - 0x2200] = v; return; }
    if (a < 0x2460) { this.palRam[a - 0x2400] = v; this.setColor((a - 0x2400) >> 1); return; }
    if (a >= 0x2600 && a < 0x2608) {
      const r = a - 0x2600;
      this.regs[r] = v;
      if (r === 1 || r === 2) { this.sxHi[0] = (v & 1) << 8; this.sxHi[1] = (v & 2) << 7; }   // register 1 also lands here
      return;
    }
    if (a === 0x2E80) { this.latch = v; this.snd.irq = true; return; }
    if (a === 0x2F40) { this.bank = (v & 0x60) >> 5; this.spriteBank = (v & 0x80) << 3; return; }
    if (a >= 0x2F80 && a < 0x2FA0) this.protRam[a & 0x1F] = v;
  }

  // K051733: 16-bit operands as big-endian pairs.
  protRead(o) {
    const r = this.protRam, w = (i) => (r[i] << 8) | r[i + 1];
    const op1 = w(0), op2 = w(2), op3 = w(4), rad = w(6);
    switch (o) {
      case 0x00: return op2 ? Math.floor(op1 / op2) >> 8 : 0xFF;
      case 0x01: return op2 ? Math.floor(op1 / op2) & 0xFF : 0xFF;
      case 0x02: return op2 ? (op1 % op2) >> 8 : 0xFF;
      case 0x03: return op2 ? (op1 % op2) & 0xFF : 0xFF;
      case 0x04: return isqrt(op3 * 65536) >> 8;
      case 0x05: return isqrt(op3 * 65536) & 0xFF;
      case 0x07: {
        const y1 = w(8), x1 = w(10), y2 = w(12), x2 = w(14);
        return x1 + rad < x2 || x2 + rad < x1 || y1 + rad < y2 || y2 + rad < y1 ? 0x80 : 0;
      }
      case 0x0E: case 0x0F: return ~r[o] & 0xFF;
    }
    return r[o];
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a >= 0x8000) return this.roms.sound[a - 0x8000];
    if (a < 0x0800) return this.soundRam[a];
    if (a === 0x1000) return this.ym.status();
    if (a === 0x1001) return this.ym.read();
    if (a === 0x4000) return this.upd.busy() ? 0 : 1;
    if (a === 0x6000) return this.latch;
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a < 0x0800) this.soundRam[a] = v;
    else if (a === 0x1000) this.ym.select(v);
    else if (a === 0x1001) this.ym.write(v);
    else if (a === 0x3000) { this.upd.resetLine(v & 1); this.upd.start(v & 2); }
  }

  // COINSW: coin, starts (active low), flip off, service off. P1: left, right, up, down, shoot, pass, check.
  setInputs(s) {
    this.in[0] = 0xBF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in[1] = 0xFF & ~((s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0)
      | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0) | (s.fire3 ? 0x40 : 0));
    this.in[2] = 0xFF;
  }
  // DSW2: upright, difficulty, demo sounds on.
  applySwitches(v) { this.dsw2 = 0x1B | v.difficulty; }

  runFrame() {
    const main = CPU_CLOCK / REFRESH / LINES, snd = SOUND_CLOCK / REFRESH / LINES, samples = RATE / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK) { this.render(); if (this.regs[0] & 0x02) this.cpu.firq = true; }
      else if (line === VBLANK / 2) this.cpu.nmi();
      this.cycleCarry += main;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.ym.timers(1 / REFRESH / LINES);
      this.soundCarry += snd;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  // One K007342 layer's pixel: [pen, color index, priority group], scrolled.
  tile(layer, x, y) {
    const r = this.regs, v = this.vram, base = layer * 0x1000;
    let sx, sy;
    if (layer === 1) { sx = r[5] | this.sxHi[1]; sy = r[6]; }
    else {
      sx = r[3] | this.sxHi[0]; sy = r[4];
      const mode = r[2] & 0x1C;
      if (mode === 0x0C) { const c = x >> 3; sy = this.scrollRam[2 * c] + 256 * this.scrollRam[2 * c + 1]; }        // per column
      else if (mode === 0x14) sx = this.scrollRam[2 * y] + 256 * this.scrollRam[2 * y + 1];                         // per line
    }
    const tx = (x + sx) & 511, ty = (y + sy) & 255, col = tx >> 3, row = ty >> 3;
    const i = (col & 0x1F) + (row << 5) + ((col & 0x20) << 5);
    const c = v[base + i], code = v[base + 0x800 + i] | ((c & 0x0F) << 8) | ((c & 0x40) << 6);
    const px = c & 0x10 ? 7 - (tx & 7) : tx & 7, py = c & 0x20 ? 7 - (ty & 7) : ty & 7;
    return [this.tilePix[(code % 8192) * 64 + py * 8 + px], layer * 16, c >> 7];
  }

  render() {
    const out = this.native, pal = this.palette;
    const front = new Uint8Array(W * H);               // layer 1's priority tiles (in front of sprites)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [pen, cb, grp] = this.tile(1, x, y + TOP);
        out[y * W + x] = pal[cb + pen];
        front[y * W + x] = grp;
      }
    }
    this.drawSprites(out, front);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [pen, cb] = this.tile(0, x, y + TOP);
        if (pen) out[y * W + x] = pal[cb + pen];
      }
    }
    rotate90(out, W, H, this.frame);
  }

  drawSprites(out, front) {
    const s = this.spriteRam, pal = this.palette, lut = this.roms.spriteLut;
    for (let offs = 0x200 - 8; offs >= 0; offs -= 8) {
      const attr = s[offs + 4], c0 = s[offs + 2];
      let code = s[offs + 1] | ((c0 & 0xC0) << 2) | this.spriteBank;
      code = (code << 2) | ((c0 & 0x30) >> 4);
      const color = (c0 & 0x0F) * 16;
      const ox = s[offs + 3] - ((attr & 0x80) << 1), oy = 256 - s[offs] - TOP;
      const fx = attr & 0x04, fy = attr & 0x08;
      const zoom0 = s[offs + 5] | ((attr & 3) << 8);
      if (!zoom0) continue;
      const zoom = Math.floor(0x10000 * 128 / zoom0);
      let w = 1, h = 1;
      switch (attr & 0x70) {
        case 0x20: w = 2; code &= ~1; break;
        case 0x10: h = 2; code &= ~2; break;
        case 0x00: w = h = 2; code &= ~3; break;
        case 0x40: w = h = 4; code &= ~3; break;
      }
      const wrap = this.regs[2] & 0x80;
      for (let ty = 0; ty < h; ty++) {
        const sy = oy + ((zoom * ty + (1 << 12)) >> 13), zh = oy + ((zoom * (ty + 1) + (1 << 12)) >> 13) - sy;
        for (let tx = 0; tx < w; tx++) {
          const sx = ox + ((zoom * tx + (1 << 12)) >> 13), zw = ox + ((zoom * (tx + 1) + (1 << 12)) >> 13) - sx;
          const c = (code + XOFF[fx ? w - 1 - tx : tx] + YOFF[fy ? h - 1 - ty : ty]) % (this.spritePix.length / 64);
          for (const yy of wrap ? [sy, sy - 256] : [sy]) {
            for (let dy = 0; dy < zh; dy++) {
              const py = yy + dy;
              if (py < 0 || py >= H) continue;
              let ry = Math.floor(dy * 8 / zh); if (fy) ry = 7 - ry;
              for (let dx = 0; dx < zw; dx++) {
                const px = sx + dx;
                if (px < 0 || px >= W || front[py * W + px]) continue;
                let rx = Math.floor(dx * 8 / zw); if (fx) rx = 7 - rx;
                const pen = this.spritePix[c * 64 + ry * 8 + rx];
                if (pen) out[py * W + px] = pal[0x20 + (lut[color + pen] & 0x0F)];
              }
            }
          }
        }
      }
    }
  }
}

function isqrt(op) {
  let i = 0x8000, step = 0x4000;
  while (step) {
    if (i * i === op) return i;
    i += i * i > op ? -step : step;
    step >>= 1;
  }
  return i;
}

BladesOfSteel.id = 'bladstle';
BladesOfSteel.title = 'Blades of Steel';
BladesOfSteel.switches = [
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Difficult', 0x20], ['Very difficult', 0x00]], default: 0x40 },
];
