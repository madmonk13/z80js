// Konami Gyruss (1983): a Z80 at 3 MHz runs the game and a 32x32 map of 8x8
// two-bit characters (some marked to sit in front of the sprites); a 6809
// with Konami's opcode encryption multiplexes the 8x16 sprites, rewriting a
// small list as the beam moves down, so the list is caught line by line (as
// on Time Pilot '84). 32 colors through two lookup PROMs.
//
// Sound: a Z80 with five AY-3-8910s (port B of the first two sets each
// channel's filter, port A of the third reads a timer), and an 8039 playing
// samples through a DAC. 256x224 on a vertical monitor at 60 Hz.

import { Z80 } from './z80.js';
import { Konami1 } from './m6809.js';
import { I8035 } from './i8035.js';
import { AY8910 } from './ay8910.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16, LINES = 256, REFRESH = 60;
const CPU_CLOCK = 3072000, SUB_CLOCK = 2000000, SOUND_CLOCK = 14318180 / 4, MCU_CLOCK = 8000000 / 15;
const SPRITES = 0x40, SPRITE_BYTES = 0xC0;         // the 6809's live sprite list, 4040-40FF
const TIMER = [0x00, 0x01, 0x02, 0x03, 0x04, 0x09, 0x0A, 0x0B, 0x0A, 0x0D];   // the sound timer's count sequence
const STATE = ['ram', 'vram', 'shared', 'subRam', 'soundRam', 'mux', 'nmiOn', 'subIrqOn', 'line', 'latch', 'latch2',
  'in0', 'in1', 'cycleCarry', 'subCarry', 'soundCarry', 'mcuCarry', 'sampleCarry', 'cpu', 'sub', 'snd', 'mcu', 'sound'];

// The 8039's DAC.
class DAC {
  constructor(gain) { this.gain = gain; this.reset(); }
  reset() { this.value = 0x80; this.out = 0; }
  saveState() { return { value: this.value }; }
  loadState(s) { this.value = s.value; }
  sample() { this.out = (this.value - 0x80) / 128 * this.gain; }
}

export class Gyruss {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (0000-5FFF), sub (E000-FFFF), sound (0000-3FFF), mcu (8039), chars, sprites, palette, spriteLut, charLut }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 1;
    this.roms = roms;
    this.vram = new Uint8Array(0x800);         // 8000-83FF colors, 8400-87FF codes
    this.ram = new Uint8Array(0x1000);         // 9000-9FFF
    this.shared = new Uint8Array(0x800);       // A000-A7FF on the Z80, 6000-67FF on the 6809
    this.subRam = new Uint8Array(0x800);       // 4000-47FF on the 6809
    this.soundRam = new Uint8Array(0x400);
    this.mux = new Uint8Array(LINES * SPRITE_BYTES);

    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sub = new Konami1({ read: (a) => this.subRead(a), write: (a, v) => this.subWrite(a, v) });
    this.sub.onTaken = (kind) => { if (kind === 'irq') this.sub.irq = false; };
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v), input: (p) => this.soundIn(p), output: (p, v) => this.soundOut(p, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.ay = [0, 1, 2, 3, 4].map((i) => new AY8910(14318180 / 8, (port) => (i === 2 && port === 0 ? TIMER[Math.floor((this.snd.cycles % 10240) / 1024)] : 0xFF), 1));
    // Port B of the first two sets each channel's filter: 0.047 and/or 0.22 uF behind 1K || (2.2K + 200).
    for (const ay of this.ay.slice(0, 2)) {
      ay.portOut = (n, v) => {
        if (n !== 1) return;
        const R = 1000 * 2400 / 3400;
        for (let ch = 0; ch < 3; ch++, v >>= 2) ay.setFilter(ch, R * ((v & 1 ? 0.047e-6 : 0) + (v & 2 ? 0.22e-6 : 0)));
      };
    }
    this.dac = new DAC(0.6);
    this.mcu = new I8035({ rom: roms.mcu, read: () => this.latch2, portOut: (n, v) => { if (n === 1) this.dac.value = v; } });
    this.sound = new SoundMix([...this.ay, this.dac], 0.5);

    this.charPix = decodeTiles(roms.chars, {
      count: 512, width: 8, height: 8, planes: [4, 0], xs: [...run(0, 4), ...run(64, 4)], ys: run(0, 8, 8), size: 128,
    });
    // 8x16 sprites in two interleaved sets (the second starts 16 bytes in).
    const sp = { count: 256, width: 8, height: 16, planes: [0x4000 * 8 + 4, 0x4000 * 8, 4, 0], xs: [...run(0, 4), ...run(64, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512 };
    this.spritePix = [decodeTiles(roms.sprites, sp), decodeTiles(roms.sprites, { ...sp, base: 16 * 8 })];
    const w = (b0, b1, b2) => 0x21 * b0 + 0x47 * b1 + 0x97 * b2;
    this.palette = Uint32Array.from(roms.palette, (d) => rgba(w(d & 1, (d >> 1) & 1, (d >> 2) & 1), w((d >> 3) & 1, (d >> 4) & 1, (d >> 5) & 1), w(0, (d >> 6) & 1, (d >> 7) & 1)));
    this.frame = new Uint32Array(W * H);
    this.native = new Uint32Array(W * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.vram, this.ram, this.shared, this.subRam, this.soundRam, this.mux]) a.fill(0);
    this.nmiOn = 0; this.subIrqOn = 0; this.line = 0; this.latch = 0; this.latch2 = 0;
    this.cycleCarry = this.subCarry = this.soundCarry = this.mcuCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sub.reset(); this.snd.reset(); this.mcu.reset(); this.sound.reset();
  }

  read(a) {
    if (a < 0x6000) return this.roms.main[a];
    if (a >= 0x8000 && a < 0x8800) return this.vram[a - 0x8000];
    if (a >= 0x9000 && a < 0xA000) return this.ram[a - 0x9000];
    if (a >= 0xA000 && a < 0xA800) return this.shared[a - 0xA000];
    switch (a) {
      case 0xC000: return this.dsw1;
      case 0xC080: return this.in0;
      case 0xC0A0: return this.in1;
      case 0xC0C0: return 0xFF;
      case 0xC0E0: return 0xFF;                   // DSW0: 1 coin 1 credit
      case 0xC100: return 0xFE;                   // DSW2: demo music on
    }
    return 0xFF;
  }
  write(a, v) {
    if (a >= 0x8000 && a < 0x8800) this.vram[a - 0x8000] = v;
    else if (a >= 0x9000 && a < 0xA000) this.ram[a - 0x9000] = v;
    else if (a >= 0xA000 && a < 0xA800) this.shared[a - 0xA000] = v;
    else if (a === 0xC080) { this.snd.irqVector = 0xFF; this.snd.irq = true; }
    else if (a === 0xC100) this.latch = v;
    else if (a === 0xC180) this.nmiOn = v & 1;
  }

  subRead(a) {
    if (a >= 0xE000) return this.roms.sub[a - 0xE000];
    if (a >= 0x6000 && a < 0x6800) return this.shared[a - 0x6000];
    if (a >= 0x4000 && a < 0x4800) return this.subRam[a - 0x4000];
    if (a === 0x0000) return this.line;          // the beam's line
    return 0xFF;
  }
  subWrite(a, v) {
    if (a >= 0x6000 && a < 0x6800) this.shared[a - 0x6000] = v;
    else if (a >= 0x4000 && a < 0x4800) this.subRam[a - 0x4000] = v;
    else if (a === 0x2000) this.subIrqOn = v & 1;
  }

  soundRead(a) {
    if (a < 0x6000) return this.roms.sound[a] ?? 0xFF;
    if (a < 0x6400) return this.soundRam[a - 0x6000];
    if (a === 0x8000) return this.latch;
    return 0xFF;
  }
  soundWrite(a, v) { if (a >= 0x6000 && a < 0x6400) this.soundRam[a - 0x6000] = v; }
  // Five AY-3-8910s at 00, 04, 08, 0C, 10 (select, read +1, write +2); the 8039's interrupt at 14 and its data at 18.
  soundIn(p) {
    p &= 0xFF;
    return p < 0x14 && (p & 3) === 1 ? this.ay[p >> 2].read() : 0xFF;
  }
  soundOut(p, v) {
    p &= 0xFF;
    if (p < 0x14) { if ((p & 3) === 0) this.ay[p >> 2].select(v); else if ((p & 3) === 2) this.ay[p >> 2].write(v); }
    else if (p === 0x14) this.mcu.int = true;
    else if (p === 0x18) this.latch2 = v;
  }

  // IN0: coin, starts. IN1: left, right, up, down, fire.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0) | (s.fire ? 0x10 : 0));
  }
  // DSW1: lives, upright, bonus, difficulty, demo sounds on.
  applySwitches(v) { this.dsw1 = v.lives | v.bonus | v.difficulty; }

  runFrame() {
    const main = CPU_CLOCK / REFRESH / LINES, sub = SUB_CLOCK / REFRESH / LINES, snd = SOUND_CLOCK / REFRESH / LINES;
    const mcu = MCU_CLOCK / REFRESH / LINES, samples = RATE / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      this.mux.set(this.subRam.subarray(SPRITES, SPRITES + SPRITE_BYTES), line * SPRITE_BYTES);
      if (line === LINES - 1 && this.subIrqOn) this.sub.irq = true;
      if (line === H + TOP && this.nmiOn) this.cpu.nmi();
      this.cycleCarry += main;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.subCarry += sub;
      this.subCarry -= this.sub.run(Math.floor(this.subCarry));
      this.soundCarry += snd;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      const c0 = this.mcu.cycles;
      this.mcuCarry += mcu; this.mcu.run(Math.floor(this.mcuCarry)); this.mcuCarry -= this.mcu.cycles - c0;
      this.mcu.int = false;                        // the interrupt is a pulse
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    this.render();
  }

  render() {
    const out = this.native, v = this.vram, pal = this.palette, clut = this.roms.charLut, slut = this.roms.spriteLut;
    const front = this.front || (this.front = new Uint8Array(W * H));
    front.fill(0);
    for (let offs = 0; offs < 0x400; offs++) {
      const attr = v[offs], code = v[0x400 + offs] + 8 * (attr & 0x20), color = (attr & 0x0F) * 4;
      const x0 = (offs & 31) * 8, y0 = (offs >> 5) * 8 - TOP, fx = attr & 0x40, fy = attr & 0x80;
      for (let y = 0; y < 8; y++) {
        const py = y0 + y;
        if (py < 0 || py >= H) continue;
        for (let x = 0; x < 8; x++) {
          const pen = this.charPix[code * 64 + (fy ? 7 - y : y) * 8 + (fx ? 7 - x : x)];
          out[py * W + x0 + x] = pal[(clut[color + pen] & 0x0F) + 0x10];
          front[py * W + x0 + x] = attr & 0x10 ? 1 : 0;
        }
      }
    }
    // Sprites per line from the list caught then; earlier entries on top; characters marked "front" cover them.
    for (let y = 0; y < H; y++) {
      const line = y + TOP, list = line * SPRITE_BYTES, m = this.mux, row = y * W;
      for (let offs = SPRITE_BYTES - 4; offs >= 0; offs -= 4) {
        const sy = 241 - m[list + offs + 3];
        if (!(sy > line - 16 && sy <= line)) continue;
        const sx = m[list + offs], b1 = m[list + offs + 1], attr = m[list + offs + 2];
        const pix = this.spritePix[b1 & 1], code = (b1 >> 1) + 4 * (attr & 0x20), color = (attr & 0x0F) * 16;
        const fx = !(attr & 0x40), fy = attr & 0x80, ry = line - sy;
        const src = code * 128 + (fy ? 15 - ry : ry) * 8;
        for (let x = 0; x < 8; x++) {
          const px = sx + x;
          if (px >= W || front[row + px]) continue;
          const pen = pix[src + (fx ? 7 - x : x)];
          if (pen) out[row + px] = pal[slut[color + pen] & 0x0F];
        }
      }
    }
    rotate90(out, W, H, this.frame);
  }
}
Gyruss.id = 'gyruss';
Gyruss.title = 'Gyruss';
Gyruss.switches = [
  { id: 'lives', label: 'Lives', options: [['3', 0x03], ['4', 0x02], ['5', 0x01], ['255 (cheat)', 0x00]], default: 0x03 },
  { id: 'bonus', label: 'Bonus life', options: [['30K, 60K', 0x08], ['40K, 70K', 0x00]], default: 0x08 },
  { id: 'difficulty', label: 'Difficulty', options: [['1 (easiest)', 0x70], ['2', 0x60], ['3', 0x50], ['4', 0x40], ['5 (average)', 0x30], ['6', 0x20], ['7', 0x10], ['8 (hardest)', 0x00]], default: 0x30 },
];
