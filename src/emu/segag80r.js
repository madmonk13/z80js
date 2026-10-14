// Sega G-80 raster hardware (1981): Space Odyssey. A Z80 at 3.87 MHz draws a
// 32x28 map of 8x8 two-bit characters whose shapes live in video RAM (the
// program writes its own character set), through 64 colors of 3-3-2 bits.
// Writes to RAM and video RAM pass through a 315-0063 security chip: for a
// LD (nn),A the low byte of the address is scrambled, keyed by where the
// instruction sits.
//
// Space Odyssey adds a background board: a 6-bit-per-pixel tile picture
// that scrolls (horizontally or vertically, by stepping its own counters)
// behind the characters wherever they're black, with a "detect" flag set
// when the player's ship touches it. Its sound board plays recorded
// samples that aren't part of the ROM set, so the effects here are
// synthesized stand-ins.
//
// 256x224 at 60 Hz on a vertical monitor; one IRQ per frame when enabled.

import { Z80 } from './z80.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, rotate270, run } from './video.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, LINES = 262, REFRESH = 60, CLOCK = 15468000 / 4;
const STATE = ['ram', 'vram', 'palRam', 'videoCtl', 'vblankLatch', 'hcounter', 'vcounter', 'fixedColor', 'bgControl', 'bgDetect',
  'bgEnable', 'soundLines', 'in', 'cycleCarry', 'sampleCarry', 'cpu', 'sound'];

// The 315-0063 security chip's address scramble (which of four rules depends on bits 0 and 3 of the instruction's address).
function decrypt63(pc, b) {
  switch (pc & 0x09) {
    case 0x00: return ((b & 0x23) + ((b & 0xC0) >> 4) + ((b & 0x10) << 2) + ((b & 0x08) << 1) + ((~b & 0x04) << 5)) & 0xFF;
    case 0x01: return ((b & 0x03) + ((b & 0x80) >> 4) + ((~b & 0x40) >> 1) + ((b & 0x20) >> 1) + ((b & 0x10) >> 2) + ((b & 0x08) << 3) + ((b & 0x04) << 5)) & 0xFF;
    case 0x08: return ((b & 0x03) + ((b & 0x80) >> 1) + ((b & 0x60) >> 3) + (~b & 0x10) + ((b & 0x08) << 2) + ((b & 0x04) << 5)) & 0xFF;
    default: return b;
  }
}

// The four input ports are read a bit pair at a time through a multiplexer.
function demangle(d76, d54, d32, d10) {
  return ((d76 << 7) & 0x80) | ((d76 << 2) & 0x40) | ((d54 << 5) & 0x20) | (d54 & 0x10)
    | ((d32 << 3) & 0x08) | ((d32 >> 2) & 0x04) | ((d10 << 1) & 0x02) | ((d10 >> 4) & 0x01);
}

// Synthesized effects: each sound line starts a short voice (noise bursts for
// explosions, sweeps and tones for the rest); the background drone loops while its line is low.
const EFFECTS = {
  shortExp: { noise: 1, dur: 0.35, f0: 0, f1: 0, vol: 0.5 },
  longExp: { noise: 1, dur: 1.2, f0: 0, f1: 0, vol: 0.6 },
  dBomb: { noise: 1, dur: 0.9, f0: 0, f1: 0, vol: 0.6 },
  shot: { noise: 0, dur: 0.12, f0: 1800, f1: 400, vol: 0.3 },
  accelerate: { noise: 0, dur: 0.6, f0: 120, f1: 600, vol: 0.25 },
  battleStar: { noise: 0, dur: 0.8, f0: 900, f1: 300, vol: 0.25 },
  bonusUp: { noise: 0, dur: 0.5, f0: 600, f1: 1400, vol: 0.25 },
  warp: { noise: 0, dur: 0.9, f0: 200, f1: 2000, vol: 0.25 },
  ufo: { noise: 0, dur: 0.6, f0: 700, f1: 500, vol: 0.2 },
};
class Effects {
  constructor() { this.reset(); }
  reset() { this.voices = []; this.drone = 0; this.phase = 0; this.rng = 1; this.out = 0; }
  saveState() { return { voices: this.voices.map((v) => ({ ...v })), drone: this.drone, phase: this.phase, rng: this.rng }; }
  loadState(s) { this.voices = s.voices.map((v) => ({ ...v })); this.drone = s.drone; this.phase = s.phase; this.rng = s.rng; }
  start(name) { this.voices.push({ name, t: 0, phase: 0 }); if (this.voices.length > 8) this.voices.shift(); }
  sample() {
    let sum = 0;
    for (const v of this.voices) {
      const e = EFFECTS[v.name], k = v.t / e.dur, env = (1 - k) * (1 - k);
      if (e.noise) { this.rng = (this.rng * 1103515245 + 12345) >>> 0; sum += ((this.rng >>> 16) / 32768 - 1) * env * e.vol; }
      else { v.phase += (e.f0 + (e.f1 - e.f0) * k) / RATE; sum += (v.phase % 1 < 0.5 ? 1 : -1) * env * e.vol; }
      v.t += 1 / RATE;
    }
    this.voices = this.voices.filter((v) => v.t < EFFECTS[v.name].dur);
    if (this.drone) { this.phase += 55 / RATE; sum += Math.sin(this.phase * 2 * Math.PI) * 0.12 * (0.6 + 0.4 * Math.sin(this.phase * 0.25)); }
    this.out = sum;
  }
}

export class SpaceOdyssey {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 64; i++) this.setColor(i); }

  // roms: { main (0000-BFFF), bgTiles (six 1-bit planes), bgMap (the background picture's tile codes) }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Bomb';
    this.roms = roms;
    this.ram = new Uint8Array(0x800);          // C800-CFFF
    this.vram = new Uint8Array(0x2000);        // E000-FFFF: map, character shapes
    this.palRam = new Uint8Array(0x40);
    this.palette = new Uint32Array(64).fill(0xFF000000);
    this.soundLines = new Uint8Array(2);
    const q = roms.bgTiles.length / 6 * 8;
    this.bgPix = decodeTiles(roms.bgTiles, { count: roms.bgTiles.length / 48, width: 8, height: 8, planes: run(0, 6, q), xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    // The background board's fixed 64-color palette (2 bits per gun through 1.8K/1.2K).
    const lv = [0, 102, 153, 255];
    this.bgPalette = Uint32Array.from({ length: 64 }, (_, i) => rgba(lv[(i >> 4) & 3], lv[(i >> 2) & 3], lv[i & 3]));
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v), input: (p) => this.portIn(p), output: (p, v) => this.portOut(p, v) });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.fx = new Effects();
    this.sound = new SoundMix([this.fx], 0.55);
    this.native = new Uint32Array(W * H);
    this.fg = new Uint8Array(W * H);           // palette index of each foreground pixel
    this.frame = new Uint32Array(W * H);
    this.in = { d76: 0xFF, d54: 0xFF, fc: 0 };
    this.applySwitches();
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.palRam.fill(0); this.palette.fill(0xFF000000); this.soundLines.fill(0xFF);
    this.videoCtl = 0; this.vblankLatch = 0; this.hcounter = 0; this.vcounter = 0;
    this.fixedColor = 0; this.bgControl = 0; this.bgDetect = 0; this.bgEnable = 0;
    this.cycleCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // Bits 0-2 red, 3-5 green (4.7K/2.4K/1.2K), 6-7 blue (2K/1K).
  setColor(i) {
    const d = this.palRam[i], rg = [0, 37, 73, 110, 145, 182, 218, 255], b = [0, 85, 170, 255];
    this.palette[i] = rgba(rg[d & 7], rg[(d >> 3) & 7], b[d >> 6]);
  }

  // A LD (nn),A has the low byte of its address scrambled by the security chip.
  decrypt(a) {
    const pc = this.cpu.opPc;
    if (this.roms.main[pc] !== 0x32) return a;
    return (a & 0xFF00) | decrypt63(pc, this.roms.main[(pc + 1) & 0xFFFF]);
  }

  read(a) {
    if (a < 0xC000) return this.roms.main[a] ?? 0xFF;
    if (a >= 0xC800 && a < 0xD000) return this.ram[a - 0xC800];
    if (a >= 0xE000) return this.vram[a - 0xE000];
    return 0xFF;
  }
  write(a, v) {
    if (a >= 0xC800 && a < 0xD000) { this.ram[this.decrypt(a) - 0xC800 & 0x7FF] = v; return; }
    if (a >= 0xE000) {
      const o = (this.decrypt(a) - 0xE000) & 0x1FFF;
      if ((o & 0x1000) && (this.videoCtl & 0x02)) { this.palRam[o & 0x3F] = v; this.setColor(o & 0x3F); return; }
      this.vram[o] = v;
    }
  }

  portIn(p) {
    p &= 0xFF;
    if (p >= 0x08 && p <= 0x0F) return 0xFE | this.bgDetect;
    if (p === 0xBF) return this.vblankLatch | ((this.videoCtl & 1) << 1) | (this.videoCtl & 0x04) | 0xF8;
    if (p >= 0xF8 && p <= 0xFB) {
      // Upright cabinet: the stick's up and both buttons arrive through these ports.
      const fc = this.in.fc, s = p & 3;
      const d76 = this.in.d76 | 0x60;
      const d54 = (this.in.d54 & ~0x1C) | ((~fc & 0x20) >> 3) | ((~fc & 0x10) >> 1) | ((~fc & 0x08) << 1) | 0xC0;
      return demangle(d76 >> s, d54 >> s, this.dsw >> s, this.coinage >> s);
    }
    if (p === 0xFC) { const fc = this.in.fc; return ((fc & 0x02) >> 1) | ((fc & 0x01) << 1) | (fc & 0x04); }
    return 0xFF;
  }
  portOut(p, v) {
    p &= 0xFF;
    if (p === 0x0E || p === 0x0F) { this.soundWrite(p & 1, v); return; }
    if (p >= 0x08 && p <= 0x0D) {
      switch (p & 7) {
        case 0: this.bgControl = v; return;
        case 1: this.hcounter = 0; this.vcounter = 0; return;
        case 2:                                    // step the H or V counter, up or down
          if (!(this.bgControl & 2)) this.hcounter = (this.hcounter + (this.bgControl & 1 ? -1 : 1)) & 0xFFFF;
          else this.vcounter = (this.vcounter + (this.bgControl & 1 ? -1 : 1)) & 0xFFFF;
          return;
        case 3: this.bgDetect = 0; return;
        case 4: this.bgEnable = v & 1; return;
        case 5: this.fixedColor = v & 0x3F; return;
      }
    }
    if (p === 0xBF) this.videoCtl = v;
  }

  // The sound lines (active low): a falling edge starts an effect; "BACK G" drones while low.
  soundWrite(o, v) {
    const diff = v ^ this.soundLines[o];
    this.soundLines[o] = v;
    const fell = (bit) => (diff & bit) && !(v & bit);
    if (o === 0) {
      if (diff & 0x01) this.fx.drone = !(v & 0x01) ? 1 : 0;
      if (fell(0x04)) this.fx.start('shortExp');
      if (fell(0x10)) this.fx.start('accelerate');
      if (fell(0x20)) this.fx.start('battleStar');
      if (fell(0x40)) this.fx.start('dBomb');
      if (fell(0x80)) this.fx.start('longExp');
    } else {
      if (fell(0x01)) this.fx.start('shot');
      if (fell(0x02)) this.fx.start('bonusUp');
      if (fell(0x08)) this.fx.start('warp');
      if (fell(0x40)) this.fx.start('ufo');
    }
  }

  runFrame() {
    const cyc = CLOCK / REFRESH / LINES, samples = RATE / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === H) {
        this.render();
        this.vblankLatch = 1;                      // a 555 holds this for about 60 us
        if (this.videoCtl & 0x04) this.cpu.irq = true;
      } else if (line === H + 1) this.vblankLatch = 0;
      this.cycleCarry += cyc;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }
  render() {
    const v = this.vram, fg = this.fg, out = this.native, pal = this.palette;
    // Characters: codes at E000, shapes at E800 (low plane) and F800 (high plane); color = code >> 4.
    for (let row = 0; row < 28; row++) {
      for (let col = 0; col < 32; col++) {
        const t = v[row * 32 + col], color = (t >> 4) * 4;
        for (let y = 0; y < 8; y++) {
          const lo = v[0x800 + t * 8 + y], hi = v[0x1800 + t * 8 + y], o = (row * 8 + y) * W + col * 8;
          for (let x = 0; x < 8; x++) fg[o + x] = color + (((hi >> (7 - x)) & 1) << 1 | ((lo >> (7 - x)) & 1));
        }
      }
    }
    // Background: wherever the foreground color is black; it scrolls by its own counters.
    const vertical = this.bgControl & 2, flip = this.bgControl & 1 ? 0xFF : 0, xoff = vertical ? 0x10 : 0;
    const mw = vertical ? 256 : 1024, mh = vertical ? 1024 : 256, map = this.roms.bgMap, bank = 0x1000 * (this.bgControl >> 6);
    const charBank = 0x100 * ((this.bgControl >> 2) & 1), bgp = this.bgPix, nTiles = bgp.length / 64;
    for (let y = 0; y < H; y++) {
      const ey = ((y + this.vcounter + 22) ^ flip) & (mh - 1);
      for (let x = 0; x < W; x++) {
        const i = y * W + x, fgIdx = fg[i], fgpix = this.palRam[fgIdx];
        if (this.bgEnable) { out[i] = pal[fgIdx]; continue; }          // background off
        const ex = (((x + this.hcounter) ^ flip) + xoff) & (mw - 1);
        const col = ex >> 3, row = ey >> 3;
        const ti = (row & 31) * 32 + (col & 31) + (row >> 5) * 1024 + (col >> 5) * 1024;
        const code = ((map[ti + bank] ?? 0) + charBank) % nTiles;
        const bgpix = bgp[code * 64 + (ey & 7) * 8 + (ex & 7)] & 0x3F;
        if (bgpix && fgpix && (fgIdx >> 2) === 1) this.bgDetect = 1;   // the ship (color 1) over the background
        out[i] = fgpix === 0 ? this.bgPalette[bgpix | this.fixedColor] : pal[fgIdx];
      }
    }
    rotate270(out, W, H, this.frame);
  }

  // FC (active high): left, right, down, up, fire, bomb. D7D6: coin. D5D4: starts.
  setInputs(s) {
    this.in.fc = (s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.down ? 4 : 0) | (s.up ? 8 : 0) | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0);
    this.in.d76 = 0xFF & ~(s.coin ? 0x01 : 0);
    this.in.d54 = 0xFF & ~((s.start1 ? 0x02 : 0) | (s.start2 ? 0x20 : 0));
  }
  // Switch bank 1: lives, upright, bonus, no infinite lives; bank 2: 1 coin 1 credit.
  applySwitches() { this.dsw = 0xE4; this.coinage = 0x33; }
}
SpaceOdyssey.id = 'spaceod';
SpaceOdyssey.title = 'Space Odyssey';
SpaceOdyssey.switches = [];
