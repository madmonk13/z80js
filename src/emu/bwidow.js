// Atari's color vector board (1981-82): Black Widow, Gravitar, Space Duel.
// A 6502 at 1.5 MHz, the Analog Vector Generator drawing in 7 colors (red,
// green and blue bits) at 16 intensities, two POKEYs for sound (their pot
// lines read the DIP switches), and an EAROM for high scores (`nvram`). An
// IRQ about 250 times a second, acknowledged by a write.
//
// Black Widow and Gravitar share one address map; Space Duel moves
// everything into the first 4K and runs its picture at 45 Hz.

import { CPU6502 } from './m6502.js';
import { AVG } from './avg.js';
import { Pokey, PokeyVoice } from './pokey.js';
import { SoundMix, RATE } from './mixer.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const CPU_CLOCK = 12096000 / 8, IRQ_RATE = 12096000 / 4096 / 12;
const STATE = ['ram', 'vram', 'earom', 'earomOffset', 'earomData', 'cycleCarry', 'irqCarry', 'sampleCarry', 'in0', 'in3', 'in4', 'cpu', 'sound'];

export class AtariColorVector {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.drawList(); }

  // roms: { mem: a 64K image with the vector ROM at 2800 and the program ROMs in place }
  constructor(roms) {
    const k = this.constructor;
    this.vector = true;
    this.halfW = k.screen[0] / 2; this.halfH = k.screen[1] / 2;
    this.width = k.screen[0]; this.height = k.screen[1];
    this.refresh = k.refresh || 60;
    this.controls = 'two-way';
    this.buttons = 3;
    this.button2 = 'Thrust'; this.button3 = 'Shield';
    this.roms = roms;
    this.ram = new Uint8Array(k.duel ? 0x400 : 0x800);
    this.vram = new Uint8Array(0x800);
    this.earom = new Uint8Array(64); this.nvram = this.earom;
    this.cpu = new CPU6502({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.avg = new AVG((a) => this.read(0x2000 + a), 'avg');
    this.pokey1 = new Pokey(CPU_CLOCK, 1); this.pokey1.readPots = () => this.dsw0;
    this.pokey2 = new Pokey(CPU_CLOCK, 1); this.pokey2.readPots = () => this.dsw1;
    this.sound = new SoundMix([new PokeyVoice(this.pokey1), new PokeyVoice(this.pokey2)], 0.7);
    this.vectors = { data: new Float32Array(7 * 6000), count: 0 };
    this.in0 = 0xFF; this.in3 = this.in4 = 0;
    this.applySwitches(defaultSwitches(k.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0);
    this.earomOffset = 0; this.earomData = 0;
    this.cycleCarry = this.irqCarry = this.sampleCarry = 0;
    this.vectors.count = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // IN0: coins (active low), service off; bit 6 the AVG done; bit 7 the 3 kHz clock.
  readIn0() { return (this.in0 & 0x3F) | 0x40 | (this.cpu.cycles & 0x100 ? 0x80 : 0); }

  read(a) {
    if (a < this.ram.length) return this.ram[a];
    if (a >= 0x2000 && a < 0x2800) return this.vram[a - 0x2000];
    if (this.constructor.duel) {
      if (a >= 0x2800) return this.roms.mem[a];
      if (a === 0x0800) return this.readIn0();
      if (a >= 0x0900 && a < 0x0908) return this.duelInput(a & 7);
      if (a === 0x0A00) return this.earomData;
      if (a >= 0x1000 && a < 0x1010) return this.pokey1.read(a & 15);
      if (a >= 0x1400 && a < 0x1410) return this.pokey2.read(a & 15);
      return 0;
    }
    if ((a >= 0x2800 && a < 0x6000) || a >= 0x9000) return this.roms.mem[a];
    if (a >= 0x6000 && a < 0x6800) return this.pokey1.read(a & 15);
    if (a >= 0x6800 && a < 0x7000) return this.pokey2.read(a & 15);
    switch (a) {
      case 0x7000: return this.earomData;
      case 0x7800: return this.readIn0();
      case 0x8000: return this.in3;
      case 0x8800: return this.in4;
    }
    return 0;
  }

  write(a, v) {
    if (a < this.ram.length) { this.ram[a] = v; return; }
    if (a >= 0x2000 && a < 0x2800) { this.vram[a - 0x2000] = v; return; }
    if (this.constructor.duel) {
      if (a >= 0x1000 && a < 0x1010) this.pokey1.write(a & 15, v);
      else if (a >= 0x1400 && a < 0x1410) this.pokey2.write(a & 15, v);
      else if (a >= 0x0F00 && a < 0x0F40) { this.earomOffset = a & 0x3F; this.earomData = v; }
      else if (a === 0x0C80) this.drawList();
      else if (a === 0x0E00) this.cpu.irq = false;
      else if (a === 0x0E80) this.earomCtrl(v);
      return;
    }
    if (a >= 0x6000 && a < 0x6800) this.pokey1.write(a & 15, v);
    else if (a >= 0x6800 && a < 0x7000) this.pokey2.write(a & 15, v);
    else if (a >= 0x8940 && a < 0x8980) { this.earomOffset = a & 0x3F; this.earomData = v; }
    else if (a === 0x8840) this.drawList();
    else if (a === 0x88C0) this.cpu.irq = false;
    else if (a === 0x8900) this.earomCtrl(v);
  }

  // EAROM control: bit 0 clocks a read; 0C writes the latched byte.
  earomCtrl(v) {
    if (v & 1) this.earomData = this.earom[this.earomOffset];
    if ((v & 0x0C) === 0x0C) this.earom[this.earomOffset] = this.earomData;
  }

  drawList() {
    const segs = this.avg.run(), d = this.vectors.data, hw = this.halfW, hh = this.halfH;
    let n = 0;
    for (let i = 0; i < segs.length && n < 6000; i += 6) {
      const o = n * 7, c = segs[i + 4], b = segs[i + 5] / 255;
      d[o] = hw + segs[i]; d[o + 1] = hh - segs[i + 1]; d[o + 2] = hw + segs[i + 2]; d[o + 3] = hh - segs[i + 3];
      d[o + 4] = (c & 4 ? 1 : 0) * b; d[o + 5] = (c & 2 ? 1 : 0) * b; d[o + 6] = (c & 1 ? 1 : 0) * b;
      n++;
    }
    this.vectors.count = n;
  }

  runFrame() {
    const slices = 16, frame = CPU_CLOCK / this.refresh, samples = RATE / this.refresh;
    for (let k = 0; k < slices; k++) {
      this.irqCarry += IRQ_RATE / this.refresh / slices;
      while (this.irqCarry >= 1) { this.irqCarry -= 1; this.cpu.irq = true; }
      this.cycleCarry += frame / slices;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.sampleCarry += samples / slices;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }
}

// ---------------------------------------------------------------- the games

// Black Widow: twin sticks, one to move and one to shoot (active low).
export class BlackWidow extends AtariColorVector {
  constructor(roms) { super(roms); this.controls = 'eight-way'; this.buttons = 0; this.twinStick = true; }
  setInputs(s) {
    const a = s.aim || {};
    this.in0 = 0xFF & ~((s.coin ? 0x02 : 0));
    this.in3 = 0xFF & ~((s.right ? 1 : 0) | (s.left ? 2 : 0) | (s.down ? 4 : 0) | (s.up ? 8 : 0));
    this.in4 = 0xFF & ~((a.right ? 1 : 0) | (a.left ? 2 : 0) | (a.down ? 4 : 0) | (a.up ? 8 : 0) | (s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0));
  }
  applySwitches(v) { this.dsw0 = 0x00; this.dsw1 = 0x01 | v.lives | v.difficulty; }
}
BlackWidow.id = 'bwidow'; BlackWidow.title = 'Black Widow';
BlackWidow.screen = [480, 440];
BlackWidow.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x00], ['4', 0x04], ['5', 0x08], ['6', 0x0C]], default: 0x00 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x00], ['Medium', 0x10], ['Hard', 0x20], ['Demo', 0x30]], default: 0x10 },
];

// Gravitar: rotate, fire, thrust, and the shield / tractor beam (active low).
export class Gravitar extends AtariColorVector {
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x02 : 0));
    this.in3 = 0xFF & ~((s.fire3 ? 0x01 : 0) | (s.fire ? 0x02 : 0) | (s.right ? 0x04 : 0) | (s.left ? 0x08 : 0) | (s.fire2 || s.up ? 0x10 : 0));
    this.in4 = 0xFF & ~((s.start1 ? 0x20 : 0) | (s.start2 ? 0x40 : 0));
  }
  applySwitches(v) { this.dsw0 = v.lives | v.difficulty; this.dsw1 = 0x00; }
}
Gravitar.id = 'gravitar'; Gravitar.title = 'Gravitar';
Gravitar.screen = [420, 400];
Gravitar.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x00], ['4', 0x04], ['5', 0x08], ['6', 0x0C]], default: 0x04 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x00], ['Hard', 0x10]], default: 0x00 },
];

// Space Duel: the controls spread over 8 addresses, two bits each (active high).
export class SpaceDuel extends AtariColorVector {
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x02 : 0));
    this.pad = { left: s.left, right: s.right, fire: s.fire, shield: s.fire3, thrust: s.fire2 || s.up, start: s.start1, select: s.start2 };
  }
  duelInput(n) {
    const p = this.pad || {};
    switch (n) {
      case 0: return (p.shield ? 0x80 : 0) | (p.fire ? 0x40 : 0);
      case 2: return (p.left ? 0x80 : 0) | (p.right ? 0x40 : 0);
      case 4: return (p.thrust ? 0x80 : 0) | (p.start ? 0x40 : 0);
      case 6: return p.select ? 0x80 : 0;
    }
    return 0;
  }
  applySwitches(v) { this.dsw0 = v.lives; this.dsw1 = 0x00; }
}
SpaceDuel.id = 'spacduel'; SpaceDuel.title = 'Space Duel';
SpaceDuel.duel = true; SpaceDuel.refresh = 45;
SpaceDuel.screen = [540, 400];
SpaceDuel.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x01], ['4', 0x00], ['5', 0x03], ['6', 0x02]], default: 0x01 },
];
