// Konami's Time Pilot sound board, as used by several early-80s Konami games
// (Tutankham, Roc'n Rope, ...): a Z80 at 1.79 MHz with two AY-3-8910s, each
// channel through a switchable RC low-pass filter. The main CPU writes a
// command latch and interrupts the Z80 with a 0-to-1 edge.
//
// (Time Pilot and Pooyan have their own copy in timeplt.js, kept as it is so
// their save states stay compatible.)

import { Z80 } from './z80.js';
import { AY8910 } from './ay8910.js';
import { SoundMix, RATE } from './mixer.js';
import { capture, apply } from './state.js';

export const SOUND_CLOCK = 14318180 / 8;
// The first AY's port B reads a timer: the Z80's clock divided by 512, then a bi-quinary divide-by-10.
const TIMER = [0x00, 0x10, 0x20, 0x30, 0x40, 0x90, 0xA0, 0xB0, 0xA0, 0xD0];
// Each channel's filter: 1K in parallel with 5.1K into 0.22 uF and/or 0.047 uF, picked by two address lines.
const R_FILTER = (1000 * 5100) / (1000 + 5100);
const tau = (bits) => R_FILTER * ((bits & 1 ? 0.22e-6 : 0) + (bits & 2 ? 0.047e-6 : 0));
const STATE = ['ram', 'latch', 'lastTrigger', 'carry', 'cycleCarry', 'cpu', 'sound'];

export class TimePilotSound {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // rom: the Z80 program (up to 8K); gain: the AYs' level.
  constructor(rom, gain = 3) {
    this.rom = rom;
    this.ram = new Uint8Array(0x400);
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.ay = [
      new AY8910(SOUND_CLOCK, (port) => (port === 0 ? this.latch : TIMER[Math.floor((this.cpu.cycles % 5120) / 512)]), gain),
      new AY8910(SOUND_CLOCK, () => 0xFF, gain),
    ];
    this.sound = new SoundMix(this.ay);
    this.reset();
  }

  reset() {
    this.ram.fill(0);
    this.latch = 0; this.lastTrigger = 0; this.carry = 0; this.cycleCarry = 0;
    this.cpu.reset(); this.sound.reset();
  }

  // From the main CPU: the command, and the interrupt line (a rising edge interrupts).
  command(v) { this.latch = v; }
  trigger(v) { if (v & 1 && !this.lastTrigger) this.cpu.irq = true; this.lastTrigger = v & 1; }

  read(a) {
    if (a < 0x2000) return this.rom[a] ?? 0xFF;
    if (a >= 0x3000 && a < 0x3400) return this.ram[a - 0x3000];
    if (a === 0x4000) return this.ay[0].read();
    if (a === 0x6000) return this.ay[1].read();
    return 0xFF;
  }
  write(a, v) {
    if (a >= 0x3000 && a < 0x3400) { this.ram[a - 0x3000] = v; return; }
    switch (a & 0xF000) {
      case 0x4000: this.ay[0].write(v); return;
      case 0x5000: this.ay[0].select(v); return;
      case 0x6000: this.ay[1].write(v); return;
      case 0x7000: this.ay[1].select(v); return;
      case 0x8000:                               // the address lines set the six filters
        for (let ch = 0; ch < 3; ch++) {
          this.ay[0].setFilter(ch, tau((a >> (6 + 2 * ch)) & 3));
          this.ay[1].setFilter(ch, tau((a >> (2 * ch)) & 3));
        }
    }
  }

  // Run for `seconds`, producing samples as it goes (the board's `sound` is this.sound).
  run(seconds) {
    this.cycleCarry += SOUND_CLOCK * seconds;
    this.carry += RATE * seconds;
    const n = Math.floor(this.carry);
    this.carry -= n;
    for (let k = 0; k < n; k++) {
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry / (n - k)));
      this.sound.sample();
    }
    if (!n) this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
  }
}
