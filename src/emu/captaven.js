// Data East's 32-bit board, as used by Captain America and the Avengers
// (1991): an ARM2 at 7 MHz; three playfields (an 8x8 or 16x16 text layer, a
// 16x16 layer, and a 16x16 layer of 256-color tiles) with per-row scrolling
// and a raster interrupt the game uses to change the middle layer's scroll
// partway down; 1024 sprites of 16x16 blocks with two priorities; 2048
// colors of 8-bit RGB. The tile graphics are encrypted (Data East chip 56).
//
// Sound: a HuC6280 at 4 MHz with a YM2151 (its timer interrupt drives the
// music; its CT pins bank the sample ROMs) and two OKI M6295s.
// Run in the game's 2-player mode, which has a hero select screen. 320x240 at 60 Hz.

import { ARM2 } from './arm.js';
import { H6280 } from './h6280.js';
import { YM2151 } from './ym2151.js';
import { OKIM6295 } from './okim6295.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { capture, apply } from './state.js';

const W = 320, H = 240, TOP = 8, LINES = 262, VBLANK = 248, REFRESH = 60;
const CPU_CLOCK = 28000000 / 4, SOUND_CLOCK = 32220000 / 8;
const STATE = ['ram', 'ram2', 'spriteRam', 'spriteBuf', 'palRam', 'pf12', 'pf34', 'pf1', 'pf2', 'pf3', 'row1', 'row2', 'row3',
  'pri', 'latch', 'rasterOn', 'rasterLine', 'rasterList', 'rasterCount', 'frameNo', 'soundRam', 'timer', 'in', 'cycleCarry', 'soundCarry', 'sampleCarry',
  'cpu', 'snd', 'ym', 'oki0', 'oki1'];

export class CaptainAmerica {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 2048; i++) this.setColor(i); }

  // roms: { main (ARM, little-endian bytes), sound (HuC6280), chars (8x8/16x16 tiles), tiles8 (256-color tiles), sprites, oki0, oki1 }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Jump';
    this.roms = roms;
    this.main32 = new Uint32Array(roms.main.buffer, roms.main.byteOffset, roms.main.length >> 2);
    this.ram = new Uint32Array(0x2000);            // 120000-127FFF
    this.ram2 = new Uint32Array(0x2000);           // 160000-167FFF
    this.spriteRam = new Uint32Array(0x400);       // 110000-110FFF
    this.spriteBuf = new Uint32Array(0x400);
    this.palRam = new Uint32Array(0x800);          // 130000-131FFF
    this.pf12 = new Uint32Array(8);                // 180000: playfield 1/2 control
    this.pf34 = new Uint32Array(8);                // 1C0000: playfield 3 control
    this.pf1 = new Uint32Array(0x800); this.pf2 = new Uint32Array(0x800); this.pf3 = new Uint32Array(0x800);
    this.row1 = new Uint32Array(0x800); this.row2 = new Uint32Array(0x800); this.row3 = new Uint32Array(0x800);
    this.rasterList = new Int32Array(3 * 64);
    this.soundRam = new Uint8Array(0x2000);
    this.timer = new Int32Array(3);                // reload, count (cycles), enabled
    this.palette = new Uint32Array(2048).fill(0xFF000000);

    this.cpu = new ARM2({ read32: (a) => this.read32(a), read8: (a) => this.read8(a), write32: (a, v) => this.write32(a, v), write8: (a, v) => this.write8(a, v) });
    this.snd = new H6280({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = (line) => { if (line === 1) this.snd.setIrq(1, this.ym.irq); };
    this.ym = new YM2151(32220000 / 9, 0.6);
    this.oki0 = new OKIM6295(32220000 / 32, roms.oki0, 0.8);
    this.oki1 = new OKIM6295(32220000 / 16, roms.oki1, 0.6);
    this.ym.onPort = (v) => { this.oki0.bank = (v & 1) * 0x40000; this.oki1.bank = ((v >> 1) & 1) * 0x40000; };
    this.sound = new SoundMix([this.ym, this.oki0, this.oki1], 1);

    const halfC = roms.chars.length / 2 * 8;
    this.charPix = decodeTiles(roms.chars, { count: roms.chars.length / 32, width: 8, height: 8, planes: [halfC + 8, halfC, 8, 0], xs: run(0, 8), ys: run(0, 8, 16), size: 128 });
    const xs16 = [...run(256, 8), ...run(0, 8)];
    this.tilePix = decodeTiles(roms.chars, { count: roms.chars.length / 128, width: 16, height: 16, planes: [halfC + 8, halfC, 8, 0], xs: xs16, ys: run(0, 16, 16), size: 512 });
    const q = roms.tiles8.length / 4 * 8;
    this.tile8Pix = decodeTiles(roms.tiles8, { count: roms.tiles8.length / 4 / 64, width: 16, height: 16, planes: [3 * q + 8, 3 * q, 2 * q + 8, 2 * q, q + 8, q, 8, 0], xs: xs16, ys: run(0, 16, 16), size: 512 });
    this.spritePix = decodeTiles(roms.sprites, { count: roms.sprites.length / 128, width: 16, height: 16, planes: [16, 0, 24, 8], xs: [...run(512, 8), ...run(0, 8)], ys: run(0, 16, 32), size: 1024 });
    this.frame = new Uint32Array(W * H);
    this.priBuf = new Uint8Array(W * H);
    this.taken = new Uint8Array(W * H);
    this.in = new Uint16Array(3).fill(0xFFFF);
    this.applySwitches();
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.ram2, this.spriteRam, this.spriteBuf, this.palRam, this.pf12, this.pf34, this.pf1, this.pf2, this.pf3,
      this.row1, this.row2, this.row3, this.soundRam, this.timer, this.rasterList]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.pri = 0; this.latch = 0; this.rasterOn = 0; this.rasterLine = -1; this.rasterCount = 0; this.frameNo = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.ym.reset(); this.oki0.reset(); this.oki1.reset(); this.sound.reset();
  }

  setColor(i) {
    const v = this.palRam[i];
    this.palette[i] = rgba(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF);
  }

  // ---------------------------------------------------------------- ARM bus (byte addresses, 32-bit words)

  region(a) {
    if (a >= 0x120000 && a < 0x128000) return [this.ram, (a - 0x120000) >> 2];
    if (a >= 0x160000 && a < 0x168000) return [this.ram2, (a - 0x160000) >> 2];
    if (a >= 0x110000 && a < 0x111000) return [this.spriteRam, (a - 0x110000) >> 2];
    if (a >= 0x130000 && a < 0x132000) return [this.palRam, (a - 0x130000) >> 2];
    if (a >= 0x180000 && a < 0x180020) return [this.pf12, (a - 0x180000) >> 2];
    if (a >= 0x190000 && a < 0x194000) return [this.pf1, ((a - 0x190000) >> 2) & 0x7FF];
    if (a >= 0x194000 && a < 0x196000) return [this.pf2, (a - 0x194000) >> 2];
    if (a >= 0x1A0000 && a < 0x1A2000) return [this.row1, (a - 0x1A0000) >> 2];
    if (a >= 0x1A4000 && a < 0x1A6000) return [this.row2, (a - 0x1A4000) >> 2];
    if (a >= 0x1C0000 && a < 0x1C0020) return [this.pf34, (a - 0x1C0000) >> 2];
    if (a >= 0x1D0000 && a < 0x1D2000) return [this.pf3, (a - 0x1D0000) >> 2];
    if (a >= 0x1E0000 && a < 0x1E2000) return [this.row3, (a - 0x1E0000) >> 2];
    return null;
  }

  read32(a) {
    if (a < 0x100000) return this.main32[a >> 2];
    const r = this.region(a);
    if (r) return r[0][r[1]];
    if (a >= 0x128000 && a < 0x129000) {              // protection / I/O chip 75
      switch (a & 0xFFC) {
        case 0x0A0: return 0xFFFF0000 | this.in[0];
        case 0x158: return 0xFFFF0000 | this.in[1];
        case 0xED4: return 0xFFFF0000 | this.in[2];
      }
      return 0xFFFFFFFF;
    }
    if (a >= 0x148000 && a < 0x148010) {
      const o = (a >> 2) & 3;
      if (o === 2) { this.cpu.irq = 0; return 0; }      // raster interrupt acknowledge
      if (o === 3) return (this.line >= VBLANK ? 0xFFFFFF91 : 0xFFFFFFA0) >>> 0;
      return 0xFFFFFFFF;
    }
    if (a >= 0x168000 && a < 0x168004) return (0xFFFF0000 | this.dsw) >>> 0;
    return 0xFFFFFFFF;
  }
  read8(a) { return (this.read32(a & ~3) >>> (8 * (a & 3))) & 0xFF; }

  write32(a, v) {
    v >>>= 0;
    const r = this.region(a);
    if (r) { r[0][r[1]] = v; if (r[0] === this.palRam) this.setColor(r[1]); return; }
    if (a === 0x1280C8) { this.latch = v & 0xFF; this.snd.setIrq(0, true); return; }
    if (a >= 0x148000 && a < 0x148010) {
      const o = (a >> 2) & 3;
      if (o === 0) this.rasterOn = (v & 0xFF) === 0xC8 ? 1 : 0;
      else if (o === 1) { const sl = v & 0xFF; this.rasterLine = this.rasterOn && sl > 0 && sl < 240 ? sl : -1; }
      return;
    }
    if (a === 0x178000) this.pri = v;
  }
  write8(a, v) {
    const r = this.region(a & ~3);
    if (r) {
      const s = 8 * (a & 3);
      r[0][r[1]] = ((r[0][r[1]] & ~(0xFF << s)) | ((v & 0xFF) << s)) >>> 0;
      if (r[0] === this.palRam) this.setColor(r[1]);
      return;
    }
    this.write32(a & ~3, (v & 0xFF) << (8 * (a & 3)));
  }

  // ---------------------------------------------------------------- sound CPU (physical addresses)

  soundRead(pa) {
    if (pa < 0x10000) return this.roms.sound[pa];
    if (pa >= 0x1F0000 && pa < 0x1F2000) return this.soundRam[pa - 0x1F0000];
    if (pa === 0x110001 || pa === 0x110000) return this.ym.read();
    if (pa === 0x120000 || pa === 0x120001) return this.oki0.read();
    if (pa === 0x130000 || pa === 0x130001) return this.oki1.read();
    if (pa === 0x140000 || pa === 0x140001) { this.snd.setIrq(0, false); return this.latch; }
    return 0xFF;
  }
  soundWrite(pa, v) {
    if (pa >= 0x1F0000 && pa < 0x1F2000) { this.soundRam[pa - 0x1F0000] = v; return; }
    if (pa === 0x110000) this.ym.select(v);
    else if (pa === 0x110001) this.ym.write(v);
    else if (pa === 0x120000 || pa === 0x120001) this.oki0.write(v);
    else if (pa === 0x130000 || pa === 0x130001) this.oki1.write(v);
    else if (pa === 0x1FEC00) { this.timer[0] = ((v & 0x7F) + 1) * 1024; this.timer[1] = this.timer[0]; }   // timer period
    else if (pa === 0x1FEC01) { this.timer[2] = v & 1; if (v & 1) this.timer[1] = this.timer[0]; }          // timer on
  }

  // P1 (active low): up, down, left, right, attack, jump, start; coins in the misc port. In its 2-player
  // mode the game lets each player choose a hero on a select screen (Captain America, Hawkeye, Iron Man, Vision).
  setInputs(s) {
    this.in[0] = 0xFFFF & ~((s.up ? 1 : 0) | (s.down ? 2 : 0) | (s.left ? 4 : 0) | (s.right ? 8 : 0)
      | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0) | (s.start1 ? 0x80 : 0) | (s.start2 ? 0x8000 : 0));
    this.in[1] = 0xFFFF;
    this.in[2] = 0xFFFF & ~(s.coin ? 0x01 : 0);
  }
  // 1 coin 1 credit, 3 lives, normal difficulty, common coin slots, 2-player mode, continues, demo sounds on.
  applySwitches() { this.dsw = 0x7FFF; }

  runFrame() {
    const main = CPU_CLOCK / REFRESH / LINES, snd = SOUND_CLOCK / REFRESH / LINES, samples = RATE / REFRESH / LINES;
    this.rasterCount = 0;
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      if (line === this.rasterLine && this.rasterLine > 0) {
        // Note where the middle layer's scroll stood, for the lines drawn so far.
        if (this.rasterCount < 63) {
          const k = this.rasterCount++ * 3;
          this.rasterList[k] = this.rasterLine - 1; this.rasterList[k + 1] = this.pf12[3]; this.rasterList[k + 2] = this.pf12[4];
        }
        this.cpu.irq = 1;
      }
      if (line === VBLANK) {
        this.render();
        this.spriteBuf.set(this.spriteRam);
        this.cpu.irq = 1;
        this.frameNo = (this.frameNo + 1) | 0;
        this.rasterCount = 0;
      }
      this.cycleCarry += main;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.ym.timers(1 / REFRESH / LINES);
      this.snd.setIrq(1, this.ym.irq);
      const c0 = this.snd.cycles;
      this.soundCarry += snd;
      this.snd.run(Math.floor(this.soundCarry));
      const used = this.snd.cycles - c0;
      this.soundCarry -= used;
      if (this.timer[2]) {
        this.timer[1] -= used;
        if (this.timer[1] <= 0) { this.timer[1] += this.timer[0]; this.snd.setIrq(2, true); }
      }
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  // A playfield's scroll for a screen line: [x, y] with row scroll applied.
  scroll(ctl, which, rows, mapH, y) {
    const c0 = (ctl[5] >> (which * 8)) & 0xFF, c1 = (ctl[6] >> (which * 8)) & 0xFF;
    let sx = ctl[1 + which * 2] & 0xFFFF, sy = ctl[2 + which * 2] & 0xFFFF;
    if (c1 & 0x20 && rows) sy += rows[0x200] & 0xFFFF;
    if (c1 & 0x40 && rows) {
      const k = (c0 >> 3) & 0xF;
      let n = k <= 8 ? 512 >> k : 1;
      if (mapH < n) n >>= 1;
      const ty = (y + sy) & (mapH - 1);
      sx += rows[Math.floor(ty * n / mapH)] & 0xFFFF;
    }
    return [sx, sy];
  }

  render() {
    const out = this.frame, pal = this.palette, pri = this.priBuf, p12 = this.pf12, p34 = this.pf34;
    pri.fill(0);
    const pf1On = p12[5] & 0x80, pf2On = p12[5] & 0x8000, pf3On = p34[5] & 0x80;
    const pf3Bank = p34[7] & 0x20 ? 0x4000 : 0;
    const pf2Flip = (p12[6] >> 8) & 3;
    const black = 0xFF000000;
    // Middle layer scroll per line (raster interrupts change it partway down).
    const segs = [];
    let start = 0;
    for (let k = 0; k < this.rasterCount; k++) {
      const end = this.rasterList[k * 3];
      segs.push([start, end, this.rasterList[k * 3 + 1], this.rasterList[k * 3 + 2]]);
      start = end;
    }
    const pf2At = (ly) => { for (const s of segs) if (ly >= s[0] && ly <= s[1]) return [s[2], s[3]]; return null; };

    // [pen, color] of a pixel in each layer, or null when see-through.
    const pf2px = (x, y) => {
      let [sx, sy] = this.scroll(p12, 1, this.row2, 512, y);
      const r = pf2At(y); if (r) { sx = r[0] & 0xFFFF; sy = r[1] & 0xFFFF; }
      const tx = (x + sx) & 1023, ty = (y + sy) & 511, col = tx >> 4, row = ty >> 4;
      const t = this.pf2[(col & 0x1F) + ((row & 0x1F) << 5) + ((col & 0x20) << 5)];
      let color = (t >> 12) & 15, fx = 0, fy = 0;
      if (t & 0x8000) { if (pf2Flip & 1) { fx = 1; color &= 7; } if (pf2Flip & 2) { fy = 1; color &= 7; } }
      const code = (t & 0xFFF) % (this.tilePix.length / 256);
      const pen = this.tilePix[code * 256 + (fy ? 15 - (ty & 15) : ty & 15) * 16 + (fx ? 15 - (tx & 15) : tx & 15)];
      return [pen, 512 + (color + 16) * 16 + pen];
    };
    const pf3px = (x, y) => {
      const [sx, sy] = this.scroll(p34, 0, this.row3, 512, y);
      const tx = (x + sx) & 511, ty = (y + sy) & 511;
      const t = this.pf3[(ty >> 4) * 32 + (tx >> 4)];
      const code = ((t & 0x3FFF) + pf3Bank) % (this.tile8Pix.length / 256);
      const pen = this.tile8Pix[code * 256 + (ty & 15) * 16 + (tx & 15)];
      return [pen, 1024 + ((t >> 14) & 3) * 256 + pen];
    };
    const lower = (this.pri & 1) === 0;
    for (let y = 0; y < H; y++) {
      const ly = y + TOP, row = y * W;
      for (let x = 0; x < W; x++) {
        let c = black, p = 0;
        if (lower) {
          if (pf3On) c = pal[pf3px(x, ly)[1]];
          if (pf2On) { const [pen, ci] = pf2px(x, ly); if (pen) { c = pal[ci]; p = 1; } }
        } else {
          if (pf2On) c = pal[pf2px(x, ly)[1]];
          if (pf3On) { const [pen, ci] = pf3px(x, ly); if (pen) { c = pal[ci]; p = 1; } }
        }
        out[row + x] = c; pri[row + x] = p;
      }
    }
    this.drawSprites();
    if (pf1On) {
      const small = p12[6] & 0x80;
      for (let y = 0; y < H; y++) {
        const ly = y + TOP, row = y * W;
        const [sx, sy] = this.scroll(p12, 0, this.row1, small ? 256 : 512, ly);
        for (let x = 0; x < W; x++) {
          let pen, color;
          if (small) {
            const tx = (x + sx) & 511, ty = (ly + sy) & 255, t = this.pf1[(ty >> 3) * 64 + (tx >> 3)];
            pen = this.charPix[((t & 0xFFF) % (this.charPix.length / 64)) * 64 + (ty & 7) * 8 + (tx & 7)];
            color = (t >> 12) & 15;
          } else {
            const tx = (x + sx) & 1023, ty = (ly + sy) & 511, col = tx >> 4, rw = ty >> 4;
            const t = this.pf1[(col & 0x1F) + ((rw & 0x1F) << 5) + ((col & 0x20) << 5)];
            pen = this.tilePix[((t & 0xFFF) % (this.tilePix.length / 256)) * 256 + (ty & 15) * 16 + (tx & 15)];
            color = (t >> 12) & 15;
          }
          if (pen) out[row + x] = pal[512 + color * 16 + pen];
        }
      }
    }
  }

  // Sprites: 4 words each, drawn from the end of the list (the first drawn at a pixel keeps it);
  // those without the priority bit hide behind the upper tile layer's pixels.
  drawSprites() {
    const s = this.spriteBuf, out = this.frame, pal = this.palette, pri = this.priBuf, taken = this.taken, pix = this.spritePix;
    const count = pix.length / 256;
    taken.fill(0);
    for (let offs = 0x400 - 4; offs >= 0; offs -= 4) {
      let sy = s[offs], sx = s[offs + 1];
      const attr = s[offs + 2], sprite = s[offs + 3] & 0xFFFF;
      if (sy === 0x108 && !sprite) continue;
      if ((sy & 0x2000) && (this.frameNo & 1)) continue;
      const behind = !(attr & 0x20), colour = (attr & 0x1F) * 16;
      const h = (attr >> 12) & 15, w = (attr >> 8) & 15;
      const fx = !(sy & 0x4000), fy = !(sy & 0x8000);
      sx &= 0x1FF; sy &= 0x1FF;
      if (sx > 0x180) sx -= 0x200;
      if (sy > 0x180) sy -= 0x200;
      let xm, ym;
      if (fx) { xm = -16; sx += 16 * w; } else { xm = 16; sx -= 16; }
      if (fy) { ym = -16; sy += 16 * h; } else { ym = 16; sy -= 16; }
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
          const code = (sprite + y + h * x) % count, ox = sx + xm * (w - x), oy = sy + ym * (h - y) - TOP;
          for (let py = 0; py < 16; py++) {
            const yy = oy + py;
            if (yy < 0 || yy >= H) continue;
            const src = code * 256 + (fy ? 15 - py : py) * 16;
            for (let px = 0; px < 16; px++) {
              const xx = ox + px;
              if (xx < 0 || xx >= W) continue;
              const pen = pix[src + (fx ? 15 - px : px)];
              if (!pen) continue;
              const o = yy * W + xx;
              if (taken[o]) continue;
              taken[o] = 1;
              if (!(behind && pri[o] === 1)) out[o] = pal[colour + pen];
            }
          }
        }
      }
    }
  }
}
CaptainAmerica.id = 'captaven';
CaptainAmerica.title = 'Captain America and The Avengers';
CaptainAmerica.switches = [];
