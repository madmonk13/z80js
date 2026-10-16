// Namco System 1 (1987-91): Splatterhouse, Galaga '88 and many more. Three
// 6809s at 1.536 MHz (main, sub, sound) and an HD63701 MCU (inputs, the
// settings EEPROM, and two DACs playing voice samples), all sharing a 2K
// "triram". They run in short interleaved slices because they hand data
// back and forth constantly.
//
// The main and sub CPUs each see eight 8K windows, each pointed (by writes to
// E000-EFFF) at a 10-bit page of a 23-bit address space: palette RAM, video
// RAM, the per-game protection "key" chip, sprite and playfield control RAM,
// the sound RAM / triram, work RAM, and 4MB of program ROM. Writes to the
// last window (E000-FFFF) are control registers instead.
//
// Video: four scrolling 64x64 (or 64x32) maps and two fixed 36x28 maps of
// 8x8 tiles at 8 bits per pixel with a separate 1-bit shape mask, each with a
// palette bank and a priority 0-7; 127 sprites of 32x32 (or a 4-32 pixel
// window of one) at 4 bits per pixel, with priorities against the maps and a
// shadow color. 8192 colors of 8 bits per gun. 288x224 at 60.6 Hz.
//
// Sound: a YM2151 and the CUS30 waveform chip on the sound CPU, plus the
// MCU's DACs.

import { M6809 } from './m6809.js';
import { M6803 } from './m6803.js';
import { YM2151 } from './ym2151.js';
import { CUS30 } from './cus30.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba, rotate90, rotate270 } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const WIN = { x: 73, y: 16, w: 288, h: 224 };
const CLOCK = 49152000 / 32, REFRESH = 60.606060, SLICES = 640;
const STATE = ['ram', 'triram', 'palRam', 'cus116', 'vram', 'spriteRam', 'pfCtrl', 'soundRam', 'soundRam2', 'eeprom', 'chips',
  'soundBank', 'mcuBank', 'running', 'patch', 'copySprites', 'key', 'rng', 'dac', 'dacGain', 'in', 'carry', 'sampleCarry',
  'cpu', 'sub', 'snd', 'mcu', 'mix'];

// The 32x32 sprite cells: 16x16 quarters of 8-byte rows, two pixels a byte (high nibble first).
function decodeSprites(rom) {
  const count = rom.length / 512, out = new Uint8Array(count * 1024);
  for (let t = 0; t < count; t++) {
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const byte = rom[t * 512 + (y >> 4) * 256 + (x >> 4) * 128 + (y & 15) * 8 + ((x & 15) >> 1)];
        out[t * 1024 + y * 32 + x] = x & 1 ? byte & 15 : byte >> 4;
      }
    }
  }
  return out;
}

// The MCU's DAC pair, mixed after their gain settings.
class DAC {
  constructor(board) { this.board = board; this.out = 0; }
  reset() { this.out = 0; }
  saveState() { return {}; }
  loadState() {}
  sample() {
    const b = this.board, g = (n) => 0x20 * (n + 1);
    this.out = ((b.dac[0] - 0x80) * g(b.dacGain[0]) + (b.dac[1] - 0x80) * g(b.dacGain[1])) / 32768;
  }
}

export class NamcoSystem1 {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 0x2000; i++) this.setColor(i); }

  // roms: { prg (4MB, as the board sees it), sound (0x2C000 region), mcu (4K internal ROM),
  //   voice (the MCU's region from 0x10000), chars, mask, sprites }
  // cfg: { key: 'type2' | 'type3', keyId, keyReg, keyRng, rotate: 90 | 180 | 270 }
  constructor(roms, cfg) {
    this.cfg = cfg;
    this.roms = roms;
    this.rotated = cfg.rotate || 0;
    const turned = this.rotated === 90 || this.rotated === 270;
    this.width = turned ? WIN.h : WIN.w;
    this.height = turned ? WIN.w : WIN.h;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.ram = new Uint8Array(0x8000);         // pages 180-183
    this.triram = new Uint8Array(0x800);
    this.palRam = new Uint8Array(0x8000);
    this.cus116 = new Uint8Array(16);
    this.vram = new Uint8Array(0x8000);
    this.spriteRam = new Uint8Array(0x1000);
    this.pfCtrl = new Uint8Array(0x20);
    this.soundRam = new Uint8Array(0x400);     // the CUS30's RAM
    this.soundRam2 = new Uint8Array(0x2000);   // sound CPU work RAM
    this.eeprom = new Uint8Array(0x800);
    this.nvram = this.eeprom;
    this.chips = [new Uint16Array(8), new Uint16Array(8)];
    this.key = new Uint8Array(8);
    this.dac = new Uint8Array([0x80, 0x80]);
    this.dacGain = new Uint8Array([3, 3]);
    this.palette = new Uint32Array(0x2000).fill(0xFF000000);
    this.charPix = roms.chars;                 // 8 bits per pixel, a byte each
    this.charCount = roms.chars.length / 64;
    this.mask = roms.mask;
    this.spritePix = decodeSprites(roms.sprites);
    this.spriteCount = roms.sprites.length / 512;

    this.cpu = new M6809({ read: (a) => this.mread(0, a), write: (a, v) => this.mwrite(0, a, v) });
    this.sub = new M6809({ read: (a) => this.mread(1, a), write: (a, v) => this.mwrite(1, a, v) });
    this.snd = new M6809({ read: (a) => this.sndRead(a), write: (a, v) => this.sndWrite(a, v) });
    this.mcu = new M6803({ read: (a) => this.mcuRead(a), write: (a, v) => this.mcuWrite(a, v), hd63701: true, holdIrq: false,
      portIn: (n) => (n === 1 ? this.in[2] : 0xFF),
      portOut: (n, v) => { if (n === 2) { this.dacGain[0] = (v & 1) | ((v >> 1) & 2); this.dacGain[1] = (v >> 3) & 3; } } });
    this.ym = new YM2151(3579580, 0.5);
    this.cus30 = new CUS30(this.soundRam, 0.5);
    this.dacOut = new DAC(this);
    this.mix = new SoundMix([this.ym, this.cus30, this.dacOut], 2);
    this.sound = this.mix;
    this.index = new Uint16Array(WIN.w * WIN.h);
    this.pri = new Uint8Array(WIN.w * WIN.h);
    this.native = new Uint32Array(WIN.w * WIN.h);
    this.frame = this.rotated ? new Uint32Array(WIN.w * WIN.h) : this.native;
    this.in = new Uint8Array(3).fill(0xFF);
    this.dsw = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.triram, this.palRam, this.cus116, this.vram, this.spriteRam, this.pfCtrl, this.soundRam, this.soundRam2, this.key]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.chips[0].fill(0); this.chips[1].fill(0);                       // unmapped
    this.chips[0][0] = 0x180; this.chips[0][1] = 0x180; this.chips[0][7] = 0x3FF;
    this.chips[1][0] = 0x180; this.chips[1][7] = 0x3FF;
    this.soundBank = 0; this.mcuBank = 0x10000; this.running = 0; this.patch = 0; this.copySprites = 0;
    this.rng = 0x1234; this.dac[0] = this.dac[1] = 0x80;
    this.carry = 0; this.sampleCarry = 0;
    this.cpu.reset(); this.sub.reset(); this.snd.reset(); this.mcu.reset(); this.mix.reset();
  }

  setColor(i) {
    // Palette RAM: four 8K pages of 2048 colors, red, green and blue 2K apart.
    const page = i >> 11, o = page * 0x2000 + (i & 0x7FF), p = this.palRam;
    this.palette[i] = rgba(p[o], p[o + 0x800], p[o + 0x1000]);
  }

  // ---------------------------------------------------------------- the MMU

  // Read a byte of the 23-bit space: page (10 bits) and offset (13 bits).
  pageRead(page, o) {
    if (page >= 0x200) return this.roms.prg[(page - 0x200) * 0x2000 + o];
    if (page >= 0x180 && page < 0x184) return this.ram[(page - 0x180) * 0x2000 + o];
    if (page >= 0x170 && page < 0x174) return this.palRam[(page - 0x170) * 0x2000 + o];
    if (page >= 0x178 && page < 0x17C) return this.vram[(page - 0x178) * 0x2000 + o];
    switch (page) {
      case 0x17C: return this.keyRead(o);
      case 0x17E: return o < 0x1000 ? this.spriteRam[o] : this.pfCtrl[o & 0x1F];
      case 0x17F: return o < 0x1000 ? this.soundRam[o & 0x3FF] : this.triram[o & 0x7FF];
    }
    // Unmapped: the board's "BRA *" filler (with an IRQ vector), so a crashed CPU waits for the watchdog.
    if (o === 0x1FF8) return 0xFF;
    if (o === 0x1FF9) return 0;
    return o & 1 ? 0xFE : 0x20;
  }
  pageWrite(page, o, v) {
    if (page >= 0x180 && page < 0x184) { this.ram[(page - 0x180) * 0x2000 + o] = v; return; }
    if (page >= 0x170 && page < 0x174) { this.paletteWrite((page - 0x170) * 0x2000 + o, v); return; }
    if (page >= 0x178 && page < 0x17C) { this.vram[(page - 0x178) * 0x2000 + o] = v; return; }
    switch (page) {
      case 0x17C: this.keyWrite(o, v); return;
      case 0x17E:
        if (o < 0x1000) { this.spriteRam[o] = v; if (o === 0xFF2) this.copySprites = 1; }  // FF2 buffers the sprite list
        else this.pfCtrl[o & 0x1F] = v;
        return;
      case 0x17F: if (o < 0x1000) this.soundRam[o & 0x3FF] = v; else this.triram[o & 0x7FF] = v; return;
    }
  }
  // Colors, or (x800-x807 of each page) the display window registers, mirrored across the pages.
  paletteWrite(o, v) {
    if ((o & 0x1800) !== 0x1800) {
      this.palRam[o] = v;
      this.setColor(((o & 0x6000) >> 2) | (o & 0x7FF));
    } else {
      this.cus116[o & 15] = v;
      for (let i = 0x1800; i < 0x8000; i += 0x2000) for (let j = 0; j < 0x80; j++) this.palRam[i + (o & 15) + j * 16] = v;
    }
  }

  mread(c, a) { return this.pageRead(this.chips[c][a >> 13], a & 0x1FFF); }
  mwrite(c, a, v) {
    if (a < 0xE000) { this.pageWrite(this.chips[c][a >> 13], a & 0x1FFF, v); return; }
    const cpu = c ? this.sub : this.cpu;
    if (a < 0xF000) {                                  // bank select: even = page bits 8-9, odd = bits 0-7
      const b = (a >> 9) & 7, ch = this.chips[c];
      ch[b] = a & 1 ? (ch[b] & 0x300) | v : (ch[b] & 0xFF) | ((v & 3) << 8);
      return;
    }
    switch (a & 0xFE00) {
      case 0xF000:                                     // run (1) or hold the sub, sound CPUs and MCU
        if (c) return;
        if ((v & 1) !== this.running) {
          this.patch = 0;
          this.running = v & 1;
          if (this.running) { this.sub.reset(); this.snd.reset(); this.mcu.reset(); }
        }
        return;
      case 0xF600: cpu.irq = false; return;
      case 0xF800: cpu.firq = false; return;
      case 0xFA00: if (!c) this.sub.firq = true; return;
      case 0xFC00: if (!c) this.chips[1][7] = 0x300 | v; return;   // the sub CPU's ROM page
    }
  }

  // ---------------------------------------------------------------- key chips

  keyRead(o) {
    const k = this.key, c = this.cfg;
    if (c.key === 'type2') {                           // divider + key number
      if (o < 4) {
        const d = (k[0] << 8) | k[1], n = (k[2] << 8) | k[3];
        const q = d ? Math.floor(n / d) : 0xFFFF, r = d ? n % d : 0;
        return [r >> 8, r & 0xFF, q >> 8, q & 0xFF][o];
      }
      return o === 4 ? c.keyId : 0;
    }
    if (c.key === 'type3') {                           // key number and random numbers by register
      const op = (o & 0x70) >> 4;
      if (op === c.keyReg) return c.keyId;
      if (op === c.keyRng) {
        this.rng = (this.rng * 1103515245 + 12345) >>> 0;
        return (this.rng >>> 16) & 0xFF;
      }
    }
    return 0;
  }
  keyWrite(o, v) {
    if (this.cfg.key === 'type2') { if (o < 5) this.key[o] = v; }
    else if (this.cfg.key === 'type3') this.key[(o & 0x70) >> 4] = v;
  }

  // ---------------------------------------------------------------- sound CPU

  sndRead(a) {
    if (a < 0x4000) return this.roms.sound[0xC000 + this.soundBank * 0x4000 + a] ?? 0xFF;
    if (a < 0x5000) return a & 1 ? this.ym.read() : 0xFF;
    if (a < 0x5800) return this.soundRam[a & 0x3FF];
    if (a >= 0x7000 && a < 0x7800) return this.triram[a - 0x7000];
    if (a >= 0x8000 && a < 0xA000) return this.soundRam2[a - 0x8000];
    if (a >= 0xC000) return this.roms.sound[a];
    return 0xFF;
  }
  sndWrite(a, v) {
    if (a >= 0x4000 && a < 0x5000) { if (a & 1) this.ym.write(v); else this.ym.select(v); return; }
    if (a >= 0x5000 && a < 0x5800) { this.soundRam[a & 0x3FF] = v; return; }
    if (a >= 0x7000 && a < 0x7800) { this.triram[a - 0x7000] = v; return; }
    if (a >= 0x8000 && a < 0xA000) { this.soundRam2[a - 0x8000] = v; return; }
    if (a === 0xC000 || a === 0xC001) { this.soundBank = (v & 0x70) >> 4; return; }
    if (a === 0xE000) this.snd.irq = false;
  }

  // ---------------------------------------------------------------- MCU

  mcuRead(a) {
    if (a >= 0xF000) return this.roms.mcu[a - 0xF000];
    if (a >= 0x4000 && a < 0xC000) return this.roms.voice[this.mcuBank - 0x10000 + a - 0x4000] ?? 0;
    if (a >= 0xC000 && a < 0xC800) return this.triram[a - 0xC000];
    if (a >= 0xC800 && a < 0xD000) return this.eeprom[a - 0xC800];
    if (a >= 0x1000 && a < 0x1004) return 0xF0 | (a & 2 ? this.dsw : this.dsw >> 4);
    if (a === 0x1400) return this.in[0];
    if (a === 0x1401) return this.in[1];
    return 0xFF;
  }
  mcuWrite(a, v) {
    if (a === 0xC000) {                                // (see MAME: the shared byte 0 must stay A6 once set)
      if (this.patch === 0xA6) return;
      this.patch = v; this.triram[0] = v;
      return;
    }
    if (a >= 0xC000 && a < 0xC800) { this.triram[a - 0xC000] = v; return; }
    if (a >= 0xC800 && a < 0xD000) { this.eeprom[a - 0xC800] = v; return; }
    if (a === 0xD000) { this.dac[0] = v; return; }
    if (a === 0xD400) { this.dac[1] = v; return; }
    if (a === 0xD800) {                                // voice ROM select (bits 2-7, one per ROM) and A15-A16
      let addr;
      switch (v & 0xFC) {
        case 0xF8: addr = 0x10000; v ^= 2; break;
        case 0xF4: addr = 0x30000; break;
        case 0xEC: addr = 0x50000; break;
        case 0xDC: addr = 0x70000; break;
        case 0xBC: addr = 0x90000; break;
        case 0x7C: addr = 0xB0000; break;
        default: addr = 0x10000;
      }
      this.mcuBank = addr + (v & 3) * 0x8000;
      return;
    }
    if (a === 0xF000) this.mcu.irq = false;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const per = CLOCK / REFRESH / SLICES, samples = RATE / REFRESH / SLICES, dt = 1 / REFRESH / SLICES;
    for (let i = 0; i < SLICES; i++) {
      this.carry += per;
      const n = Math.floor(this.carry);
      this.carry -= n;
      this.cpu.run(n);
      if (this.running) {
        this.sub.run(n);
        this.snd.firq = this.ym.irq;
        this.snd.run(n);
        this.mcu.run(n);
      }
      this.ym.timers(dt);
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.mix.sample(); }
    }
    this.render();
    if (this.copySprites) {                            // the sprite chip copies bytes 4-9 of each entry to 10-15
      const sr = this.spriteRam;
      for (let i = 0x800; i < 0x1000; i += 16) for (let j = 10; j < 16; j++) sr[i + j] = sr[i + j - 6];
      this.copySprites = 0;
    }
    this.cpu.irq = true;                               // vertical blank: every CPU's IRQ (held until acknowledged)
    if (this.running) { this.sub.irq = true; this.snd.irq = true; this.mcu.irq = true; }
  }

  // ---------------------------------------------------------------- video

  // The screen flip (sprite register FF6 bit 0) mirrors each whole map and
  // repositions it on the 512x512 screen, as the hardware does; the visible
  // window isn't centered, so a flipped screen shows a different part of a map.
  render() {
    const idx = this.index, pri = this.pri, pf = this.pfCtrl, vram = this.vram, pix = this.charPix, mask = this.mask, cc = this.charCount;
    const flip = this.spriteRam[0xFF6] & 1;
    idx.fill(0xFFFF); pri.fill(0);
    const mod = (v, m) => ((v % m) + m) % m;
    for (let p = 0; p < 8; p++) {
      for (let layer = 0; layer < 6; layer++) {
        if (pf[16 + layer] !== p) continue;
        const colorBase = 0x800 + (pf[24 + layer] & 7) * 256;
        const fixed = layer >= 4, base = fixed ? (layer === 4 ? 0x7010 : 0x7810) : layer * 0x2000;
        const mw = fixed ? 288 : 512, mh = fixed ? 224 : layer === 3 ? 256 : 512, cols = fixed ? 36 : 64;
        let sx = 0, sy = 0;
        if (!fixed) {
          const j = layer << 2;
          sx = ((pf[j] << 8) | pf[j + 1]) - [25, 27, 28, 29][layer];
          sy = ((pf[j + 2] << 8) | pf[j + 3]) + 8;
          if (flip) { sx = -sx; sy = -sy; }
        }
        const [dx, dxf, dy, dyf] = fixed ? [73, 512 - 73, 16, 0x110] : [0, 0, 0, 0];
        // Where the map's origin lands on the screen (MAME's tilemap rule).
        const ox = flip ? 512 - mw - (dxf - sx) : dx - sx, oy = flip ? 512 - mh - (dyf - sy) : dy - sy;
        // Each row walks the map a tile run at a time (maps are whole tiles wide, so runs never wrap mid-tile).
        const tx0 = mod(WIN.x - ox, mw);
        for (let y = 0; y < WIN.h; y++) {
          let ty = mod(y + WIN.y - oy, mh);
          if (flip) ty = mh - 1 - ty;
          const row = (ty >> 3) * cols, ry = ty & 7, outRow = y * WIN.w;
          let tx = tx0;
          for (let x = 0; x < WIN.w;) {
            const etx = flip ? mw - 1 - tx : tx, t = base + (row + (etx >> 3)) * 2;
            const code = (vram[t + 1] | ((vram[t] & 0x3F) << 8)) % cc;
            const m = mask[code * 8 + ry], src = code * 64 + ry * 8;
            const n = Math.min(WIN.w - x, 8 - (tx & 7));
            let col = etx & 7;
            if (m) {
              for (let k = 0; k < n; k++, col += flip ? -1 : 1) {
                if (!((m << col) & 0x80)) continue;
                idx[outRow + x + k] = colorBase + pix[src + col];
                pri[outRow + x + k] = p;
              }
            }
            x += n; tx += n; if (tx >= mw) tx -= mw;
          }
        }
      }
    }
    this.drawSprites(flip);
    const out = this.native, pal = this.palette;
    for (let i = 0; i < out.length; i++) out[i] = idx[i] === 0xFFFF ? 0xFF000000 : pal[idx[i]];
    if (this.rotated === 90) rotate90(out, WIN.w, WIN.h, this.frame);
    else if (this.rotated === 270) rotate270(out, WIN.w, WIN.h, this.frame);
    else if (this.rotated === 180) { const f = this.frame; for (let i = 0, n = out.length; i < n; i++) f[n - 1 - i] = out[i]; }
  }

  // Sprites from the last entry back: the first one drawn at a pixel wins (so later entries are in front).
  drawSprites(flip) {
    const sr = this.spriteRam, idx = this.index, pri = this.pri, pix = this.spritePix, cnt = this.spriteCount;
    const SIZE = [16, 8, 32, 4];
    const xoffs = sr[0xFF5] + ((sr[0xFF4] & 1) << 8), yoffs = sr[0xFF7];
    for (let s = 0x800 + 0x7E0; s >= 0x800; s -= 16) {
      const attr1 = sr[s + 10], attr2 = sr[s + 14], colorByte = sr[s + 12];
      const flipX = (attr1 & 0x20) >> 5, flipY = attr2 & 1;
      const sizeX = SIZE[(attr1 & 0xC0) >> 6], sizeY = SIZE[(attr2 & 6) >> 1];
      const tx = (attr1 & 0x18) & ~(sizeX - 1), ty = (attr2 & 0x18) & ~(sizeY - 1);
      const code = (sr[s + 11] + (attr1 & 7) * 256) % cnt, color = colorByte >> 1;
      const priority = (attr2 & 0xE0) >> 5;
      let sx = sr[s + 13] + ((colorByte & 1) << 8) + xoffs;
      let sy = -sr[s + 15] - sizeY - yoffs;
      let fx = flipX, fy = flipY;
      if (flip) { sx = -sx - sizeX; sy = -sy - sizeY; fx ^= 1; fy ^= 1; }
      sy++;                                            // (the sprites are a line late)
      sx &= 0x1FF; sy = ((sy + 16) & 0xFF) - 16;
      for (let y = 0; y < sizeY; y++) {
        const py = sy + y - WIN.y;
        if (py < 0 || py >= WIN.h) continue;
        const srcRow = code * 1024 + (ty + (fy ? sizeY - 1 - y : y)) * 32 + tx;
        for (let x = 0; x < sizeX; x++) {
          let px = ((sx + x) & 0x1FF) - WIN.x;
          if (px < 0 || px >= WIN.w) continue;
          const pen = pix[srcRow + (fx ? sizeX - 1 - x : x)];
          if (pen === 15) continue;
          const o = py * WIN.w + px;
          if (pri[o] & 0x80) continue;
          const hidden = (pri[o] & 7) > priority;
          pri[o] |= 0x80;
          if (hidden) continue;
          if (color === 0x7F) { const c = idx[o]; if (c >= 0x800 && c < 0x1000) idx[o] = c + 0x800; }   // shadow
          else idx[o] = color * 16 + pen;
        }
      }
    }
  }

  // ---------------------------------------------------------------- inputs

  // CONTROL0/1: right, left, down, up, buttons 1-3, start (active low). Coins on the MCU's port 1.
  setInputs(s) {
    this.in[0] = 0xFF & ~((s.right ? 1 : 0) | (s.left ? 2 : 0) | (s.down ? 4 : 0) | (s.up ? 8 : 0)
      | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0) | (s.fire3 ? 0x40 : 0) | (s.start1 ? 0x80 : 0));
    this.in[1] = 0xFF & ~(s.start2 ? 0x80 : 0);
    this.in[2] = 0xFF & ~(s.coin ? 0x10 : 0);
  }
  applySwitches() { this.dsw = 0xFF; }
}
NamcoSystem1.switches = [];

// Splatterhouse (1988): attack and jump. Key chip CUS181; the board flips its picture, the cabinet turns it back.
export class Splatterhouse extends NamcoSystem1 {
  constructor(roms) { super(roms, { key: 'type3', keyId: 181, keyReg: 3, keyRng: 4, rotate: 180 }); this.buttons = 2; this.button2 = 'Jump'; }
}
Splatterhouse.id = 'splatter';
Splatterhouse.title = 'Splatterhouse';

// Galaga '88 (1987): fire. Key chip CUS153; a vertical monitor.
export class Galaga88 extends NamcoSystem1 {
  constructor(roms) { super(roms, { key: 'type2', keyId: 0x31, rotate: 270 }); this.buttons = 1; }
}
Galaga88.id = 'galaga88';
Galaga88.title = "Galaga '88";

// Pac-Mania (1987): an 8-way stick and jump. Key chip CUS151; a vertical monitor.
export class PacMania extends NamcoSystem1 {
  constructor(roms) { super(roms, { key: 'type2', keyId: 0x12, rotate: 270 }); this.buttons = 1; }   // the button jumps
}
PacMania.id = 'pacmania';
PacMania.title = 'Pac-Mania';
