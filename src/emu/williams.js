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
import { rgba, rotate270 } from './video.js';
import { HC55516 } from './hc55516.js';
import { capture, apply } from './state.js';

const W = 292, H = 240, LEFT = 6, TOP = 7;
const LINES = 260, REFRESH = 8000000 / 512 / LINES;          // 60.1 Hz
const LINE_CYCLES = 1000000 / REFRESH / LINES;
const SOUND_CLOCK = 3579545 / 4, SOUND_PER_SAMPLE = SOUND_CLOCK / 48000;
const SAMPLES_PER_LINE = 48000 / REFRESH / LINES;
const STATE = ['vram', 'ram', 'palRam', 'cmos', 'romBank', 'blitter', 'line', 'portSelect', 'in4', 'soundRam', 'cmosFresh', 'advance', 'command', 'irqLines',
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
      new PIA6821({
        inA: () => (this.muxed && this.portSelect ? this.in3 : this.in0),
        inB: () => (this.muxed === 2 && this.portSelect ? this.in4 : this.in1),
        cb2: (v) => { this.portSelect = v; },
      }),
      // Coins and switches in, sound commands out, the video interrupts.
      new PIA6821({
        inA: () => this.in2 | (this.advance > 0 ? 0x02 : 0),
        outB: (v) => this.soundCommand(v | 0xC0),
        irqA: (on) => line(0, on), irqB: (on) => line(1, on),
      }),
      // Sound board: DAC out, command in.
      new PIA6821({
        outA: (v) => { this.dac.value = v; }, inB: () => this.command,
        ca2: (v) => { if (this.speech) this.speech.digit(v); }, cb2: (v) => { if (this.speech) this.speech.clock(v); },
        irqA: (on) => line(2, on), irqB: (on) => line(3, on),
      }),
    ];
    this.command = 0xFF;
    this.frame = new Uint32Array(W * H);
    this.in0 = this.in1 = this.in2 = this.in3 = this.in4 = 0;
    this.blitterXor = 4;                         // the first special chip's size bug (fixed in the SC2)
    this.cmosMask = 0xF0;                        // 4-bit CMOS (Bubbles has 8)
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
    if (a >= 0xCC00) { this.cmos[a - 0xCC00] = v | this.cmosMask; return; }   // usually 4 bits wide
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
    let w = b[6] ^ this.blitterXor, h = b[7] ^ this.blitterXor;
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
    // Sinistar's clipping window keeps the blitter below 7400 when enabled.
    if (this.clipWindow && dest >= 0x7400 && dest < 0xC000) return;
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
    if (a >= 0xB000) return this.roms.sound.length > 0x1000 ? this.roms.sound[a - 0xB000] ?? 0xFF : this.roms.sound[a & 0xFFF];
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
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      // Draw each line as the beam passes it: the games erase and redraw
      // objects just behind the beam, so a whole-frame snapshot catches some
      // of them half-drawn.
      if (line >= TOP && line < TOP + H) this.renderLine(line - TOP);
      if (line === LINES - 1 && this.native) rotate270(this.native, W, H, this.frame);
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

  renderLine(y) {
    const out = this.native || this.frame, vram = this.vram, pal = this.palette, sy = y + TOP;
    let o = y * W;
    for (let x = 0; x < W; x++) {
      const sx = x + LEFT, byte = vram[(sx >> 1) * 256 + sy];
      out[o++] = pal[sx & 1 ? byte & 15 : byte >> 4];
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

export class Bubbles extends Williams {
  constructor(roms) {
    super(roms);
    this.controls = 'eight-way';
    this.buttons = 0;
    this.cmosMask = 0;                           // a full 8-bit CMOS
  }
  // IN0: up, down, left, right, start 2, start 1. IN2: coin.
  setInputs(s) {
    this.in0 = (s.up ? 0x01 : 0) | (s.down ? 0x02 : 0) | (s.left ? 0x04 : 0) | (s.right ? 0x08 : 0)
      | (s.start2 ? 0x10 : 0) | (s.start1 ? 0x20 : 0);
    this.in2 = s.coin ? 0x10 : 0;
  }
}
Bubbles.id = 'bubbles';
Bubbles.title = 'Bubbles';
Bubbles.switches = [];

// Splat!: Robotron's twin sticks, both players' controls multiplexed through
// both ports, and the second-generation blitter.
export class Splat extends Robotron {
  constructor(roms) {
    super(roms);
    this.muxed = 2;
    this.blitterXor = 0;
  }
  setInputs(s) {
    super.setInputs(s);
    this.in3 = this.in0; this.in4 = this.in1;
  }
}
Splat.id = 'splat';
Splat.title = 'Splat!';
Splat.switches = [];

// ---------------------------------------------------------------- Stargate and Defender

// Five buttons plus an up/down stick on the cabinet. Here an 8-way stick
// flies the ship: up/down as on the stick, left/right "fly that way" -
// thrust if the ship faces that way, else Reverse first. The facing comes
// from the game's own RAM (facingAt / facingRight). The fire side's bottom
// fires and its top drops a smart bomb; hyperspace (and Stargate's inviso)
// are on the keyboard (H, V) and gamepad.
// IN0: fire, thrust, smart bomb, hyperspace, start 2, start 1, reverse, down. IN1: up, inviso.
const DefenderControls = (Base) => class extends Base {
  constructor(roms) {
    super(roms);
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Smart bomb';
    this.reverseHeld = 0;
  }
  facing() { return this.ramAt(this.facingAt) === this.facingRight ? 'right' : 'left'; }
  setInputs(s) {
    const want = s.left ? 'left' : s.right ? 'right' : null;
    let thrust = false, reverse = false;
    if (want) {
      if (want === this.facing()) thrust = true;
      else if (this.reverseHeld === 0) reverse = true;     // tap Reverse, then wait for the turn
    }
    this.reverseHeld = reverse ? 6 : Math.max(0, this.reverseHeld - 1);
    this.in0 = (s.fire ? 0x01 : 0) | (thrust ? 0x02 : 0) | (s.fire2 ? 0x04 : 0) | (s.hyper ? 0x08 : 0)
      | (s.start2 ? 0x10 : 0) | (s.start1 ? 0x20 : 0) | (reverse ? 0x40 : 0) | (s.down ? 0x80 : 0);
    this.in1 = (s.up ? 0x01 : 0) | (s.inviso ? 0x02 : 0);
    this.in2 = s.coin ? 0x10 : 0;
  }
};

export class Stargate extends DefenderControls(Williams) {
  constructor(roms) { super(roms); this.facingAt = 0x9C92; this.facingRight = 0x03; }   // FD when facing left
  ramAt(a) { return this.read(a); }
}
Stargate.id = 'stargate';
Stargate.title = 'Stargate';
Stargate.switches = [];

// Defender's earlier board: RAM all the way to BFFF, and C000-CFFF is either
// the I/O page or one of nine ROM banks, picked by a write to D000-DFFF.
export class Defender extends DefenderControls(Williams) {
  constructor(roms) { super(roms); this.bank = 0; this.cmosFresh = false; this.facingAt = 0xA0BB; this.facingRight = 0x03; }   // FD when facing left
  // This set reads the Auto Up and Advance switches the other way round:
  // idle is both high.
  setInputs(s) { super.setInputs(s); this.in2 |= 0x03; }
  reset() { super.reset(); this.bank = 0; }
  saveState() { return { ...super.saveState(), bank: this.bank }; }
  loadState(s) { super.loadState(s); this.bank = s.bank; }
  ramAt(a) { return this.read(a); }

  read(a) {
    if (a < 0x9800) return this.vram[a];
    if (a < 0xC000) return this.ram[a - 0x9800];
    if (a >= 0xD000) return this.roms.main[a - 0xD000];
    if (this.bank) return this.roms.banked[(this.bank - 1) * 0x1000 + (a & 0xFFF)] ?? 0xFF;
    const o = a & 0xFFF;
    if (o >= 0x400 && o < 0x800) return this.cmos[o & 0xFF];
    if (o >= 0x800 && o < 0xC00) return this.line & 0xFC;
    if (o >= 0xC00) {
      if (!(o & 7)) this.switchReads++;          // PIA 1 port A: see the Advance note above
      return this.pia[o & 4 ? 0 : 1].read(o & 3);
    }
    return 0xFF;
  }

  write(a, v) {
    if (a < 0x9800) { this.vram[a] = v; return; }
    if (a < 0xC000) { this.ram[a - 0x9800] = v; return; }
    if (a >= 0xD000) { if (a < 0xE000) this.bank = v & 0x0F; return; }
    if (this.bank) return;
    const o = a & 0xFFF;
    if (o < 0x400) { if (!(o & 0x10)) { this.palRam[o & 15] = v; this.palette[o & 15] = COLOR[v]; } return; }
    if (o < 0x800) { this.cmos[o & 0xFF] = v | 0xF0; return; }
    if (o >= 0xC00) this.pia[o & 4 ? 0 : 1].write(o & 3, v);
  }
}
Defender.id = 'defender';
Defender.title = 'Defender';
Defender.switches = [];

// ---------------------------------------------------------------- Sinistar

// Sinistar: the same board on its side, with a clipping window for the
// blitter (C900 bit 2), RAM in the D000 slot, a 49-position joystick (7
// positions per axis), and the HC-55516 speech chip on the sound board's
// PIA ("Beware, I live!").
const AXIS7 = [0x0, 0x4, 0x6, 0x7, 0xB, 0x9, 0x8];   // full, 2/3, 1/3, center, 1/3, 2/3, full
export class Sinistar extends Williams {
  constructor(roms) {
    super(roms);
    this.width = H; this.height = W;
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Sinibomb';
    this.dRam = new Uint8Array(0x1000);
    this.speech = new HC55516(1.2);
    this.sound = new SoundMix([this.dac, this.speech], 0.5);
    this.clipWindow = 0;
  }
  reset() { super.reset(); if (this.dRam) this.dRam.fill(0); this.clipWindow = 0; if (this.speech) this.speech.reset(); }
  saveState() { return { ...super.saveState(), dRam: this.dRam.slice(), clip: this.clipWindow }; }
  loadState(s) { super.loadState(s); this.dRam.set(s.dRam); this.clipWindow = s.clip; }

  read(a) { return a >= 0xD000 && a < 0xE000 ? this.dRam[a - 0xD000] : super.read(a); }
  write(a, v) {
    if (a >= 0xD000 && a < 0xE000) { this.dRam[a - 0xD000] = v; return; }
    if (a >= 0xC900 && a < 0xCA00) this.clipWindow = v & 4;
    super.write(a, v);
  }
  // PIA 0 A: the stick, 4 bits per axis (X high). B: fire, sinibomb, starts.
  setInputs(s) {
    const x = s.left ? 0 : s.right ? 6 : 3, y = s.down ? 0 : s.up ? 6 : 3;   // the Y axis reads up as high
    this.in0 = (AXIS7[x] << 4) | AXIS7[y];
    this.in1 = (s.fire ? 0x01 : 0) | (s.fire2 ? 0x02 : 0) | (s.start1 ? 0x10 : 0) | (s.start2 ? 0x20 : 0);
    this.in2 = s.coin ? 0x10 : 0;
  }
}
Sinistar.id = 'sinistar';
Sinistar.title = 'Sinistar';
Sinistar.switches = [];
