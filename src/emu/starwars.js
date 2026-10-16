// Atari Star Wars (1983): a 6809 at 1.5 MHz drawing with the color Analog
// Vector Generator (see avg.js), a matrix processor for the 3D (microcode in
// four PROMs: multiply-accumulate over math RAM, plus a hardware divider),
// and an analog flight yoke read through an A/D converter. A second 6809
// runs the sound: four POKEYs and a TMS5220 for the film's speech, with a
// 6532 RIOT for its timer and the speech chip's handshake. 40 frames a second.

import { M6809 } from './m6809.js';
import { AVG } from './avg.js';
import { Pokey, PokeyVoice } from './pokey.js';
import { TMS5220 } from './tms5220.js';
import { SoundMix, RATE } from './mixer.js';
import { capture, apply } from './state.js';
import { defaultSwitches } from './pacman.js';

const CPU_CLOCK = 12096000 / 8, IRQ_RATE = 12096000 / 4096 / 12, REFRESH = 40;
const FRAME_CYCLES = CPU_CLOCK / REFRESH, SAMPLES_PER_FRAME = RATE / REFRESH;
const SPEECH_EVERY = RATE / 8000;                  // the TMS5220 makes 8000 samples a second
const STATE = ['ram', 'vram', 'mathRam', 'nvOverlay', 'nvram', 'bank', 'adcSel', 'yoke', 'in0', 'in1',
  'toSound', 'toMain', 'portA', 'portB', 'ddrA', 'ddrB', 'irqFlag', 'pa7Irq', 'timer', 'sndRam', 'riotRam',
  'prng', 'prngAt', 'mpa', 'bic', 'regA', 'regB', 'regC', 'acc', 'divisor', 'dividend', 'dvdShift', 'quotient',
  'cycleCarry', 'irqCarry', 'soundCarry', 'sampleCarry', 'speechCarry', 'cpu', 'snd', 'sound', 'speech'];

// The visible window is 250 x 280 AVG units around the center, shown 4:3.
const HALF_W = 512, HALF_H = 384, SX = HALF_W / 128, SY = HALF_H / 146;

export class StarWars {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.drawList(); }

  // roms: { main 8000-FFFF (32K), banked 2 x 8K for 6000-7FFF, vector 3000-3FFF,
  //         sound 16K (4000-7FFF, mirrored at C000), prom 4 x 1K }
  constructor(roms) {
    this.vector = true;
    this.width = HALF_W * 2;
    this.height = HALF_H * 2;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.analogStick = true;
    this.buttons = 1;                          // the yoke's triggers and thumb buttons all fire
    this.roms = roms;
    // The matrix processor's microcode: 16-bit words from the four PROMs (110 the top nibble).
    this.micro = new Uint16Array(1024);
    for (let i = 0; i < 1024; i++) {
      this.micro[i] = ((roms.prom[i] & 15) << 12) | ((roms.prom[0x400 + i] & 15) << 8)
        | ((roms.prom[0x800 + i] & 15) << 4) | (roms.prom[0xC00 + i] & 15);
    }
    this.ram = new Uint8Array(0x800);          // 4800-4FFF
    this.vram = new Uint8Array(0x3000);        // 0000-2FFF
    this.mathRam = new Uint8Array(0x1000);     // 5000-5FFF
    this.nvOverlay = new Uint8Array(0x100);    // 4500-45FF
    this.nvram = new Uint8Array(0x100);        // the X2212's backing store
    this.sndRam = new Uint8Array(0x800);       // 2000-27FF
    this.riotRam = new Uint8Array(0x80);       // 1000-107F
    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.snd = new M6809({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.avg = new AVG((a) => (a < 0x3000 ? this.vram[a] : this.roms.vector[(a - 0x3000) & 0xFFF]), 'starwars');
    this.pokeys = [0, 1, 2, 3].map(() => new Pokey(1500000, 1.2));
    this.speech = new TMS5220(0.9);
    this.sound = new SoundMix([...this.pokeys.map((p) => new PokeyVoice(p)), this.speech], 1);
    this.vectors = { data: new Float32Array(7 * 8000), count: 0 };
    this.in0 = 0xFF; this.in1 = 0xFF;
    this.yoke = new Float64Array(2);           // x, y: -1..1
    this.applySwitches({});
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.mathRam.fill(0); this.sndRam.fill(0); this.riotRam.fill(0);
    this.bank = 0; this.adcSel = 0;
    this.toSound = this.toMain = 0;
    this.portA = this.portB = this.ddrA = this.ddrB = 0;
    this.irqFlag = 0; this.pa7Irq = 0; this.timer = -1;
    this.prng = 0; this.prngAt = 0;
    this.mpa = this.bic = 0; this.regA = this.regB = this.regC = 0; this.acc = 0;
    this.divisor = this.dividend = this.dvdShift = this.quotient = 0;
    this.cycleCarry = this.irqCarry = this.soundCarry = this.sampleCarry = this.speechCarry = 0;
    this.vectors.count = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset(); this.speech.reset();
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a >= 0x8000) return this.roms.main[a - 0x8000];
    if (a >= 0x6000) return this.roms.banked[this.bank * 0x2000 + a - 0x6000];
    if (a >= 0x5000) return this.mathRam[a - 0x5000];
    if (a >= 0x4800) return this.ram[a - 0x4800];
    if (a < 0x3000) return this.vram[a];
    if (a < 0x4000) return this.roms.vector[a - 0x3000];
    if (a >= 0x4500 && a < 0x4600) return this.nvOverlay[a - 0x4500];
    switch (a & 0xFFE0) {
      case 0x4300: return this.in0;
      // IN1: buttons; bit 6 the AVG done; bit 7 the matrix processor running (never: it's instant).
      case 0x4320: return (this.in1 & 0x3F) | 0x40;
      case 0x4340: return this.dsw0;
      case 0x4360: return this.dsw1;
      case 0x4380: return this.adc();
    }
    switch (a) {
      case 0x4400: this.portA &= ~0x40; return this.toMain;
      case 0x4401: return this.portA & 0xC0;
      case 0x4700: return (this.quotient >> 8) & 0xFF;
      case 0x4701: return this.quotient & 0xFF;
      case 0x4703: return this.random();
    }
    return 0;
  }

  write(a, v) {
    if (a < 0x3000) { this.vram[a] = v; return; }
    if (a >= 0x4800 && a < 0x5000) { this.ram[a - 0x4800] = v; return; }
    if (a >= 0x5000 && a < 0x6000) { this.mathRam[a - 0x5000] = v; return; }
    if (a >= 0x4500 && a < 0x4600) { this.nvOverlay[a - 0x4500] = v; return; }
    if (a >= 0x4700 && a < 0x4708) { this.mathWrite(a & 7, v); return; }
    switch (a & 0xFFE0) {
      case 0x4600: this.drawList(); return;
      case 0x4660: this.cpu.irq = false; return;
      case 0x4680:
        if ((a & 7) === 4) this.bank = (v >> 7) & 1;
        else if ((a & 7) === 7) this.nvOverlay.set(this.nvram);          // recall
        return;
      case 0x46A0: this.nvram.set(this.nvOverlay); return;              // store
      case 0x46C0: this.adcSel = a & 3; return;
      case 0x46E0: this.portA &= 0x3F; this.snd.reset(); return;
      // 4620 AVG reset, 4640 watchdog.
    }
    if (a === 0x4400) {
      this.toSound = v; this.portA |= 0x80;
      if (this.pa7Irq) this.snd.irq = true;
    }
  }

  // The yoke: pitch (0) and yaw (1), 0x80 centered.
  adc() {
    if (this.adcSel > 1) return 0;
    const v = this.adcSel === 0 ? -this.yoke[1] : this.yoke[0];     // stick up aims up
    return Math.max(0, Math.min(255, Math.round(0x80 + v * 0x7F)));
  }

  // The PRNG: a 23-bit shift register (taps 4 and 22, feedback inverted)
  // running at 3 MHz; the CPU sees bits 8-15. Stepped here by the cycles since
  // the last read.
  random() {
    let n = Math.min(64, Math.max(1, (this.cpu.cycles - this.prngAt) * 2)), r = this.prng;
    this.prngAt = this.cpu.cycles;
    while (n--) r = ((r << 1) | (~((r >> 4) ^ (r >> 22)) & 1)) & 0x7FFFFF;
    this.prng = r;
    return (r >> 8) & 0xFF;
  }

  // ---------------------------------------------------------------- matrix processor

  mathWrite(r, v) {
    switch (r) {
      case 0: this.mpa = v << 2; this.runMath(); break;
      case 1: this.bic = (this.bic & 0xFF) | ((v & 1) << 8); break;
      case 2: this.bic = (this.bic & 0x100) | v; break;
      case 4: this.divisor = (this.divisor & 0xFF) | (v << 8); this.dvdShift = this.dividend; this.quotient = 0; break;
      case 5: {
        // Writing the divisor's low byte runs the divider: restoring division, 15 quotient bits.
        this.divisor = (this.divisor & 0xFF00) | v;
        const neg = (~this.divisor + 1) & 0xFFFF;
        for (let i = 1; i < 16; i++) {
          this.quotient = (this.quotient << 1) & 0xFFFF;
          const t = this.dvdShift + neg;
          if (t & 0x10000) { this.quotient |= 1; this.dvdShift = (t << 1) & 0xFFFF; }
          else this.dvdShift = (this.dvdShift << 1) & 0xFFFF;
        }
        break;
      }
      case 6: this.dividend = (this.dividend & 0xFF) | (v << 8); break;
      case 7: this.dividend = (this.dividend & 0xFF00) | v; break;
    }
  }

  // Run microcode from MPA until a halt. Each word: bits 15-8 strobes (80 load
  // A, 40 load B, 20 load C and multiply-accumulate (A-B)*C, 10 clear the
  // accumulator, 08 next block, 04 halt, 02 store the accumulator, 01 load it),
  // bit 7 direct addressing, bits 6-0 the address (or, indexed, 2 bits within
  // the current block of four words).
  runMath() {
    const m = this.mathRam, micro = this.micro;
    for (let guard = 0; guard < 100000; guard++) {
      const w = micro[this.mpa], strobe = w >> 8;
      const ma = w & 0x80 ? w & 0x7F : (w & 3) | ((this.bic & 0x1FF) << 2);
      const o = (ma << 1) & 0xFFF;
      const word = ((m[o] << 8) | m[o + 1]) << 16 >> 16;
      if (strobe & 0x10) this.acc = 0;
      if (strobe & 0x01) this.acc = word << 16;
      if (strobe & 0x02) { const hi = (this.acc >> 16) & 0xFFFF; m[o] = hi >> 8; m[o + 1] = hi & 0xFF; }
      if (strobe & 0x08) this.bic = (this.bic + 1) & 0x1FF;
      if (strobe & 0x20) {
        this.regC = word;
        // The serial multiplier's pipeline leaves the product shifted up two places.
        this.acc = (this.acc + (Math.imul((this.regA - this.regB) << 1, this.regC) << 1)) | 0;
        // A and B are left holding just their signs.
        this.regA = this.regA < 0 ? -1 : 0;
        this.regB = this.regB < 0 ? -1 : 0;
      }
      if (strobe & 0x40) this.regB = word;
      if (strobe & 0x80) this.regA = word;
      this.mpa = (this.mpa & 0x300) | ((this.mpa + 1) & 0xFF);
      if (strobe & 0x04) return;
    }
  }

  // Display list -> segments. Colors are 3-bit RGB.
  drawList() {
    const segs = this.avg.run(), d = this.vectors.data;
    let n = 0;
    for (let i = 0; i < segs.length && n < 8000; i += 6) {
      const o = n * 7, c = segs[i + 4], b = segs[i + 5] / 255;
      d[o] = HALF_W + segs[i] * SX; d[o + 1] = HALF_H - segs[i + 1] * SY;
      d[o + 2] = HALF_W + segs[i + 2] * SX; d[o + 3] = HALF_H - segs[i + 3] * SY;
      d[o + 4] = (c >> 2) & 1 ? b : 0; d[o + 5] = (c >> 1) & 1 ? b : 0; d[o + 6] = c & 1 ? b : 0;
      n++;
    }
    this.vectors.count = n;
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a >= 0xC000) return this.roms.sound[a - 0xC000];
    if (a >= 0x4000 && a < 0x8000) return this.roms.sound[a - 0x4000];
    if (a >= 0x2000 && a < 0x2800) return this.sndRam[a - 0x2000];
    if (a >= 0x1000 && a < 0x1080) return this.riotRam[a - 0x1000];
    if (a >= 0x0800 && a < 0x1000) {
      this.portA &= 0x7F;
      if (this.pa7Irq) this.snd.irq = false;
      return this.toSound;
    }
    if (a >= 0x1080 && a < 0x10A0) {
      switch (a & 0x1F) {
        // Port A: 80 command waiting, 40 reply waiting, 10 not self test, 04 speech busy.
        case 0: return this.portA | 0x10 | (this.speech.ready() ? 0 : 0x04);
        case 1: return this.ddrA;
        case 2: return this.portB;
        case 3: return this.ddrB;
        case 5: { const f = this.irqFlag; this.irqFlag = 0; this.snd.irq = false; return f; }
      }
    }
    return 0;
  }

  soundWrite(a, v) {
    if (a < 0x0800) { this.toMain = v; this.portA |= 0x40; return; }
    if (a >= 0x2000 && a < 0x2800) { this.sndRam[a - 0x2000] = v; return; }
    if (a >= 0x1000 && a < 0x1080) { this.riotRam[a - 0x1000] = v; return; }
    if (a >= 0x1800 && a < 0x1840) {
      const o = a & 0x3F;
      this.pokeys[(o >> 3) & 3].write((o & 7) | ((o & 0x20) >> 2), v);
      return;
    }
    if (a >= 0x1080 && a < 0x10A0) {
      switch (a & 0x1F) {
        case 0: {
          // PA0 falling: the speech chip takes port B.
          const was = this.portA;
          this.portA = (this.portA & ~this.ddrA) | (v & this.ddrA);
          if ((was & 1) && !(this.portA & 1)) this.speech.write(this.portB);
          break;
        }
        case 1: this.ddrA = v; break;
        case 2: this.portB = v; break;
        case 3: this.ddrB = v; break;
        case 7: this.pa7Irq = v; break;
        case 0x1F: this.timer = v * 1024; break;           // one shot, then IRQ
      }
    }
  }

  // ---------------------------------------------------------------- inputs

  // The yoke follows a real stick (touch or gamepad) where there is one;
  // otherwise the d-pad steers it, springing back to center when let go.
  // The triggers (IN0 bit 7, IN1 bit 4) and thumb buttons (IN0 bit 6, IN1 bit 5) all fire.
  setInputs(s) {
    const y = this.yoke;
    if (s.analog) { y[0] = s.analog.x; y[1] = s.analog.y; }
    else {
      const tx = (s.right ? 1 : 0) - (s.left ? 1 : 0), ty = (s.down ? 1 : 0) - (s.up ? 1 : 0);
      y[0] += Math.max(-0.08, Math.min(0.08, tx - y[0]));
      y[1] += Math.max(-0.08, Math.min(0.08, ty - y[1]));
    }
    const fire = s.fire || s.fire2;
    this.in0 = 0xFF & ~((s.coin ? 0x02 : 0) | (fire ? 0xC0 : 0));
    this.in1 = 0xFF & ~((fire ? 0x30 : 0) | 0x0B);
  }
  applySwitches() { this.dsw0 = 0x80; this.dsw1 = 0x02; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const slices = 32, soundPer = FRAME_CYCLES / slices;
    for (let k = 0; k < slices; k++) {
      this.irqCarry += IRQ_RATE / REFRESH / slices;
      while (this.irqCarry >= 1) { this.irqCarry -= 1; this.cpu.irq = true; }
      this.cycleCarry += FRAME_CYCLES / slices;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.soundCarry += soundPer;
      const ran = this.snd.run(Math.floor(this.soundCarry));
      this.soundCarry -= ran;
      if (this.timer >= 0) {
        this.timer -= ran;
        if (this.timer < 0) { this.irqFlag |= 0x80; this.snd.irq = true; }
      }
      this.sampleCarry += SAMPLES_PER_FRAME / slices;
      while (this.sampleCarry >= 1) {
        this.sampleCarry -= 1;
        if (++this.speechCarry >= SPEECH_EVERY) { this.speechCarry -= SPEECH_EVERY; this.speech.clock(); }
        this.sound.sample();
      }
    }
  }
}

StarWars.id = 'starwars';
StarWars.title = 'Star Wars';
StarWars.switches = [];

// The Empire Strikes Back (1985): the Star Wars board with more program behind
// two kinds of banking. The bank bit that switches 6000-7FFF also switches
// A000-FFFF, and 8000-9FFF is a window onto four 8K pages run by a slapstic
// (137412-101): a chip that watches the addresses the CPU touches in its
// window and changes page after particular sequences of them. As in MAME, it
// sees data accesses, the target of a jump into the window and the address of
// a jump out of it, but not the instruction stream in between (which ESB's
// code depends on: it runs from the window).
const SLAP101 = {
  banks: [0x80, 0x90, 0xA0, 0xB0], start: 3,
  // The alternate sequence's first step is unknown, so (as MAME does) the second one starts it.
  alt2: [0x1FFF, 0x1DFE], alt3: [0x1FFC, 0x1B5C], alt4: [0x1FCF, 0x0080],
  bit1: [0x1FF0, 0x1540], bit2c0: [0x1FF3, 0x1540], bit2s0: [0x1FF3, 0x1541], bit2c1: [0x1FF3, 0x1542], bit2s1: [0x1FF3, 0x1543],
  bit3: [0x1FF8, 0x1550],
};
const S_DISABLED = 0, S_ENABLED = 1, S_BIT1 = 2, S_BIT2 = 3, S_BIT3 = 4, S_ALT2 = 5, S_ALT3 = 6;
const hit = (v, [mask, value]) => (v & mask) === value;

export class EmpireStrikesBack extends StarWars {
  saveState() { return { ...super.saveState(), slap: Array.from(this.slap) }; }
  loadState(s) { super.loadState(s); this.slap.set(s.slap); }

  // roms: { banked 16K (6000-7FFF, two pages), slap 32K (8000-9FFF, four pages), hi 48K (A000-FFFF, two pages),
  //         vector 4K, sound 16K (4000-7FFF), soundHi 16K (C000-FFFF), prom 4 x 1K }
  constructor(roms) {
    super(roms);
    this.slap = new Int32Array(5);                 // state, page, bitwise page, bitwise xor, alternate page
    this.lastFetch = -1;                           // the last instruction-stream address read
    // After each instruction: a jump into the window shows the chip its target; a jump out of it
    // shows the jump's own address (except the four bank-select addresses themselves).
    const step = this.cpu.step.bind(this.cpu);
    this.cpu.step = () => {
      const prev = this.cpu.pc;
      step();
      const cur = this.cpu.pc;
      if (cur === ((this.lastFetch + 1) & 0xFFFF)) return;           // straight on: not a jump
      if ((cur & 0xE000) === 0x8000) this.slapTweak(cur & 0x1FFF);
      else if ((prev & 0xE000) === 0x8000 && !SLAP101.banks.includes(prev & 0x1FFF)) this.slapTweak(prev & 0x1FFF);
    };
    this.applySwitches(defaultSwitches(EmpireStrikesBack.switches));
    this.reset();
  }

  reset() {
    super.reset();
    if (this.slap) { this.slap.fill(0); this.slap[0] = S_DISABLED; this.slap[1] = SLAP101.start; }
  }

  read(a) {
    // Reads at the program counter (and the byte after, for 16-bit operands) are the instruction stream.
    const pc = this.cpu ? this.cpu.pc : -1, stream = a === pc || a === ((pc + 1) & 0xFFFF);
    if (stream) this.lastFetch = a;
    if (a >= 0xA000) return this.roms.hi[this.bank * 0x6000 + a - 0xA000];
    if (a >= 0x8000) { const v = this.roms.slap[this.slap[1] * 0x2000 + (a & 0x1FFF)]; if (!stream) this.slapTweak(a & 0x1FFF); return v; }
    return super.read(a);
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0xA000) { this.slapTweak(a & 0x1FFF); return; }
    super.write(a, v);
  }

  soundRead(a) {
    if (a >= 0xC000) return this.roms.soundHi[a - 0xC000];
    return super.soundRead(a);
  }

  // The slapstic's state machine: offset 0 arms it; a bank address then picks a page, the
  // alternate sequence picks one from its third address, or the bitwise sequence sets it a bit at a time.
  slapTweak(o) {
    const s = this.slap, S = SLAP101;
    if (o === 0) { s[0] = S_ENABLED; return; }
    const bankHit = S.banks.indexOf(o);
    switch (s[0]) {
      case S_ENABLED:
        if (hit(o, S.bit1)) s[0] = S_BIT1;
        else if (hit(o, S.alt2)) s[0] = S_ALT2;
        else if (bankHit >= 0) { s[0] = S_DISABLED; s[1] = bankHit; }
        break;
      case S_ALT2:
        if (hit(o, S.alt3)) { s[0] = S_ALT3; s[4] = o & 3; } else s[0] = S_ENABLED;
        break;
      case S_ALT3: if (hit(o, S.alt4)) { s[0] = S_DISABLED; s[1] = s[4]; } break;
      case S_BIT1: if (bankHit >= 0) { s[0] = S_BIT2; s[2] = s[1]; s[3] = 0; } break;
      case S_BIT2:
        if (hit(o ^ s[3], S.bit2c0)) { s[2] &= ~1; s[3] ^= 3; }
        else if (hit(o ^ s[3], S.bit2s0)) { s[2] |= 1; s[3] ^= 3; }
        else if (hit(o ^ s[3], S.bit2c1)) { s[2] &= ~2; s[3] ^= 3; }
        else if (hit(o ^ s[3], S.bit2s1)) { s[2] |= 2; s[3] ^= 3; }
        else if (hit(o, S.bit3)) s[0] = S_BIT3;
        break;
      case S_BIT3: if (bankHit >= 0) { s[0] = S_DISABLED; s[1] = s[2]; } break;
    }
  }

  // DSW0: 4 shields, moderate, Jedi letters "increment", demo sounds, no freeze. DSW1: 1 coin 1 credit.
  applySwitches(v) { this.dsw0 = v.shields | v.difficulty | 0x30 | 0x40 | 0x80; this.dsw1 = 0xE2; }
}

EmpireStrikesBack.id = 'esb';
EmpireStrikesBack.title = 'The Empire Strikes Back';
EmpireStrikesBack.switches = [
  { id: 'shields', label: 'Shields', options: [['2', 0x01], ['3', 0x00], ['4', 0x03], ['5', 0x02]], default: 0x03 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x08], ['Moderate', 0x0C], ['Hard', 0x00], ['Hardest', 0x04]], default: 0x0C },
];
