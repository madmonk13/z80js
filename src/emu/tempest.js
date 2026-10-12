// Atari Tempest (1981): a 6502 at 1.5 MHz, the color Analog Vector Generator
// (see avg.js) on a vertical monitor, the math box, two POKEYs (sound, plus
// the spinner, buttons and switches on their pot lines) and an EAROM for the
// high scores. An IRQ ~250 times a second keeps time.

import { CPU6502 } from './m6502.js';
import { AVG } from './avg.js';
import { MathBox } from './mathbox.js';
import { Pokey, PokeyVoice } from './pokey.js';
import { SoundMix, RATE } from './mixer.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const CPU_CLOCK = 12096000 / 8, IRQ_RATE = 12096000 / 4096 / 12;
const FRAME_CYCLES = CPU_CLOCK / 60, SAMPLES_PER_FRAME = RATE / 60;
const STATE = ['ram', 'vram', 'colorRam', 'earom', 'earomAddr', 'earomData', 'flip', 'player', 'knob',
  'cycleCarry', 'irqCarry', 'sampleCarry', 'avgOn', 'in0', 'pressed', 'cpu', 'mathbox', 'sound'];

// The picture: AVG units around the center, turned for the vertical monitor.
const HALF_W = 290, HALF_H = 285;

export class Tempest {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.drawList(); }

  // roms: { main 9000-DFFF (20K), vector 3000-3FFF (4K) }
  constructor(roms) {
    this.vector = true;
    this.width = HALF_W * 2;
    this.height = HALF_H * 2;
    this.refresh = 60;
    this.controls = 'two-way';
    this.spinner = true;
    this.dialSpeed = 3;                        // dial counts a frame at full push: about 15 lanes a second
    this.buttons = 2;
    this.button2 = 'Zap';
    this.roms = roms;
    this.ram = new Uint8Array(0x800);
    this.vram = new Uint8Array(0x1000);
    this.colorRam = new Uint8Array(16);
    this.earom = new Uint8Array(0x40);
    this.cpu = new CPU6502({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.avg = new AVG((a) => (a < 0x1000 ? this.vram[a] : this.roms.vector[(a - 0x1000) & 0xFFF]), 'tempest');
    this.mathbox = new MathBox();
    this.pokeys = [new Pokey(CPU_CLOCK, 3), new Pokey(CPU_CLOCK, 3)];
    // Pot lines: POKEY 1 the spinner (bits 0-3) and cabinet switch; POKEY 2 the
    // difficulty and rating switches, the two buttons and the start buttons.
    // A line held high reads as a pot that finishes counting at once, which
    // clears its ALLPOT bit: the game sees each line inverted.
    this.pokeys[0].readPots = () => ~((this.knob & 0x0F) | 0x10 | 0xE0) & 0xFF;
    this.pokeys[1].readPots = () => ~(this.dsw0 | (~this.pressed & 0x78) | 0x80) & 0xFF;
    this.sound = new SoundMix(this.pokeys.map((p) => new PokeyVoice(p)), 1);
    this.vectors = { data: new Float32Array(7 * 6000), count: 0 };
    this.in0 = 0xFF; this.pressed = 0; this.knob = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.colorRam.fill(0);
    this.earomAddr = this.earomData = 0;
    this.flip = 0; this.player = 0;
    this.cycleCarry = this.irqCarry = this.sampleCarry = 0;
    this.avgOn = false; this.goThisFrame = false;
    this.vectors.count = 0;
    this.mathbox.reset();
    this.cpu.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x800) return this.ram[a];
    if (a >= 0x9000 && a < 0xE000) return this.roms.main[a - 0x9000];
    if (a >= 0xF000) return this.roms.main[a - 0xF000 + 0x4000];      // the last ROM again, for the vectors
    if (a >= 0x2000 && a < 0x3000) return this.vram[a - 0x2000];
    if (a >= 0x3000 && a < 0x4000) return this.roms.vector[a - 0x3000];
    switch (a) {
      // IN0: coins and service (active low); bit 6 the AVG done; bit 7 the 3 kHz clock.
      case 0x0C00: return (this.in0 & 0x3F) | 0x40 | (this.cpu.cycles & 0x100 ? 0x80 : 0);
      case 0x0D00: return this.dsw1;
      case 0x0E00: return this.dsw2;
      case 0x6040: return this.mathbox.status();
      case 0x6050: return this.earomData;
      case 0x6060: return this.mathbox.lo();
      case 0x6070: return this.mathbox.hi();
    }
    if (a >= 0x60C0 && a < 0x60E0) return this.pokeys[(a >> 4) & 1].read(a & 15);
    return 0;
  }

  write(a, v) {
    if (a < 0x800) { this.ram[a] = v; return; }
    if (a >= 0x2000 && a < 0x3000) { this.vram[a - 0x2000] = v; return; }
    if (a >= 0x0800 && a < 0x0810) { this.colorRam[a & 15] = v; return; }
    if (a >= 0x6000 && a < 0x6040) { this.earomAddr = a & 0x3F; this.earomData = v; return; }
    if (a >= 0x6080 && a < 0x60A0) { this.mathbox.go(a & 0x1F, v); return; }
    if (a >= 0x60C0 && a < 0x60E0) { this.pokeys[(a >> 4) & 1].write(a & 15, v); return; }
    switch (a) {
      case 0x4000: this.flip = v & 0x18; break;
      case 0x4800: this.avgOn = true; this.goThisFrame = true; this.drawList(); break;
      case 0x5000: this.cpu.irq = false; break;                       // IRQ acknowledge (and watchdog)
      case 0x5800: this.avgOn = false; break;
      case 0x6040:                                                    // EAROM control: read, or write
        if (v & 0x01) this.earomData = this.earom[this.earomAddr];
        if ((v & 0x0C) === 0x0C) this.earom[this.earomAddr] = this.earomData;
        break;
      case 0x60E0: this.player = v & 0x04; break;
    }
  }

  // Run the display list into the board's segments, in screen coordinates.
  drawList() {
    const segs = this.avg.run(), d = this.vectors.data, cr = this.colorRam;
    const fx = this.flip & 0x08 ? -1 : 1, fy = this.flip & 0x10 ? -1 : 1;
    let n = 0;
    for (let i = 0; i < segs.length && n < 6000; i += 6) {
      const o = n * 7, c = ~cr[segs[i + 4] & 15], b = segs[i + 5] / 255;
      d[o] = HALF_W + fx * segs[i]; d[o + 1] = HALF_H + fy * segs[i + 1];
      d[o + 2] = HALF_W + fx * segs[i + 2]; d[o + 3] = HALF_H + fy * segs[i + 3];
      d[o + 4] = (((c >> 1) & 1) * 0.95 + (c & 1) * 0.05) * b;
      d[o + 5] = ((c >> 3) & 1) * 0.95 * b;
      d[o + 6] = ((c >> 2) & 1) * 0.95 * b;
      n++;
    }
    this.vectors.count = n;
  }

  // ---------------------------------------------------------------- inputs

  // Spinner, fire (bit 4) and Superzapper (bit 3) on POKEY 2's pots; the
  // stick also turns the spinner. Starts on bits 5 and 6.
  setInputs(s) {
    const spin = (s.spin || 0) + (s.right ? 2 : 0) - (s.left ? 2 : 0);
    if (spin) this.knob = (this.knob + Math.round(spin)) & 0xFF;      // positive turns the claw clockwise
    this.pressed = (s.fire2 || s.up ? 0x08 : 0) | (s.fire ? 0x10 : 0) | (s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0);
    this.in0 = 0xFF & ~(s.coin ? 0x04 : 0);
  }
  // Medium difficulty, 1-3-5-7-9 rating; 1 coin 1 credit; lives and bonus.
  applySwitches(v) {
    this.dsw0 = 0x03 | 0x04;
    this.dsw1 = 0x00;
    this.dsw2 = v.lives | v.bonus;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const slices = 16;
    this.goThisFrame = false;
    for (let k = 0; k < slices; k++) {
      this.irqCarry += IRQ_RATE / 60 / slices;
      while (this.irqCarry >= 1) { this.irqCarry -= 1; this.cpu.irq = true; }
      this.cycleCarry += FRAME_CYCLES / slices;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += SAMPLES_PER_FRAME / slices;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    // The AVG loops on its own; redraw from the current list if the game didn't restart it.
    if (this.avgOn && !this.goThisFrame) this.drawList();
  }
}

Tempest.id = 'tempest';
Tempest.title = 'Tempest';
Tempest.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0xC0], ['3', 0x00], ['4', 0x40], ['5', 0x80]], default: 0x00 },
  { id: 'bonus', label: 'Bonus life', options: [['10000', 0x08], ['20000', 0x00], ['30000', 0x10], ['40000', 0x18], ['None', 0x38]], default: 0x00 },
];
