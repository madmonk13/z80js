// Irem Moon Patrol (1982), on Irem's M52 board: a Z80 at 3.072 MHz, a layer
// of 8x8 characters (the bottom quarter scrolls sideways with the ground),
// 16x16 sprites, and three parallax backgrounds (mountains, hills, city),
// each a 256x64 picture in ROM that the program positions and that's filled
// with its own color below. The sound board is Irem's standard one: a
// Motorola 6803 driving two AY-3-8910s through its ports, and two MSM5205
// ADPCM chips (clocked by the first, whose clock also interrupts the 6803 to
// feed them). Moon Patrol's own program keeps the MSM5205s in reset; later
// Irem games on the board use them for speech. Its few analog effects
// (driven from the second AY's port A) aren't reproduced.
//
// 56.75 Hz; the visible picture is 240x248 on a horizontal monitor.

import { Z80 } from './z80.js';
import { M6803 } from './m6803.js';
import { AY8910 } from './ay8910.js';
import { MSM5205 } from './msm5205.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 240, H = 248, LEFT = 8, TOP = 8;
const REFRESH = 56.75, LINES = 284, VBLANK_LINE = 256;
const LINE_CYCLES = 3072000 / REFRESH / LINES;
const SOUND_CLOCK = 3579545 / 4, SOUND_PER_SAMPLE = SOUND_CLOCK / 48000;
const SAMPLES_PER_LINE = 48000 / REFRESH / LINES;
const MSM_PRESCALE = [96, 48, 64, 0];           // 0: slave, clocked by the other chip
const STATE = ['ram', 'vram', 'sprites', 'scroll', 'bg', 'latch', 'port1', 'port2', 'msmMode', 'msmPhase',
  'cycleCarry', 'soundCarry', 'sampleCarry', 'in0', 'in1', 'cpu', 'snd', 'msm', 'sound'];

// Resistor weights (1K/470/220): red bits 0-2, green 3-5, blue 6-7 for the
// character and background PROMs; the sprite PROM has red and blue swapped.
const w3 = (v, a, b, c) => 0x21 * ((v >> a) & 1) + 0x47 * ((v >> b) & 1) + 0x97 * ((v >> c) & 1);
const charColor = (v) => rgba(w3(v, 0, 1, 2), w3(v, 3, 4, 5), 0x47 * ((v >> 6) & 1) + 0x97 * ((v >> 7) & 1));
const spriteColor = (v) => rgba(0x47 * ((v >> 6) & 1) + 0x97 * ((v >> 7) & 1), w3(v, 3, 4, 5), w3(v, 0, 1, 2));

export class MoonPatrol {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 16K, sound 4K, chars 8K, sprites 8K, mountains/hills/city 4K each,
  //         charPal 256, bgPal 32, spritePal 32, spriteLut 256 }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'two-way';
    this.buttons = 2;
    this.button2 = 'Jump';
    this.roms = roms;
    this.ram = new Uint8Array(0x800);          // E000-E7FF
    this.vram = new Uint8Array(0x800);         // 8000-83FF codes, 8400-87FF colors
    this.sprites = new Uint8Array(0x100);      // C800-C8FF

    this.cpu = new Z80({
      read: (a) => this.read(a), write: (a, v) => this.write(a, v),
      output: (p, v) => this.output(p & 0xFF, v),
    });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };

    this.ay = [
      new AY8910(SOUND_CLOCK, (port) => (port === 0 ? this.latch : 0xFF), 1),
      new AY8910(SOUND_CLOCK, () => 0xFF, 1),
    ];
    this.ay[0].portOut = (port, v) => { if (port === 1) this.msmControl(v); };
    this.msm = [new MSM5205(1.2), new MSM5205(1.2)];
    this.sound = new SoundMix([...this.ay, ...this.msm], 0.45);
    this.snd = new M6803({
      read: (a) => (a >= 0x4000 ? roms.sound[a & 0xFFF] : 0xFF),
      write: (a, v) => { if (a === 0x0801 || a === 0x0802) this.msm[a - 0x0801].data(v); },
      portIn: (n) => (n === 1 ? this.port1In() : 0),
      portOut: (n, v) => this.portWrite(n, v),
    });

    this.charPix = decodeTiles(roms.chars, { count: 512, width: 8, height: 8, planes: [0, 512 * 64], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    this.spritePix = decodeTiles(roms.sprites, {
      count: 128, width: 16, height: 16, planes: [0, 128 * 256], xs: [...run(0, 8), ...run(128, 8)], ys: run(0, 16, 8), size: 256,
    });
    // Backgrounds: one 256x64 picture each, 2 bits per pixel packed four
    // pixels to a byte; the bottom 32 rows follow the top 32 at 4000 bits.
    const bgLayout = {
      count: 1, width: 256, height: 64, planes: [4, 0],
      xs: Array.from({ length: 256 }, (_, x) => 8 * (x >> 2) + (x & 3)),
      ys: Array.from({ length: 64 }, (_, y) => (y < 32 ? 0 : 0x4000) + 0x200 * (y & 31)), size: 0,
    };
    this.bgPix = [roms.mountains, roms.hills, roms.city].map((r) => decodeTiles(r, bgLayout));

    this.charPal = Uint32Array.from(roms.charPal, charColor);
    const bgPal = Uint32Array.from(roms.bgPal, charColor);
    // Each background picks its four colors from the shared PROM differently.
    this.bgColors = [[0, 4, 8, 12], [0, 1, 2, 3], [0, 17, 18, 19]].map((idx) => idx.map((i) => bgPal[i]));
    const spritePal = Uint32Array.from(roms.spritePal, spriteColor);
    // Sprite color c, pen p: half of the lookup PROM is unused. Entry 0 is see-through.
    this.spriteLut = Uint8Array.from({ length: 128 }, (_, i) => roms.spriteLut[(i >> 2) * 8 + (i & 3)] & 0x1F);
    this.spritePal = spritePal;

    this.frame = new Uint32Array(W * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.sprites.fill(0);
    this.scroll = 0;
    this.bg = { x1: 0, y1: 0, x2: 0, y2: 0, control: 0 };
    this.latch = 0; this.port1 = 0; this.port2 = 0;
    this.msmMode = 0; this.msmPhase = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
    this.msm.forEach((m) => m.reset());
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x4000) return this.roms.main[a];
    if (a >= 0x8000 && a < 0x8800) return this.vram[a - 0x8000];
    if (a >= 0xE000 && a < 0xE800) return this.ram[a - 0xE000];
    switch (a) {
      case 0x8800: return this.cpu.e;          // protection: answers with the E register
      case 0xD000: return this.in0;
      case 0xD001: return this.in1;
      case 0xD002: return 0xFF;
      case 0xD003: return this.dsw1;
      case 0xD004: return this.dsw2;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0x8800) this.vram[a - 0x8000] = v;
    else if (a >= 0xE000 && a < 0xE800) this.ram[a - 0xE000] = v;
    else if (a >= 0xC800 && a < 0xC900) this.sprites[a - 0xC800] = v;
    else if (a === 0xD000) {
      // Sound command: bit 7 clear latches it; set, it interrupts the sound CPU.
      if (v & 0x80) this.snd.irq = true; else this.latch = v & 0x7F;
    }
    // D001 flip screen and coin counters.
  }

  output(p, v) {
    if (p >= 0x10 && p < 0x20) this.scroll = v;
    else switch (p) {
      case 0x40: this.bg.x1 = v; break;
      case 0x60: this.bg.y1 = v; break;
      case 0x80: this.bg.x2 = v; break;
      case 0xA0: this.bg.y2 = v; break;
      case 0xC0: this.bg.control = v; break;
    }
  }

  // ---------------------------------------------------------------- sound board

  // Port 2's bit 0 strobes port 1 into an AY: bit 2 picks register select or
  // data, bits 3 and 4 which chip.
  portWrite(n, v) {
    if (n === 1) { this.port1 = v; return; }
    if ((this.port2 & 1) && !(v & 1)) {
      for (const [bit, chip] of [[0x08, this.ay[0]], [0x10, this.ay[1]]]) {
        if (!(this.port2 & bit)) continue;
        if (this.port2 & 4) chip.select(this.port1); else chip.write(this.port1);
      }
    }
    this.port2 = v;
  }
  port1In() {
    if (this.port2 & 0x08) return this.ay[0].read();
    if (this.port2 & 0x10) return this.ay[1].read();
    return 0xFF;
  }
  // AY 0's port B: the MSM5205s' clock rate and 3/4-bit mode, and their resets.
  msmControl(v) {
    this.msmMode = (v >> 2) & 7;
    this.msm[0].bits = this.msm[1].bits = this.msmMode & 4 ? 4 : 3;
    this.msm[0].hold(v & 1);
    this.msm[1].hold(v & 2);
  }

  // ---------------------------------------------------------------- inputs

  // Active low. IN0: start 1, start 2, coin. IN1: right, left, jump, fire.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.start1 ? 0x01 : 0) | (s.start2 ? 0x02 : 0) | (s.coin ? 0x08 : 0));
    this.in1 = 0xFF & ~((s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.fire2 || s.up ? 0x20 : 0) | (s.fire ? 0x80 : 0));
  }
  // DSW1: lives, bonus, and 1 coin 1 credit (coin mode 1). DSW2: upright, coin mode 1, cheats and test off.
  applySwitches(v) {
    this.dsw1 = 0xF0 | v.lives | v.bonus;
    this.dsw2 = 0xFD;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) { this.render(); this.cpu.irq = true; }
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      // The sound board, a sample at a time; the first MSM5205's clock
      // interrupts the 6803 and clocks the second chip.
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) {
        this.sampleCarry -= 1;
        this.soundCarry += SOUND_PER_SAMPLE;
        const before = this.snd.cycles;
        this.snd.run(Math.floor(this.soundCarry));
        this.soundCarry -= this.snd.cycles - before;
        const pre = MSM_PRESCALE[this.msmMode & 3];
        if (pre) {
          this.msmPhase += 384000 / pre / 48000;
          while (this.msmPhase >= 1) {
            this.msmPhase -= 1;
            this.msm[0].clock(); this.msm[1].clock();
            this.snd.nmi();
          }
        }
        this.sound.sample();
      }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, bg = this.bg;
    out.fill(rgba(0, 0, 0));
    // Backgrounds, far to near, each repeated sideways and filled with its
    // fourth color for 64 lines below.
    const layer = (pix, colors, xpos, ypos) => {
      for (let y = 0; y < 128; y++) {
        const py = ypos + y - TOP;
        if (py < 0 || py >= H) continue;
        for (let x = 0; x < W; x++) {
          let c;
          if (y < 64) {
            const pen = pix[y * 256 + ((x + LEFT - xpos) & 0xFF)];
            if (!pen) continue;
            c = colors[pen];
          } else c = colors[3];
          out[py * W + x] = c;
        }
      }
    };
    if (!(bg.control & 0x20)) {
      if (!(bg.control & 0x10)) layer(this.bgPix[0], this.bgColors[0], bg.x2, bg.y2);   // mountains
      if (!(bg.control & 0x02)) layer(this.bgPix[1], this.bgColors[1], bg.x1, bg.y1);   // hills
      if (!(bg.control & 0x04)) layer(this.bgPix[2], this.bgColors[2], bg.x1, bg.y1);   // city
    }

    // Characters: the top 7 rows (the status area) are solid; the rest
    // see-through at pen 0. The bottom 64 lines scroll with the ground.
    const vram = this.vram;
    for (let y = 0; y < H; y++) {
      const ty = y + TOP, row = ty >> 3;
      const sx = ty >= 192 ? -this.scroll : 255;
      for (let x = 0; x < W; x++) {
        const tx = (x + LEFT + sx) & 0xFF;
        const i = row * 32 + (tx >> 3), c = vram[0x400 + i];
        const pen = this.charPix[(vram[i] | ((c & 0x80) << 1)) * 64 + (ty & 7) * 8 + (tx & 7)];
        if (pen || row <= 6) out[y * W + x] = this.charPal[((c & 0x3F) * 4 + pen) & 0xFF];
      }
    }

    // Sprites, last to first; only slots with address bits 5-6 set are used.
    const spr = this.sprites;
    for (let offs = 0xFC; offs >= 0; offs -= 4) {
      if (!(offs & 0x60)) continue;
      const attr = spr[offs + 1], src = (spr[offs + 2] & 0x7F) * 256, color = (attr & 0x1F) * 4;
      const flipX = attr & 0x40, flipY = attr & 0x80;
      const sx = spr[offs + 3] - LEFT, sy = 241 - spr[offs] - TOP;
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        const row = src + (flipY ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= W) continue;
          const entry = this.spriteLut[color + this.spritePix[row + (flipX ? 15 - x : x)]];
          if (entry) out[py * W + px] = this.spritePal[entry];
        }
      }
    }
  }
}

MoonPatrol.id = 'mpatrol';
MoonPatrol.title = 'Moon Patrol';
MoonPatrol.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x00], ['2', 0x01], ['3', 0x02], ['5', 0x03]], default: 0x02 },
  { id: 'bonus', label: 'Bonus', options: [['10K/30K/50K', 0x0C], ['20K/40K/60K', 0x08], ['10K', 0x04], ['None', 0x00]], default: 0x0C },
];
