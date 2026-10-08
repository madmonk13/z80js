// Konami Frogger (1981): Galaxian-style video (no stars or bullets, a blue
// river behind the top half, color and vertical-position lines wired
// differently) with Konami's sound board: a second Z80 at 1.79 MHz driving an
// AY-3-8910. The main CPU reads its controls and talks to the sound board
// through two 8255 PPI chips.

import { Z80 } from './z80.js';
import { AY8910 } from './ay8910.js';
import { Galaxian, NATIVE_W, TOP } from './galaxian.js';
import { rgba } from './video.js';

const LINES = 264, LINE_CYCLES = 192, VBLANK_LINE = 240;
const SOUND_CLOCK = 14318000 / 8;                     // 1.79 MHz
const SOUND_PER_LINE = SOUND_CLOCK / (264 * 60.606);  // about 112 cycles
const RIVER = rgba(0, 0, 0x47);                       // through a 470 ohm resistor

// The AY's port B reads a timer divided down from the sound CPU's clock
// (divide by 512, then a bi-quinary divide by 10), wired to bits 3, 4, 6, 7.
const TIMER = [0x00, 0x10, 0x08, 0x18, 0x40, 0x90, 0x88, 0x98, 0x88, 0xD0];

export class Frogger extends Galaxian {
  // roms: { main 12K, sound 6K, gfx 4K, palette 32 } with the two data-line
  // swaps already undone (see boards.js).
  constructor(roms) {
    super(roms);
    this.controls = 'four-way';
    this.buttons = 0;
    this.bullets = false;
    this.soundRam = new Uint8Array(0x400);
    this.sound = new AY8910(SOUND_CLOCK, (port) => (port === 0 ? this.latch : TIMER[Math.floor((this.sndCpu.cycles % 5120) / 512)]), 6);   // the game keeps the chip quiet; the cabinet amplifies it
    this.sndCpu = new Z80({
      read: (a) => this.soundRead(a),
      write: (a, v) => this.soundWrite(a, v),
      input: (port) => ((port & 0xFF) === 0x40 ? this.sound.read() : 0xFF),
      output: (port, v) => this.soundOut(port & 0xFF, v),
    });
    // The interrupt flip-flop clears when the sound CPU takes the interrupt.
    this.sndCpu.onIrqAck = () => { this.sndCpu.irq = false; };
    this.reset();
  }

  reset() {
    super.reset();
    if (!this.sndCpu) return;               // called once from Galaxian's constructor
    this.soundRam.fill(0);
    this.sndCpu.reset();
    this.sound.reset();
    this.latch = 0;
    this.lastClk = 8;
    this.soundCarry = 0;
  }

  saveState() {
    return { ...super.saveState(), sndCpu: this.sndCpu.saveState(), soundRam: this.soundRam.slice(), latch: this.latch, lastClk: this.lastClk, soundCarry: this.soundCarry };
  }
  loadState(s) {
    super.loadState(s);
    this.sndCpu.loadState(s.sndCpu);
    this.soundRam.set(s.soundRam);
    this.latch = s.latch; this.lastClk = s.lastClk; this.soundCarry = s.soundCarry;
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x4000) return a < this.roms.main.length ? this.roms.main[a] : 0;
    if (a >= 0x8000 && a < 0x8800) return this.ram[a - 0x8000];
    if (a >= 0xA800 && a < 0xAC00) return this.vram[a & 0x3FF];
    if (a >= 0xB000 && a < 0xB100) return this.obj[a & 0xFF];
    // PPI 0 at E000: ports A-C read the controls and switches (A1-A2 pick the port).
    if (a >= 0xE000 && a < 0xE008) return [this.in0, this.in1, this.in2, 0xFF][(a >> 1) & 3];
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0x8800) { this.ram[a - 0x8000] = v; return; }
    if (a >= 0xA800 && a < 0xAC00) { this.vram[a & 0x3FF] = v; return; }
    if (a >= 0xB000 && a < 0xB100) { this.obj[a & 0xFF] = v; return; }
    if (a === 0xB808) { this.nmiEnable = !!(v & 1); return; }
    // PPI 1 at D000: port A is the sound command, port B triggers the sound
    // CPU's interrupt (bit 3 falling) and mutes the board (bit 4).
    if (a >= 0xD000 && a < 0xD008) {
      const port = (a >> 1) & 3;
      if (port === 0) this.latch = v;
      else if (port === 1) {
        const clk = ~v & 0x08;
        if (clk && !this.lastClk) this.sndCpu.irq = true;
        this.lastClk = clk;
        this.sound.enabled = !(v & 0x10);
      }
    }
    // B80C/B810 flip screen, B818/B81C coin counters, E000 PPI 0 control: not needed.
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x2000) return this.roms.sound[a] ?? 0xFF;
    if (a >= 0x4000 && a < 0x4400) return this.soundRam[a - 0x4000];
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0x4000 && a < 0x4400) this.soundRam[a - 0x4000] = v;
    // 6000-6FFF set the output filters: not modeled.
  }
  soundOut(port, v) {
    if (port === 0x40) this.sound.write(v);
    else if (port === 0x80) this.sound.select(v);
  }

  // ---------------------------------------------------------------- inputs

  // All active low. IN0: right, left, coins. IN1: lives switch, starts.
  // IN2: coinage and cabinet (upright, 1 coin 1 credit), up, down.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.right ? 0x10 : 0) | (s.left ? 0x20 : 0) | (s.coin ? 0x80 : 0));
    this.in1 = (0xFC | this.lives) & ~((s.start2 ? 0x40 : 0) | (s.start1 ? 0x80 : 0));
    this.in2 = 0xF1 & ~((s.up ? 0x10 : 0) | (s.down ? 0x40 : 0));
  }

  applySwitches(v) { this.lives = v.lives; this.setInputs({}); }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) {
        if (this.nmiEnable) this.cpu.nmi();
        this.render();
      }
      this.cpu.run(LINE_CYCLES);
      this.soundCarry += SOUND_PER_LINE;
      const n = Math.floor(this.soundCarry);
      this.soundCarry -= n;
      // Three output samples per line, with the sound CPU run in between.
      for (let k = 0; k < 3; k++) {
        this.sndCpu.run(Math.floor(n / 3) + (k < n % 3 ? 1 : 0));
        this.sound.sample();
      }
    }
  }

  // ---------------------------------------------------------------- video

  // Native x 0-127 (the top half once rotated) is the river.
  background(out) {
    out.fill(0xFF000000);
    for (let y = TOP; y < TOP + 224; y++) out.fill(RIVER, y * NATIVE_W, y * NATIVE_W + 128);
  }
  mapColor(c) { return ((c >> 1) & 3) | ((c << 2) & 4); }
  mapY(v) { return ((v << 4) | (v >> 4)) & 0xFF; }
}

Frogger.id = 'frogger';
Frogger.title = 'Frogger';
Frogger.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0], ['5', 1], ['7', 2]], default: 0 },
];
