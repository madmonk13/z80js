// Midway Y-unit (1990-92): Smash T.V., Total Carnage, Mortal Kombat. A
// TMS34010 graphics CPU at 48 (or 40) MHz / 8 runs everything. The picture is
// a 512x512 bitmap of 16-bit pixels (an 8-bit color plus an 8-bit palette
// select) that the TMS34010 scans out; a DMA blitter draws the graphics into
// it from up to 8MB of ROM (6 bits per pixel, from three 2-bit planes),
// copying, recoloring, flipping and skipping zero pixels, and interrupts the
// CPU when done. Colors come from 4096 15-bit palette entries. A battery
// "CMOS" RAM keeps settings and scores; some games check a protection chip
// that returns a fixed sequence.
//
// Sound is a separate Williams board with its own 6809:
//   CVSD (Smash T.V.): YM2151, an 8-bit DAC through a 6821 PIA, and an
//     HC55516 speech decoder fed bit by bit.
//   ADPCM (Total Carnage, Mortal Kombat): YM2151, a DAC and an OKI M6295
//     playing banked samples.
// The main CPU sends a byte (plus a strobe bit) and the sound CPU takes it on
// an interrupt.

import { TMS34010, INT1 } from './tms34010.js';
import { M6809 } from './m6809.js';
import { YM2151 } from './ym2151.js';
import { OKIM6295 } from './okim6295.js';
import { HC55516 } from './hc55516.js';
import { PIA6821 } from './pia6821.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

// Y-unit: 400x254 at 54.71 Hz. Z-unit (NARC): medium resolution, 512x400 at 54.9 Hz.
const Y_SCREEN = [400, 254, 54.71], Z_SCREEN = [512, 400, 54.9];

class DAC {
  constructor(gain) { this.gain = gain; this.reset(); }
  reset() { this.level = 0; this.out = 0; }
  sample() { this.out = this.level * this.gain; }
  write(v) { this.level = (v - 0x80) / 128; }
  saveState() { return { level: this.level }; }
  loadState(s) { this.level = s.level; }
}

// ---------------------------------------------------------------- sound boards

const SOUND_CLOCK = 2000000;

// Williams ADPCM board: rom = the 6809's 256K program ROM, samples = the OKI ROMs as loaded (U12, U13).
class AdpcmSound {
  constructor(rom, samples, prot) {
    this.rom = rom.slice();                       // the protection overlay writes into it
    this.ram = new Uint8Array(0x2000);
    this.prot = prot;
    this.oki = new OKIM6295(1000000, expandAdpcm(samples), 0.45);
    this.ym = new YM2151(3579545, 0.35);
    this.dac = new DAC(0.4);
    this.mix = new SoundMix([this.ym, this.dac, this.oki], 1.2);
    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.reset();
  }
  saveState() { return capture(this, ['ram', 'bank', 'latch', 'cpu', 'mix', 'protRam']); }
  loadState(s) { apply(this, ['ram', 'bank', 'latch', 'cpu', 'mix', 'protRam'], s); this.restoreProt(); }

  reset() {
    this.ram.fill(0); this.bank = 0; this.latch = 0;
    this.protRam = this.rom.slice(0x3C000 + this.prot[0] - 0xC000, 0x3C000 + this.prot[1] - 0xC000 + 1);
    this.restoreProt();
    this.mix.reset(); this.cpu.reset();
  }
  restoreProt() { this.rom.set(this.protRam, 0x3C000 + this.prot[0] - 0xC000); }

  command(v) {
    this.latch = v & 0xFF;
    if (!(v & 0x200)) this.cpu.irq = true;
  }

  read(a) {
    if (a < 0x2000) return this.ram[a];
    if (a >= 0xC000) return this.rom[0x3C000 + a - 0xC000];
    if (a >= 0x4000) return this.rom[this.bank * 0x8000 + a - 0x4000];
    switch (a & 0xFC00) {
      case 0x2400: return a & 1 ? this.ym.read() : 0xFF;
      case 0x2C00: return this.oki.read();
      case 0x3000: this.cpu.irq = false; return this.latch;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a < 0x2000) { this.ram[a] = v; return; }
    if (a >= this.prot[0] && a <= this.prot[1]) { this.rom[0x3C000 + a - 0xC000] = v; this.protRam[a - this.prot[0]] = v; return; }
    switch (a & 0xFC00) {
      case 0x2000: this.bank = v & 7; return;
      case 0x2400: if (a & 1) this.ym.write(v); else this.ym.select(v); return;
      case 0x2800: this.dac.write(v); return;
      case 0x2C00: this.oki.write(v); return;
      case 0x3400: this.oki.bank = (v & 7) * 0x40000; return;
    }
  }

  run(cycles, dt) {
    this.cpu.firq = this.ym.irq;
    this.cpu.run(cycles);
    this.ym.timers(dt);
  }
}

// The OKI's ROM space: eight 256K banks, each a 128K bank from U12/U13 plus a common 128K.
function expandAdpcm(src) {
  const rom = new Uint8Array(0x200000);
  rom.set(src.subarray(0, 0x200000));
  const copy = (to, from) => rom.set(rom.slice(from, from + 0x20000), to);
  copy(0x1C0000, 0x080000); copy(0x180000, 0x0A0000); copy(0x140000, 0x0C0000); copy(0x100000, 0x0E0000);
  copy(0x0C0000, 0x000000); copy(0x000000, 0x040000); copy(0x080000, 0x020000);
  for (const to of [0x1E0000, 0x1A0000, 0x160000, 0x120000, 0x0E0000, 0x0A0000, 0x020000]) copy(to, 0x060000);
  return rom;
}

// Williams CVSD board: rom = 512K (U4, U19, U20 each twice).
class CvsdSound {
  constructor(rom, prot) {
    this.rom = rom.slice();
    this.ram = new Uint8Array(0x800);
    this.prot = prot;
    this.ym = new YM2151(3579545, 0.35);
    this.dac = new DAC(0.5);
    this.cvsd = new HC55516(0.8);
    this.mix = new SoundMix([this.ym, this.dac, this.cvsd], 1.2);
    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.pia = new PIA6821({
      inB: () => this.latch,
      outA: (v) => this.dac.write(v),
      irqA: (on) => { this.cpu.firq = on; },
      irqB: (on) => { if (on && !this.nmiLine) this.cpu.nmi(); this.nmiLine = on; },
    });
    this.reset();
  }
  saveState() { return capture(this, ['ram', 'bank', 'latch', 'nmiLine', 'cpu', 'pia', 'mix', 'protRam']); }
  loadState(s) { apply(this, ['ram', 'bank', 'latch', 'nmiLine', 'cpu', 'pia', 'mix', 'protRam'], s); this.rom.set(this.protRam, this.prot[0] - 0x8000); }

  reset() {
    this.ram.fill(0); this.bank = 0; this.latch = 0; this.nmiLine = false;
    this.protRam = this.rom.slice(this.prot[0] - 0x8000, this.prot[1] - 0x8000 + 1);
    this.pia.reset(); this.pia.setC1('A', 1);
    this.mix.reset(); this.cpu.reset();
  }

  command(v) {
    this.latch = v & 0xFF;
    this.pia.setC1('B', (v >> 9) & 1);           // the main board's bit 9 arrives as the strobe
  }

  read(a) {
    if (a < 0x2000) return this.ram[a & 0x7FF];
    if (a >= 0x8000) return this.rom[0x8000 * ((this.bank >> 2) & 3) + 0x20000 * (this.bank & 3) + a - 0x8000];
    if (a < 0x4000) return a & 1 ? this.ym.read() : 0xFF;
    if (a < 0x6000) return this.pia.read(a & 3);
    return 0xFF;
  }

  write(a, v) {
    if (a < 0x2000) { this.ram[a & 0x7FF] = v; return; }
    if (a >= this.prot[0] && a <= this.prot[1]) { this.rom[a - 0x8000] = v; this.protRam[a - this.prot[0]] = v; return; }
    if (a < 0x4000) { if (a & 1) this.ym.write(v); else this.ym.select(v); return; }
    if (a < 0x6000) { this.pia.write(a & 3, v); return; }
    if (a < 0x6800) { this.cvsd.digit(v); this.cvsd.clock(0); return; }
    if (a < 0x7000) { this.cvsd.clock(1); return; }
    if (a >= 0x7800) this.bank = v & 15;
  }

  run(cycles, dt) {
    this.pia.setC1('A', this.ym.irq ? 0 : 1);
    this.cpu.run(cycles);
    this.ym.timers(dt);
  }
}

// Williams NARC sound board: two 6809s at 2 MHz. The master plays music on a
// YM2151 and a DAC and passes a second command to the slave, which has its
// own DAC and a CVSD speech chip. Each banks 32K windows of its four ROM
// sockets (two on the master) in at 4000, with the last 16K fixed at C000.
// rom / rom2: the master's and slave's 512K regions (sockets 128K apart, each 64K ROM twice).
class NarcSound {
  constructor(rom, rom2, prot) {
    this.rom = rom.slice();
    this.rom2 = rom2;
    this.prot = prot;
    this.ram = new Uint8Array(0x2000);
    this.ram2 = new Uint8Array(0x2000);
    this.ym = new YM2151(3579545, 0.2);
    this.dac = new DAC(0.5);
    this.dac2 = new DAC(0.5);
    this.cvsd = new HC55516(0.6);
    this.mix = new SoundMix([this.ym, this.dac, this.dac2, this.cvsd], 0.7);
    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu2 = new M6809({ read: (a) => this.read2(a), write: (a, v) => this.write2(a, v) });
    this.reset();
  }
  saveState() { return capture(this, ['ram', 'ram2', 'bank', 'bank2', 'latch', 'latch2', 'nmiLine', 'cpu', 'cpu2', 'mix', 'protRam']); }
  loadState(s) { apply(this, ['ram', 'ram2', 'bank', 'bank2', 'latch', 'latch2', 'nmiLine', 'cpu', 'cpu2', 'mix', 'protRam'], s); this.restoreProt(); }

  reset() {
    this.ram.fill(0); this.ram2.fill(0);
    this.bank = 0; this.bank2 = 0; this.latch = 0; this.latch2 = 0; this.nmiLine = false;
    this.protRam = this.rom.slice(this.fixed(this.prot[0]), this.fixed(this.prot[1]) + 1);
    this.restoreProt();
    this.mix.reset(); this.cpu.reset(); this.cpu2.reset();
  }
  fixed(a) { return 0x7C000 + a - 0xC000; }
  restoreProt() { this.rom.set(this.protRam, this.fixed(this.prot[0])); }
  // Bank bits: 0 = A15, 1-2 = socket, 3 = A16.
  banked(rom, b, a) { return rom[0x8000 * (b & 1) + 0x10000 * ((b >> 3) & 1) + 0x20000 * ((b >> 1) & 3) + a - 0x4000]; }

  // From the main board: the byte, NMI while bit 8 is low, IRQ when bit 9 is low.
  command(v) {
    this.latch = v & 0xFF;
    const nmi = !(v & 0x100);
    if (nmi && !this.nmiLine) this.cpu.nmi();
    this.nmiLine = nmi;
    if (!(v & 0x200)) this.cpu.irq = true;
  }

  read(a) {
    if (a < 0x2000) return this.ram[a];
    if (a >= 0xC000) return this.rom[this.fixed(a)];
    if (a >= 0x4000) return this.banked(this.rom, this.bank, a);
    if ((a & 0xFC00) === 0x2000) return a & 1 ? this.ym.read() : 0xFF;
    if ((a & 0xFC00) === 0x3400) { this.cpu.irq = false; return this.latch; }
    return 0xFF;
  }
  write(a, v) {
    if (a < 0x2000) { this.ram[a] = v; return; }
    if (a >= this.prot[0] && a <= this.prot[1]) { this.rom[this.fixed(a)] = v; this.protRam[a - this.prot[0]] = v; return; }
    switch (a & 0xFC00) {
      case 0x2000: if (a & 1) this.ym.write(v); else this.ym.select(v); return;
      case 0x2C00: this.latch2 = v; this.cpu2.firq = true; return;
      case 0x3000: this.dac.write(v); return;
      case 0x3800: this.bank = v & 15; return;
    }
  }
  read2(a) {
    if (a < 0x2000) return this.ram2[a];
    if (a >= 0xC000) return this.rom2[this.fixed(a)];
    if (a >= 0x4000) return this.banked(this.rom2, this.bank2, a);
    if ((a & 0xFC00) === 0x3400) { this.cpu2.firq = false; return this.latch2; }
    return 0xFF;
  }
  write2(a, v) {
    if (a < 0x2000) { this.ram2[a] = v; return; }
    switch (a & 0xFC00) {
      case 0x2000: this.cvsd.clock(1); return;
      case 0x2400: this.cvsd.digit(v); this.cvsd.clock(0); return;
      case 0x3000: this.dac2.write(v); return;
      case 0x3800: this.bank2 = v & 15; return;
    }
  }

  run(cycles, dt) {
    this.cpu.firq = this.ym.irq;
    this.cpu.run(cycles);
    this.cpu2.run(cycles);
    this.ym.timers(dt);
  }
}

// ---------------------------------------------------------------- the board

const STATE = ['vram', 'ram', 'cmos', 'pal', 'dma', 'cmosPage', 'videoBank', 'autoErase', 'protSeq', 'protIndex', 'protResult',
  'cycleCarry', 'soundCarry', 'sampleCarry', 'dmaDone', 'in0', 'in1', 'cpu', 'snd'];

export class MidwayYUnit {
  saveState() { return capture(this, STATE); }
  loadState(s) {
    apply(this, STATE, s);
    for (let i = 0; i < this.pal.length; i++) this.setColor(i);
    this.cpu.nextEvent = this.dmaDone ?? Infinity;
  }

  // roms: { program (1MB, little-endian words), gfx (the graphics ROM region, 8MB), sound, samples? }
  constructor(roms) {
    const k = this.constructor;
    [this.W, this.H, this.REFRESH] = k.zunit ? Z_SCREEN : Y_SCREEN;
    this.width = this.W;
    this.height = this.H;
    this.refresh = this.REFRESH;
    this.controls = 'eight-way';
    this.buttons = k.buttons ?? 0;
    this.roms = roms;
    this.clock = (k.slowCpu ? 40000000 : 48000000) / 8;
    this.vram = new Uint16Array(512 * 512);
    this.ram = new Uint16Array(0x10000);
    this.cmos = new Uint16Array(0x8000);
    this.nvram = this.cmos;                        // kept between sessions (settings, high scores)
    this.pal = new Uint16Array(0x2000);
    this.palette = new Uint32Array(0x2000).fill(0xFF000000);
    this.dma = new Uint16Array(16);
    this.frame = new Uint32Array(this.W * this.H);
    this.gfx = decodeGfx(roms.gfx, k.zunit ? 8 : 6);

    this.cpu = new TMS34010({
      read16: (a) => this.read(a), write16: (a, v, m) => this.write(a, v, m),
      toShiftReg: (a, sr) => sr.set(this.vram.subarray((a >>> 3) & 0x3FFFF, ((a >>> 3) & 0x3FFFF) + 1024)),
      fromShiftReg: (a, sr) => this.vram.set(sr.subarray(0, Math.min(1024, 0x40000 - ((a >>> 3) & 0x3FFFF))), (a >>> 3) & 0x3FFFF),
    });
    this.cpu.onEvent = () => this.dmaFinished();
    this.snd = k.sound === 'cvsd' ? new CvsdSound(roms.sound, k.soundProt) : k.sound === 'narc' ? new NarcSound(roms.sound, roms.sound2, k.soundProt)
      : new AdpcmSound(roms.sound, roms.samples, k.soundProt);
    this.sound = this.snd.mix;
    this.in0 = this.in1 = 0xFFFF;
    this.applySwitches(defaultSwitches(k.switches));
    this.reset();
  }

  reset() {
    this.vram.fill(0); this.ram.fill(0); this.pal.fill(0); this.dma.fill(0);
    this.palette.fill(0xFF000000);
    this.cmosPage = 0; this.videoBank = 0; this.autoErase = 0;
    this.protSeq = [0, 0, 0]; this.protIndex = 0; this.protResult = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.dmaDone = Infinity;
    this.cpu.reset(); this.cpu.nextEvent = Infinity;
    this.snd.reset();
  }

  // ---------------------------------------------------------------- main bus (word addresses)

  read(a) {
    if (a < 0x20000) {                             // video RAM: two pixels a word, color bytes or palette bytes
      const o = a * 2;
      return this.videoBank ? (this.vram[o] & 0xFF) | ((this.vram[o + 1] & 0xFF) << 8) : (this.vram[o] >> 8) | (this.vram[o + 1] & 0xFF00);
    }
    if (a >= 0xFF80000) { const o = (a - 0xFF80000) * 2; return this.roms.program[o] | (this.roms.program[o + 1] << 8); }
    if (a >= 0x200000 && a < 0x600000) {
      const o = (a - 0x200000) * 2, g = this.gfx;
      return this.constructor.fourBit ? g[o] | (g[o] << 4) | (g[o + 1] << 8) | (g[o + 1] << 12) : g[o] | (g[o + 1] << 8);
    }
    if (a >= 0x100000 && a < 0x110000) return this.ram[a - 0x100000];
    if (a >= 0x140000 && a < 0x141000) return this.cmos[a - 0x140000 + this.cmosPage];
    if (a >= 0x180000 && a < 0x182000) return this.pal[a - 0x180000];
    if ((a & ~0x8000) >= 0x1A0000 && (a & ~0x8000) < 0x1A000A) return this.dma[a & 15];
    if (a >= 0x1C0000 && a < 0x1C0006) return this.input(a - 0x1C0000);
    if (a >= 0x1C0006 && a < 0x1C0008) return this.protResult;
    return 0xFFFF;
  }

  write(a, v, m) {
    if (a < 0x20000) {
      const o = a * 2, vr = this.vram;
      if (this.videoBank) {
        if (m & 0x00FF) vr[o] = (v & 0xFF) | (this.dma[8] << 8);
        if (m & 0xFF00) vr[o + 1] = (v >> 8) | (this.dma[8] & 0xFF00);
      } else {
        if (m & 0x00FF) vr[o] = (vr[o] & 0xFF) | (v << 8);
        if (m & 0xFF00) vr[o + 1] = (vr[o + 1] & 0xFF) | (v & 0xFF00);
      }
      return;
    }
    const merge = (old) => (old & ~m) | (v & m);
    if (a >= 0x100000 && a < 0x110000) { this.ram[a - 0x100000] = merge(this.ram[a - 0x100000]); return; }
    if (a >= 0x140000 && a < 0x141000) { const i = a - 0x140000 + this.cmosPage; this.cmos[i] = merge(this.cmos[i]); return; }
    if (a >= 0x180000 && a < 0x182000) { const i = a - 0x180000; this.pal[i] = merge(this.pal[i]); this.setColor(i); return; }
    if ((a & ~0x8000) >= 0x1A0000 && (a & ~0x8000) < 0x1A000A) { this.dmaWrite(a & 15, merge(this.dma[a & 15])); return; }
    if (a >= 0x1C0006 && a < 0x1C0008) { this.protWrite(v); return; }
    if (a === 0x1E0000) { if (m === 0xFFFF) this.snd.command(v); return; }
    if (a === 0x1F0000 && (m & 0xFF)) {            // control: CMOS page, video bank, auto-erase
      this.cmosPage = ((v >> 6) & 3) * 0x1000;
      this.videoBank = (v >> 5) & 1;
      this.autoErase = (v & 0x10) ? 0 : 1;
    }
  }

  setColor(i) {
    const v = this.pal[i], c = (x) => (x << 3) | (x >> 2);
    this.palette[i & (this.constructor.fourBit ? 0xFF : this.constructor.zunit ? 0x1FFF : 0xFFF)] = rgba(c((v >> 10) & 31), c((v >> 5) & 31), c(v & 31));
  }

  // ---------------------------------------------------------------- protection

  // A chip clocked by writes to the CMOS-enable port returns a fixed sequence.
  protWrite(v) {
    const p = this.constructor.protection;
    if (!p) return;
    v &= 0x0F00;
    const s = this.protSeq;
    s[0] = s[1]; s[1] = s[2]; s[2] = v;
    if (s[0] === p.reset[0] && s[1] === p.reset[1] && s[2] === p.reset[2]) this.protIndex = 0;
    if ((s[1] & 0x0800) && !(s[2] & 0x0800)) this.protResult = p.data[this.protIndex++] ?? 0;
  }

  // ---------------------------------------------------------------- DMA blitter

  dmaWrite(r, v) {
    this.dma[r] = v;
    if (r !== 0) return;
    this.cpu.setLine(INT1, false);
    if (!(v & 0x8000)) return;
    const d = this.dma, cmd = v;
    let rowbytes = (d[1] << 16) >> 16, xpos = (d[4] << 16) >> 16, ypos = (d[5] << 16) >> 16;
    let width = d[6], height = d[7];
    const pal = d[8] << 8, color = pal | (d[9] & 0xFF);
    let gfxoffset = (d[2] | (d[3] << 16)) >>> 0;
    const xflip = cmd & 0x10;
    if (xflip) {
      gfxoffset = (gfxoffset - (width - 1) * 8) >>> 0;
      rowbytes = (rowbytes - width + 3) & ~3;
      xpos += width - 1;
    } else rowbytes = (rowbytes + width + 3) & ~3;
    if ((cmd & 0x0F) === 0x0C) gfxoffset = 0;
    if (gfxoffset < 0x02000000) gfxoffset += 0x02000000;
    const done = () => { this.dmaDone = this.cpu.cycles + Math.ceil(41e-9 * width * height * this.clock); this.cpu.nextEvent = this.dmaDone; };
    if (gfxoffset >= 0x06000000) { done(); return; }
    let offset = (gfxoffset - 0x02000000) >>> 3;   // in pixels
    // Clipping to the 512x512 bitmap.
    if (ypos < 0) { height += ypos; offset += -ypos * rowbytes; ypos = 0; }
    if (ypos + height > 512) height = 512 - ypos;
    if (!xflip) {
      if (xpos < 0) { width += xpos; offset += -xpos; xpos = 0; }
      if (xpos + width > 512) width = 512 - xpos;
    } else {
      if (xpos >= 512) { width -= xpos - 511; offset += xpos - 511; xpos = 511; }
      if (xpos - width < 0) width = xpos;
    }
    const mode = cmd & 0x0F, zero = mode & 1 ? (mode & 4 ? 1 : 2) : (mode & 4 ? 1 : 0), nonzero = mode & 2 ? (mode & 8 ? 1 : 2) : (mode & 8 ? 1 : 0);
    if ((zero || nonzero) && width > 0 && height > 0) this.blit(offset, rowbytes, xpos, ypos, width, height, pal, color, xflip, zero, nonzero);
    done();
  }

  // Pixel modes: 0 skip, 1 color, 2 copy (from ROM).
  blit(offset, rowbytes, xpos, ypos, width, height, pal, color, xflip, zero, nonzero) {
    const g = this.gfx, vr = this.vram, step = xflip ? -1 : 1, limit = g.length;
    for (let y = 0; y < height; y++) {
      let o = offset + y * rowbytes;
      const row = ((ypos + y) & 0x1FF) * 512;
      let tx = xpos;
      if (o >= limit) continue;
      for (let x = 0; x < width; x++, o++, tx += step) {
        const p = g[o] ?? 0;
        const mode = p ? nonzero : zero;
        if (mode === 1) vr[row + (tx & 0x1FF)] = color;
        else if (mode === 2) vr[row + (tx & 0x1FF)] = p | pal;
      }
    }
  }

  dmaFinished() {
    this.dmaDone = Infinity; this.cpu.nextEvent = Infinity;
    this.dma[0] &= ~0x8000;
    this.cpu.setLine(INT1, true);
  }

  // ---------------------------------------------------------------- inputs

  input(n) {
    switch (n) {
      case 0: return this.in0;
      case 1: return this.in1;
      case 2: return this.in2 ?? 0xFFFF;
      case 3: return this.dsw;
    }
    return 0xFFFF;
  }
  applySwitches(v) { this.dsw = this.constructor.dsw(v); }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const lines = (this.cpu.vtotal || 288) + 1;
    const R = this.REFRESH, per = this.clock / R / lines, sper = SOUND_CLOCK / R / lines, samples = RATE / R / lines, dt = 1 / R / lines;
    for (let line = 0; line < lines; line++) {
      const params = this.cpu.scanline(line);
      if (params) this.scanout(line, params);
      this.cycleCarry += per;
      const n = Math.floor(this.cycleCarry);
      this.cycleCarry -= n;
      this.cpu.run(n);
      this.soundCarry += sper;
      const sn = Math.floor(this.soundCarry);
      this.soundCarry -= sn;
      this.snd.run(sn, dt);
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // One line of the display: the TMS34010's display address picks the
  // bitmap row and column; auto-erase clears the row shown before it.
  scanout(line, p) {
    const y = line - p.veblnk;
    const W = this.W, H = this.H, k = this.constructor;
    if (y >= 0 && y < H) {
      const out = this.frame, o = y * W, pal = this.palette, vr = this.vram, four = k.fourBit, eight = k.zunit;
      const row = (p.rowaddr & 0x1FF) * 512;
      let col = p.coladdr << 1;
      const x0 = Math.max(0, p.heblnk), x1 = Math.min(p.hsblnk, p.heblnk + W);
      if (!p.enabled) out.fill(0xFF000000, o, o + W);
      else {
        // One loop per pixel format (8-bit Z-unit, 4-bit, 6-bit), so the format isn't tested per pixel.
        const d = o - p.heblnk;
        if (eight) for (let x = x0; x < x1; x++) out[d + x] = pal[vr[row + (col++ & 0x1FF)] & 0x1FFF];
        else if (four) for (let x = x0; x < x1; x++) { const v = vr[row + (col++ & 0x1FF)]; out[d + x] = pal[((v & 0xF000) >> 8) | (v & 0x000F)]; }
        else for (let x = x0; x < x1; x++) { const v = vr[row + (col++ & 0x1FF)]; out[d + x] = pal[((v & 0xC000) >> 8) | (v & 0x0F3F)]; }
        for (let x = x1 - p.heblnk; x < W; x++) out[o + x] = 0xFF000000;
      }
    }
    if (this.autoErase && p.enabled) {
      this.eraseRow(p.rowaddr - 1);
      if (line === p.vsblnk - 1) this.eraseRow(p.rowaddr);       // (the last line shown erases itself after)
    }
  }

  // Auto-erase copies one of the two spare rows (510, 511) over a row.
  eraseRow(r) {
    r &= 0x1FF;
    if (r < 510) this.vram.copyWithin(r * 512, (510 + (r & 1)) * 512, (511 + (r & 1)) * 512);
  }
}

// The graphics ROMs hold 2-bit slices of each pixel in three (6-bit) chunks.
// The graphics ROMs are four chunks. 6 (and 4) bits per pixel: 2 bits from each of
// the first three chunks; 8 bits: a whole byte from each chunk in turn.
function decodeGfx(src, bpp) {
  const size = src.length, chunk = size / 4, out = new Uint8Array(size);
  if (bpp === 8) {
    for (let i = 0; i < size; i++) out[i] = src[(i & 3) * chunk + (i >> 2)];
    return out;
  }
  for (let i = 0; i < size; i++) {
    const b = i >> 2, sh = 2 * (i & 3);
    out[i] = ((src[b] >> sh) & 3) | (((src[chunk + b] >> sh) & 3) << 2) | (((src[2 * chunk + b] >> sh) & 3) << 4);
  }
  return out;
}

// ---------------------------------------------------------------- games

MidwayYUnit.switches = [];

export class SmashTV extends MidwayYUnit {
  constructor(roms) { super(roms); this.twinStick = true; }
  setInputs(s) {
    const a = s.aim || {};
    this.in0 = 0xFFFF & ~((s.up ? 1 : 0) | (s.down ? 2 : 0) | (s.left ? 4 : 0) | (s.right ? 8 : 0)
      | (a.up ? 0x10 : 0) | (a.down ? 0x20 : 0) | (a.left ? 0x40 : 0) | (a.right ? 0x80 : 0));
    this.in1 = 0xFFFF & ~((s.coin ? 1 : 0) | (s.start1 ? 4 : 0) | (s.start2 ? 0x20 : 0));
  }
}
SmashTV.id = 'smashtv'; SmashTV.title = 'Smash T.V.';
SmashTV.slowCpu = true; SmashTV.sound = 'cvsd'; SmashTV.soundProt = [0x9CF6, 0x9D21];
SmashTV.dsw = () => 0xFFFF;

export class TotalCarnage extends SmashTV {}
TotalCarnage.id = 'totcarn'; TotalCarnage.title = 'Total Carnage';
TotalCarnage.slowCpu = false; TotalCarnage.sound = 'adpcm'; TotalCarnage.soundProt = [0xFC04, 0xFC2E];
TotalCarnage.protection = { reset: [0x0F00, 0x0F00, 0x0F00], data: [0x4A00, 0x6A00, 0xDA00, 0x6A00, 0x9A00, 0x4A00, 0x2A00, 0x9A00, 0x1A00, 0x8A00, 0xAA00] };
TotalCarnage.dsw = () => 0xFFFF;

export class MortalKombat extends MidwayYUnit {
  constructor(roms) { super(roms); this.button2 = 'Kick'; this.button3 = 'Block'; }
  setInputs(s) {
    this.in0 = 0xFFFF & ~((s.up ? 1 : 0) | (s.down ? 2 : 0) | (s.left ? 4 : 0) | (s.right ? 8 : 0)
      | (s.fire ? 0x10 : 0) | (s.fire3 ? 0x20 : 0) | (s.fire2 ? 0x40 : 0));
    this.in1 = 0xFFFF & ~((s.coin ? 1 : 0) | (s.start1 ? 4 : 0) | (s.start2 ? 0x20 : 0));
  }
}
MortalKombat.id = 'mkla4'; MortalKombat.title = 'Mortal Kombat';
MortalKombat.buttons = 3; MortalKombat.sound = 'adpcm'; MortalKombat.soundProt = [0xFB9C, 0xFBC6];
MortalKombat.protection = { reset: [0x0D00, 0x0C00, 0x0900], data: [0x4600, 0xF600, 0xA600, 0x0600, 0x2600, 0x9600, 0xC600, 0xE600,
  0x8600, 0x7600, 0x8600, 0x8600, 0x9600, 0xD600, 0x6600, 0xB600, 0xD600, 0xE600, 0xF600, 0x7600, 0xB600, 0xA600, 0x3600] };
MortalKombat.switches = [
  { id: 'blood', label: 'Blood', options: [['On', 0x40], ['Off', 0x00]], default: 0x40 },
  { id: 'violence', label: 'Violence', options: [['On', 0x80], ['Off', 0x00]], default: 0x80 },
  { id: 'free', label: 'Free play', options: [['Off', 0], ['On', 1]], default: 0 },
];
// Free play: coinage from the switches (bit 15) set to USA free play.
MortalKombat.dsw = (v) => (v.free ? 0x8D3F : 0x7D3F) | (v.blood ?? 0x40) | (v.violence ?? 0x80);

// Trog (1990): up to four cavemen-hunting dinosaurs, each its own start
// button; one button (punch, and eat when it's a power-up). 4-bit graphics.
export class Trog extends MidwayYUnit {
  constructor(roms) {
    super(roms);
    this.buttons = 1;
    this.startLabels = ['Red', 'Blue', 'Yellow', 'Pink'];       // the four dinosaurs' colors
    this.slot = 0;
  }
  // P1 in IN0's low byte, P2 its high; IN1 coins, starts 1-4 and P3; IN2 P4 (and coin 3).
  setInputs(s) {
    const picked = [s.start1, s.start2, s.start3, s.start4].findIndex(Boolean);
    if (picked >= 0) this.slot = picked;
    const p = (s.up ? 1 : 0) | (s.down ? 2 : 0) | (s.left ? 4 : 0) | (s.right ? 8 : 0) | (s.fire ? 0x10 : 0);
    const starts = (s.start1 ? 0x4 : 0) | (s.start2 ? 0x20 : 0) | (s.start3 ? 0x200 : 0) | (s.start4 ? 0x400 : 0);
    this.in0 = 0xFFFF & ~(this.slot === 0 ? p : this.slot === 1 ? p << 8 : 0);
    this.in1 = 0xFFFF & ~((s.coin ? 1 : 0) | starts | (this.slot === 2 ? p << 11 : 0));
    this.in2 = 0xFFFF & ~(this.slot === 3 ? p : 0);
  }
}
Trog.id = 'trog'; Trog.title = 'Trog';
Trog.slowCpu = true; Trog.fourBit = true; Trog.sound = 'cvsd'; Trog.soundProt = [0x9EAF, 0x9ED9];
Trog.protection = { reset: [0x0F00, 0x0F00, 0x0F00], data: [0x3000, 0x1000, 0x2000, 0x0000, 0x2000, 0x3000, 0x3000, 0x1000,
  0x0000, 0x0000, 0x2000, 0x3000, 0x1000, 0x1000, 0x2000] };
// Coinage 1 from CMOS, upright, 4 players, two coin counters, USA.
Trog.dsw = () => 0xCFBF;

// NARC (1988), the Z-unit: medium resolution and 8-bit graphics.
// With blank CMOS it restores its defaults and then waits for a reset (the
// operator's, or the watchdog's), so on that first boot the board resets
// itself once the defaults are written.
export class Narc extends MidwayYUnit {
  constructor(roms) {
    super(roms);
    this.buttons = 3;
    this.button2 = 'Jump';
    this.button3 = 'Rocket';
    this.frames = 0;
  }
  runFrame() {
    if (this.frames === 0) this.blankCmos = this.cmos.every((w) => w === 0);
    if (++this.frames === 1000 && this.blankCmos) this.reset();
    super.runFrame();
  }
  // IN0: P1 up, down, left, right, button 4, fire, jump, rocket. IN1: coins, starts (8, 9), language (English).
  setInputs(s) {
    this.in0 = 0xFFFF & ~((s.up ? 1 : 0) | (s.down ? 2 : 0) | (s.left ? 4 : 0) | (s.right ? 8 : 0)
      | (s.fire ? 0x20 : 0) | (s.fire2 ? 0x40 : 0) | (s.fire3 ? 0x80 : 0));
    this.in1 = 0xFFFF & ~((s.coin ? 1 : 0) | (s.start1 ? 0x100 : 0) | (s.start2 ? 0x200 : 0));
  }
}
Narc.id = 'narc'; Narc.title = 'NARC';
Narc.zunit = true; Narc.sound = 'narc'; Narc.soundProt = [0xCDFF, 0xCE29];
Narc.dsw = () => 0xFFFF;
