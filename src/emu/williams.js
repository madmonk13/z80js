// Williams' 1982 board (Robotron: 2084, Joust, and with small changes
// Stargate, Bubbles, Splat!, Sinistar): a Motorola 6809 at 1 MHz and a
// 304x256 bitmap of 16 colors, 2 pixels to the byte, stored a column of
// 256 bytes at a time. There are no tiles or sprites: everything is drawn
// into the bitmap, mostly by the "special chip" blitter, which copies and
// recolors blocks while the CPU waits. ROM sits under the video RAM at
// 0000-8FFF, selected for reading by a bit at C900. Two 6821 PIAs read the
// controls and coins, pass sound commands, and turn the video counter into
// interrupts (every 32 lines, and at line 240). Settings live in a 4-bit
// battery-backed CMOS RAM.
//
// The sound board is a 6808 with a PIA driving an 8-bit DAC; its program
// makes every sound by computing the waveform itself.
//
// 60.1 Hz; the visible picture is 292x240 on a horizontal monitor.

import { M6809 } from './m6809.js';
import { M6803 } from './m6803.js';
import { PIA6821 } from './pia6821.js';
import { SoundMix } from './mixer.js';
import { rgba } from './video.js';
import { capture, apply } from './state.js';

const W = 292, H = 240, LEFT = 6, TOP = 7;
const LINES = 260, REFRESH = 8000000 / 512 / LINES;          // 60.1 Hz
const LINE_CYCLES = 1000000 / REFRESH / LINES;
const SOUND_CLOCK = 3579545 / 4, SOUND_PER_SAMPLE = SOUND_CLOCK / 48000;
const SAMPLES_PER_LINE = 48000 / REFRESH / LINES;
const STATE = ['vram', 'ram', 'palRam', 'cmos', 'romBank', 'blitter', 'line', 'portSelect', 'soundRam', 'cmosFresh', 'advance', 'command', 'irqLines',
  'cycleCarry', 'soundCarry', 'sampleCarry', 'in0', 'in1', 'in2', 'in3', 'cpu', 'snd', 'pia', 'sound'];

// Palette byte BBGGGRRR through 1200/560/330 ohm (red, green) and 560/330
// ohm (blue) resistors, scaled so all bits on is full brightness.
function weights(rs) { const g = rs.map((r) => 1 / r), sum = g.reduce((a, b) => a + b); return g.map((x) => (255 * x) / sum); }
const WRG = weights([1200, 560, 330]), WB = weights([560, 330]);
const COLOR = Uint32Array.from({ length: 256 }, (_, v) => {
  const c = (w, bits) => Math.round(w.reduce((acc, wt, k) => acc + (((v >> bits[k]) & 1) ? wt : 0), 0));
  return rgba(c(WRG, [0, 1, 2]), c(WRG, [3, 4, 5]), c(WB, [6, 7]));
});

// The 6808's DAC, as a chip for the mixer.
class Dac {
  constructor() { this.reset(); }
  reset() { this.value = 0x80; this.out = 0; }
  saveState() { return { value: this.value }; }
  loadState(s) { this.value = s.value; }
  sample() { this.out = (this.value - 128) / 128; }
}

export class Williams {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.palRam.forEach((v, i) => { this.palette[i] = COLOR[v]; }); }

  // roms: { main (D000-FFFF) 12K, banked (0000-8FFF) 36K, sound 4K }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.roms = roms;
    this.vram = new Uint8Array(0x9800);          // 0000-97FF, the bitmap (plus work RAM above the picture)
    this.ram = new Uint8Array(0x2800);           // 9800-BFFF
    this.palRam = new Uint8Array(16);
    this.cmos = new Uint8Array(0x400).fill(0xF0);
    // Blank settings RAM: the game restores its factory settings and then
    // waits for the operator's Advance switch; we press it for them.
    this.cmosFresh = true; this.advance = 0; this.switchReads = 0;
    this.soundRam = new Uint8Array(0x100);
    this.palette = new Uint32Array(16).fill(rgba(0, 0, 0));

    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.dac = new Dac();
    this.sound = new SoundMix([this.dac], 0.5);
    this.snd = new M6803({
      read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v), internal: false, holdIrq: false,
    });

    // Interrupt lines from the PIAs: main A, main B, sound A, sound B.
    this.irqLines = new Uint8Array(4);
    const line = (n, on) => {
      this.irqLines[n] = on ? 1 : 0;
      this.cpu.irq = !!(this.irqLines[0] | this.irqLines[1]);
      this.snd.irq = !!(this.irqLines[2] | this.irqLines[3]);
    };
    this.pia = [
      // Controls (Joust multiplexes two players through CB2).
      new PIA6821({ inA: () => (this.muxed && this.portSelect ? this.in3 : this.in0), inB: () => this.in1, cb2: (v) => { this.portSelect = v; } }),
      // Coins and switches in, sound commands out, the video interrupts.
      new PIA6821({
        inA: () => this.in2 | (this.advance > 0 ? 0x02 : 0),
        outB: (v) => this.soundCommand(v | 0xC0),
        irqA: (on) => line(0, on), irqB: (on) => line(1, on),
      }),
      // Sound board: DAC out, command in.
      new PIA6821({
        outA: (v) => { this.dac.value = v; }, inB: () => this.command,
        irqA: (on) => line(2, on), irqB: (on) => line(3, on),
      }),
    ];
    this.command = 0xFF;
    this.frame = new Uint32Array(W * H);
    this.in0 = this.in1 = this.in2 = this.in3 = 0;
    this.reset();
  }

  reset() {
    this.vram.fill(0); this.ram.fill(0); this.palRam.fill(0); this.soundRam.fill(0);
    this.palette.fill(rgba(0, 0, 0));
    this.romBank = 0; this.portSelect = 0; this.line = 0;
    this.blitter = new Uint8Array(8);
    this.command = 0xFF;
    this.irqLines.fill(0);
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.pia.forEach((p) => p.reset());
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x9800) return this.romBank && a < 0x9000 ? this.roms.banked[a] : this.vram[a];
    if (a < 0xC000) return this.ram[a - 0x9800];
    if (a >= 0xD000) return this.roms.main[a - 0xD000];
    if (a >= 0xCC00) return this.cmos[a - 0xCC00];
    if ((a & 0xFF0C) === 0xC804) return this.pia[0].read(a & 3);
    if ((a & 0xFF0C) === 0xC80C) { if (!(a & 3)) this.switchReads++; return this.pia[1].read(a & 3); }
    if (a >= 0xCB00 && a < 0xCC00) return this.line & 0xFC;   // video counter
    return 0xFF;
  }

  write(a, v) {
    if (a < 0x9800) { this.vram[a] = v; return; }           // writes always reach video RAM
    if (a < 0xC000) { this.ram[a - 0x9800] = v; return; }
    if (a >= 0xD000) return;
    if (a >= 0xCC00) { this.cmos[a - 0xCC00] = v | 0xF0; return; }   // 4 bits wide
    if (a < 0xC400) { this.palRam[a & 15] = v; this.palette[a & 15] = COLOR[v]; return; }
    if ((a & 0xFF0C) === 0xC804) { this.pia[0].write(a & 3, v); return; }
    if ((a & 0xFF0C) === 0xC80C) { this.pia[1].write(a & 3, v); return; }
    if (a >= 0xC900 && a < 0xCA00) { this.romBank = v & 1; return; }
    if (a >= 0xCA00 && a < 0xCB00) { this.blitterWrite(a & 7, v); return; }
    // CBFF watchdog.
  }

  // ---------------------------------------------------------------- blitter

  // CA00 starts a blit; CA01 is the solid color; CA02-03 source; CA04-05
  // destination; CA06-07 width and height (XORed with 4 on this first chip).
  // Flags in CA00: 01 source in screen layout (256 bytes per column), 02 the
  // same for the destination, 08 skip transparent (0) pixels, 10 solid color,
  // 20 shift right one pixel, 40/80 leave the low/high pixel alone.
  blitterWrite(r, v) {
    const b = this.blitter;
    b[r] = v;
    if (r !== 0) return;
    const sstart0 = (b[2] << 8) | b[3], dstart0 = (b[4] << 8) | b[5];
    let w = b[6] ^ 4, h = b[7] ^ 4;
    if (w === 0) w = 1; if (h === 0) h = 1;
    if (w === 255) w = 256; if (h === 255) h = 256;
    const accesses = this.blit(sstart0, dstart0, w, h, v);
    // The CPU is held while the blitter runs (about 2 accesses per byte at 4 MHz).
    this.cpu.cycles += Math.ceil((20 + 2 * accesses) / 4);
  }

  blitPixel(dest, src, flags, mask, solid) {
    const pix0 = dest < 0xC000 ? (dest < 0x9800 ? this.vram[dest] : this.ram[dest - 0x9800]) : this.read(dest);
    if (flags & 0x08) {
      if (!(src & 0xF0)) mask |= 0xF0;
      if (!(src & 0x0F)) mask |= 0x0F;
    }
    let pix = pix0 & mask;
    pix |= (flags & 0x10 ? solid : src) & ~mask;
    this.write(dest, pix & 0xFF);
  }

  blit(sstart, dstart, w, h, flags) {
    const sxadv = flags & 1 ? 0x100 : 1, syadv = flags & 1 ? 1 : w;
    const dxadv = flags & 2 ? 0x100 : 1, dyadv = flags & 2 ? 1 : w;
    let keep = (flags & 0x80 ? 0xF0 : 0) | (flags & 0x40 ? 0x0F : 0);
    if (keep === 0xFF) return 0;
    let solid = this.blitter[1], accesses = 0;
    const nextRow = () => {
      sstart += syadv;
      dstart = flags & 2 ? (dstart & 0xFF00) | ((dstart + dyadv) & 0xFF) : dstart + dyadv;
    };
    if (!(flags & 0x20)) {
      for (let i = 0; i < h; i++) {
        let s = sstart & 0xFFFF, d = dstart & 0xFFFF;
        for (let j = w; j > 0; j--) {
          this.blitPixel(d, this.read(s), flags, keep, solid);
          accesses += 2;
          s = (s + sxadv) & 0xFFFF; d = (d + dxadv) & 0xFFFF;
        }
        nextRow();
      }
    } else {
      // Shifted a pixel right: each byte is made from two source bytes.
      keep = ((keep & 0xF0) >> 4) | ((keep & 0x0F) << 4);
      solid = ((solid & 0xF0) >> 4) | ((solid & 0x0F) << 4);
      for (let i = 0; i < h; i++) {
        let s = sstart & 0xFFFF, d = dstart & 0xFFFF;
        let pix = this.read(s);
        this.blitPixel(d, (pix >> 4) & 0x0F, flags, keep | 0xF0, solid);
        accesses += 2;
        s = (s + sxadv) & 0xFFFF; d = (d + dxadv) & 0xFFFF;
        for (let j = w - 1; j > 0; j--) {
          pix = ((pix << 8) | this.read(s)) & 0xFFFF;
          this.blitPixel(d, (pix >> 4) & 0xFF, flags, keep, solid);
          accesses += 2;
          s = (s + sxadv) & 0xFFFF; d = (d + dxadv) & 0xFFFF;
        }
        this.blitPixel(d, (pix << 4) & 0xF0, flags, keep | 0x0F, solid);
        accesses++;
        nextRow();
      }
    }
    return accesses;
  }

  // ---------------------------------------------------------------- sound board

  soundCommand(v) {
    this.command = v;
    this.pia[2].setC1('B', v === 0xFF ? 0 : 1);
  }
  soundRead(a) {
    if (a < 0x100) return this.soundRam[a];
    if ((a & 0x7FFC) === 0x0400) return this.pia[2].read(a & 3);
    if (a >= 0xB000) return this.roms.sound[a & 0xFFF];
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a < 0x100) this.soundRam[a] = v;
    else if ((a & 0x7FFC) === 0x0400) this.pia[2].write(a & 3, v);
  }

  // ---------------------------------------------------------------- inputs

  setInputs() {}
  applySwitches() {}

  // ---------------------------------------------------------------- frame

  runFrame() {
    const pia1 = this.pia[1];
    // Spinning on the switches with fresh settings means "press Advance".
    if (this.advance > 0) this.advance--;
    else if (this.cmosFresh && this.switchReads > 300) { this.advance = 4; this.cmosFresh = false; }
    this.switchReads = 0;
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      // The video counter's interrupts: CB1 follows line bit 5 (every 32
      // lines), CA1 goes high from line 240 to the end of the frame.
      pia1.setC1('B', line & 0x20);
      pia1.setC1('A', line >= 240);
      if (line === 248) this.render();
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) {
        this.sampleCarry -= 1;
        this.soundCarry += SOUND_PER_SAMPLE;
        const before = this.snd.cycles;
        this.snd.run(Math.floor(this.soundCarry));
        this.soundCarry -= this.snd.cycles - before;
        this.sound.sample();
      }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, vram = this.vram, pal = this.palette;
    for (let y = 0; y < H; y++) {
      const sy = y + TOP;
      let o = y * W;
      for (let x = 0; x < W; x++) {
        const sx = x + LEFT, byte = vram[(sx >> 1) * 256 + sy];
        out[o++] = pal[sx & 1 ? byte & 15 : byte >> 4];
      }
    }
  }
}

// ---------------------------------------------------------------- the games

export class Robotron extends Williams {
  constructor(roms) {
    super(roms);
    this.controls = 'eight-way';
    this.buttons = 0;
    this.twinStick = true;                       // a second stick fires
  }
  // IN0: move up, down, left, right, start 1, start 2, fire up, fire down.
  // IN1: fire left, fire right. IN2: coin (left slot).
  setInputs(s) {
    const f = s.aim || {};
    this.in0 = (s.up ? 0x01 : 0) | (s.down ? 0x02 : 0) | (s.left ? 0x04 : 0) | (s.right ? 0x08 : 0)
      | (s.start1 ? 0x10 : 0) | (s.start2 ? 0x20 : 0) | (f.up ? 0x40 : 0) | (f.down ? 0x80 : 0);
    this.in1 = (f.left ? 0x01 : 0) | (f.right ? 0x02 : 0);
    this.in2 = s.coin ? 0x10 : 0;
  }
}
Robotron.id = 'robotron';
Robotron.title = 'Robotron: 2084';
Robotron.switches = [];

export class Joust extends Williams {
  constructor(roms) {
    super(roms);
    this.controls = 'two-way';
    this.buttons = 1;
    this.muxed = true;                           // two players' controls through one port
  }
  // Player 1 on IN3, player 2 on IN0 (chosen by the PIA's CB2): left, right,
  // flap, start 2, start 1. IN2: coin.
  setInputs(s) {
    const starts = (s.start2 ? 0x10 : 0) | (s.start1 ? 0x20 : 0);
    this.in3 = (s.left ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.fire ? 0x04 : 0) | starts;
    this.in0 = starts;
    this.in2 = s.coin ? 0x10 : 0;
  }
}
Joust.id = 'joust';
Joust.title = 'Joust';
Joust.switches = [];
