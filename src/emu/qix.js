// Taito Qix (1981): two 6809s at 1.25 MHz sharing 1K of RAM and nudging each
// other with FIRQs. The data CPU runs the game and reads the controls through
// 6821 PIAs; the video CPU owns a 256x256 bitmap of 8-bit pixels (written
// directly, half at a time, or through an address latch), 1024 colors of
// RRGGBBII in four banks, and 1K of battery-backed CMOS (settings and high
// scores). A 6802 plays samples through a DAC, talking to the data CPU over a
// pair of PIAs.
//
// The data CPU's PIA sees the vertical sync; the video CPU reads the beam's
// line. 256x256 on a vertical monitor at about 60 Hz.

import { M6809 } from './m6809.js';
import { M6803 } from './m6803.js';
import { PIA6821 } from './pia6821.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba, rotate270 } from './video.js';
import { capture, apply } from './state.js';

const W = 256, H = 256, LINES = 264, REFRESH = 60, SLICES = 4;
const CPU_CLOCK = 1250000, SOUND_CLOCK = 7372800 / 8;
const STATE = ['shared', 'dataRam', 'cmos', 'vram', 'palRam', 'palBank', 'vaddr', 'soundRam', 'latch34', 'latch43',
  'irqs', 'scanline', 'in0', 'coins', 'frameNo', 'setup', 'cycleCarry', 'videoCarry', 'soundCarry', 'sampleCarry',
  'cpu', 'video', 'snd', 'pia', 'dac'];

// Palette levels: two color bits and two intensity bits.
const LEVEL = [0x00, 0x12, 0x24, 0x49, 0x12, 0x24, 0x49, 0x92, 0x5B, 0x6D, 0x92, 0xDB, 0x7F, 0x91, 0xB6, 0xFF];
// Volume attenuators selected by each 4-bit volume nibble, in parallel, into 10K.
const ATTN = [22000, 10000, 5600, 3300].map((r) => r + 250);

// The DAC with its volume network and the output's DC-blocking filter.
class QixDAC {
  constructor() { this.reset(); }
  reset() { this.value = 0x80; this.vol = 0; this.out = 0; this.prevIn = 0; this.prevOut = 0; }
  saveState() { return { value: this.value, vol: this.vol, prevIn: this.prevIn, prevOut: this.prevOut }; }
  loadState(s) { Object.assign(this, s); }
  gain(n) {
    if (!n) return 1;
    let g = 0;
    for (let i = 0; i < 4; i++) if (n & (1 << i)) g += 1 / ATTN[i];
    const r = 1 / g;
    return r / (r + 10000);
  }
  sample() {
    const x = (this.value - 0x80) / 128 * (this.gain(this.vol >> 4) + this.gain(this.vol & 15)) / 2;
    const k = 1.5e3 * 1e-6 * RATE / (1.5e3 * 1e-6 * RATE + 1);   // RC high-pass, 1.5K and 1 uF
    this.prevOut = k * (this.prevOut + x - this.prevIn); this.prevIn = x;
    this.out = this.prevOut * 0.8;
  }
}

export class Qix {
  saveState() { return { ...capture(this, STATE.filter((k) => k !== 'pia')), pia: this.pia.map((p) => p.saveState()) }; }
  loadState(s) {
    apply(this, STATE.filter((k) => k !== 'pia'), s);
    s.pia.forEach((p, i) => this.pia[i].loadState(p));
    for (let i = 0; i < 0x400; i++) this.setColor(i);
  }

  // roms: { main (C000-FFFF, data CPU), videoRom (C800-FFFF), sound (F800-FFFF) }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = REFRESH;
    this.controls = 'four-way';
    this.buttons = 2;
    this.button2 = 'Slow';
    this.roms = roms;
    this.shared = new Uint8Array(0x400);
    this.dataRam = new Uint8Array(0x400);
    this.cmos = new Uint8Array(0x400);
    this.nvram = this.cmos;                          // kept between sessions (settings, high scores)
    this.vram = new Uint8Array(0x10000);
    this.palRam = new Uint8Array(0x400);
    this.palette = new Uint32Array(0x400).fill(0xFF000000);
    this.vaddr = new Uint8Array(2);
    this.soundRam = new Uint8Array(0x80);
    this.irqs = new Uint8Array(4);                   // data CPU (PIA 3 A/B), sound CPU (PIA 4 A/B)

    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.video = new M6809({ read: (a) => this.videoRead(a), write: (a, v) => this.videoWrite(a, v) });
    this.snd = new M6803({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v), internal: false, holdIrq: false });
    this.dac = new QixDAC();
    this.sound = new SoundMix([this.dac], 1);
    const setIrq = (i, on) => {
      this.irqs[i] = on ? 1 : 0;
      this.cpu.irq = !!(this.irqs[0] | this.irqs[1]);
      this.snd.irq = !!(this.irqs[2] | this.irqs[3]);
    };
    this.pia = [
      new PIA6821({ inA: () => this.in0, inB: () => this.coins }),                 // 0: player 1, coin door
      new PIA6821(),                                                                // 1: spare
      new PIA6821(),                                                                // 2: player 2, coin counters
      new PIA6821({                                                                 // 3: data CPU side of the sound link; VSYNC on CB1
        inA: () => this.latch43, outA: (v) => { this.latch34 = v; }, outB: (v) => { this.dac.vol = v; },
        ca2: (v) => this.pia[4].setC1('A', v), irqA: (on) => setIrq(0, on), irqB: (on) => setIrq(1, on),
      }),
      new PIA6821({                                                                 // 4: sound CPU side; DAC on port B
        inA: () => this.latch34, outA: (v) => { this.latch43 = v; }, outB: (v) => { this.dac.value = v; },
        ca2: (v) => this.pia[3].setC1('A', v), irqA: (on) => setIrq(2, on), irqB: (on) => setIrq(3, on),
      }),
    ];
    this.frame = new Uint32Array(W * H);
    this.native = new Uint32Array(W * H);
    this.in0 = 0xFF; this.coins = 0xFF;
    this.reset();
  }

  reset() {
    for (const a of [this.shared, this.dataRam, this.vram, this.palRam, this.vaddr, this.soundRam, this.irqs]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.palBank = 0; this.latch34 = 0xFF; this.latch43 = 0xFF; this.scanline = 0; this.frameNo = 0; this.setup = 0;
    this.cycleCarry = this.videoCarry = this.soundCarry = this.sampleCarry = 0;
    for (const p of this.pia) p.reset();
    this.cpu.reset(); this.video.reset(); this.snd.reset(); this.sound.reset();
  }

  setColor(i) {
    const d = this.palRam[i], n = d & 3;
    this.palette[i] = rgba(LEVEL[((d >> 6) & 3) * 4 + n], LEVEL[((d >> 4) & 3) * 4 + n], LEVEL[((d >> 2) & 3) * 4 + n]);
  }

  // ---------------------------------------------------------------- data CPU

  read(a) {
    if (a >= 0xA000) return this.roms.main[a - 0xC000] ?? 0xFF;
    if (a < 0x8000) return 0xFF;
    if (a < 0x8400) return this.shared[a - 0x8000];
    if (a < 0x8800) return this.dataRam[a - 0x8400];
    if (a < 0x8C00) return 0;                       // the ACIA (diagnostics only)
    if (a < 0x9000) { if (a & 1) this.cpu.firq = false; else this.video.firq = true; return 0xFF; }
    return this.pia[[3, 0, 1, 2][(a >> 10) & 3]].read(a & 3);
  }
  write(a, v) {
    if (a < 0x8000 || a >= 0xA000) return;
    if (a < 0x8400) { this.shared[a - 0x8000] = v; return; }
    if (a < 0x8800) { this.dataRam[a - 0x8400] = v; return; }
    if (a < 0x8C00) return;
    if (a < 0x9000) { if (a & 1) this.cpu.firq = false; else this.video.firq = true; return; }
    this.pia[[3, 0, 1, 2][(a >> 10) & 3]].write(a & 3, v);
  }

  // ---------------------------------------------------------------- video CPU

  videoRead(a) {
    if (a < 0x8000) return this.vram[a | ((this.vaddr[0] & 0x80) << 8)];
    if (a >= 0xA000) return this.roms.videoRom[a - 0xC800] ?? 0xFF;
    if (a < 0x8400) return this.shared[a - 0x8000];
    if (a < 0x8800) return this.cmos[a - 0x8400];
    if (a < 0x8C00) return 0xFF;
    if (a < 0x9000) { if (a & 1) this.video.firq = false; else this.cpu.firq = true; return 0xFF; }
    if (a < 0x9400) return this.palRam[a - 0x9000];
    if (a < 0x9800) return (a & 3) === 0 ? this.vram[(this.vaddr[0] << 8) | this.vaddr[1]] : 0xFF;
    if (a < 0x9C00) return this.scanline;
    return 0;                                        // the 6845's registers
  }
  videoWrite(a, v) {
    if (a < 0x8000) { this.vram[a | ((this.vaddr[0] & 0x80) << 8)] = v; return; }
    if (a >= 0xA000) return;
    if (a < 0x8400) { this.shared[a - 0x8000] = v; return; }
    if (a < 0x8800) { this.cmos[a - 0x8400] = v; return; }
    if (a < 0x8C00) { this.palBank = v & 3; return; }
    if (a < 0x9000) { if (a & 1) this.video.firq = false; else this.cpu.firq = true; return; }
    if (a < 0x9400) { this.palRam[a - 0x9000] = v; this.setColor(a - 0x9000); return; }
    if (a < 0x9800) {
      if ((a & 3) === 0) this.vram[(this.vaddr[0] << 8) | this.vaddr[1]] = v;
      else if (a & 2) this.vaddr[a & 1] = v;
    }
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x80) return this.soundRam[a];
    if (a >= 0xD000) return this.roms.sound[a - 0xF800] ?? 0xFF;
    if ((a & 0xC000) === 0x4000) return this.pia[4].read(a & 3);
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a < 0x80) this.soundRam[a] = v;
    else if ((a & 0xC000) === 0x4000) this.pia[4].write(a & 3, v);
  }

  // Player 1 (PIA 0 A): up, right, down, left, slow draw, start 2, start 1, fast draw. Coin door (PIA 0 B): coin 1 on bit 4.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.up ? 1 : 0) | (s.right ? 2 : 0) | (s.down ? 4 : 0) | (s.left ? 8 : 0) | (s.fire2 ? 0x10 : 0)
      | (s.start2 ? 0x20 : 0) | (s.start1 ? 0x40 : 0) | (s.fire ? 0x80 : 0));
    this.coins = 0xFF & ~(s.coin ? 0x10 : 0);
  }
  applySwitches() {}

  // A blank CMOS (a new board) starts in the operator's setup pages: language, location, audits, coinage.
  // Step through them with the factory settings, as an operator would, by pressing Test Advance five times.
  autoSetup() {
    this.frameNo++;
    if (this.frameNo === 1 && this.cmos.every((b) => b === 0)) this.setup = 1;   // never set up (no saved CMOS)
    if (!this.setup) return;
    const t = this.frameNo - 300;
    if (t >= 0 && t % 100 < 20) this.coins &= ~0x01;          // Test Advance
    if (t >= 500) this.setup = 0;
  }

  runFrame() {
    this.autoSetup();
    const step = CPU_CLOCK / REFRESH / LINES / SLICES, sstep = SOUND_CLOCK / REFRESH / LINES / SLICES, samples = RATE / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line < H) this.scanline = line;            // latched as each displayed line starts
      if (line === 0) this.pia[3].setC1('B', 0);
      else if (line === H) { this.pia[3].setC1('B', 1); this.render(); }   // vertical sync
      for (let s = 0; s < SLICES; s++) {
        this.cycleCarry += step;
        this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
        this.videoCarry += step;
        this.videoCarry -= this.video.run(Math.floor(this.videoCarry));
        const c0 = this.snd.cycles;
        this.soundCarry += sstep; this.snd.run(Math.floor(this.soundCarry)); this.soundCarry -= this.snd.cycles - c0;
      }
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  render() {
    const out = this.native, v = this.vram, pal = this.palette, base = this.palBank * 256;
    for (let i = 0; i < W * H; i++) out[i] = pal[base + v[i]];
    rotate270(out, W, H, this.frame);
  }
}
Qix.id = 'qix';
Qix.title = 'Qix';
Qix.switches = [];
