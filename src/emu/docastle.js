// Universal Mr. Do's Castle (1983): two Z80s at 4 MHz (the main one runs the
// game and video, the second reads the controls and drives four SN76489s),
// a 32x32 layer of 8x8 tiles at 4 bits per pixel, and 16x16 sprites. The
// tiles' top color bit puts a pixel in front of the sprites, which is how
// ladders and floors hide the characters.
//
// The CPUs talk through a 9-byte latch: the main CPU pokes the second one's
// NMI, writes nine bytes, and is held in WAIT until the second CPU has read
// them and written its nine back (inputs and switches). A third CPU on the
// board does nothing the games depend on and isn't run.
//
// 60 Hz; the visible picture is 240x192 on a vertical monitor mounted
// counter-clockwise, as on Mr. Do!.

import { Z80 } from './z80.js';
import { SN76489 } from './sn76489.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, rotate270, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const NATIVE_W = 240, NATIVE_H = 192, LEFT = 8, TOP = 32;
const LINES = 262, LINE_CYCLES = 4000000 / 60 / LINES, VBLANK_LINE = 224, SLICES = 4;
const SAMPLES_PER_LINE = 48000 / 60 / LINES;
const STATE = ['ram', 'vram', 'sprites', 'subRam', 'toSub', 'toMain', 'waiting', 'cycleCarry', 'subCarry', 'sampleCarry',
  'in0', 'in1', 'in2', 'cpu', 'sub', 'sound'];

export class DoCastle {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 32K, sub 16K, chars 16K, sprites 32K, palette 256 }
  constructor(roms) {
    this.width = NATIVE_H;
    this.height = NATIVE_W;
    this.refresh = 60;
    this.controls = 'four-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x1800);         // 8000-97FF
    this.sprites = new Uint8Array(0x200);      // 9800-99FF
    this.vram = new Uint8Array(0x800);         // B000-B3FF codes, B400-B7FF colors
    this.subRam = new Uint8Array(0x800);       // second CPU 8000-87FF
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onIrqAck = () => { this.cpu.irq = false; };
    this.sub = new Z80({ read: (a) => this.subRead(a), write: (a, v) => this.subWrite(a, v) });
    this.sub.onIrqAck = () => { this.sub.irq = false; };
    this.sn = [0, 1, 2, 3].map(() => new SN76489(4000000));
    this.sound = new SoundMix(this.sn, 1.8);

    this.charPix = decodeTiles(roms.chars, {
      count: 512, width: 8, height: 8, planes: [0, 1, 2, 3], xs: run(0, 8, 4), ys: run(0, 8, 32), size: 256,
    });
    this.spritePix = decodeTiles(roms.sprites, {
      count: 256, width: 16, height: 16, planes: [0, 1, 2, 3], xs: run(0, 16, 4), ys: run(0, 16, 64), size: 1024,
    });
    // PROM: red bits 7-5, green 4-2, blue 1-0. A color has 8 entries; the
    // pens' top bit only sets priority (tiles) or see-through (sprites).
    const level = (b0, b1, b2) => 0x23 * b0 + 0x4B * b1 + 0x91 * b2;
    this.palette = Uint32Array.from(roms.palette, (v) =>
      rgba(level((v >> 5) & 1, (v >> 6) & 1, (v >> 7) & 1), level((v >> 2) & 1, (v >> 3) & 1, (v >> 4) & 1), level(0, v & 1, (v >> 1) & 1)));

    this.native = new Uint32Array(NATIVE_W * NATIVE_H);
    this.spriteHere = new Uint8Array(NATIVE_W * NATIVE_H);
    this.frame = new Uint32Array(NATIVE_W * NATIVE_H);
    this.in0 = this.in1 = this.in2 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.sprites.fill(0); this.vram.fill(0); this.subRam.fill(0);
    this.toSub = new Uint8Array(9); this.toMain = new Uint8Array(9);
    this.waiting = false;
    this.cycleCarry = this.subCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sub.reset(); this.sound.reset();
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0x8000) return this.roms.main[a];
    if (a < 0x9800) return this.ram[a - 0x8000];
    if (a < 0x9A00) return this.sprites[a - 0x9800];
    if (a >= 0xA000 && a <= 0xA008) return this.toMain[a - 0xA000];
    if (a >= 0xB000 && a < 0xC000) return this.vram[a & 0x7FF];
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0x9800) this.ram[a - 0x8000] = v;
    else if (a >= 0x9800 && a < 0x9A00) this.sprites[a - 0x9800] = v;
    else if (a >= 0xA000 && a <= 0xA008) {
      this.toSub[a - 0xA000] = v;
      if (a === 0xA008) this.waiting = true;     // held until the second CPU answers
    } else if (a >= 0xB000 && a < 0xC000) this.vram[a & 0x7FF] = v;
    else if (a === 0xE000) this.sub.nmi();
    // A800 watchdog.
  }

  // ---------------------------------------------------------------- second CPU

  subRead(a) {
    if (a < 0x4000) return this.roms.sub[a];
    if (a >= 0x8000 && a < 0x8800) return this.subRam[a - 0x8000];
    if (a >= 0xA000 && a <= 0xA008) return this.toSub[a - 0xA000];
    switch (a & 0xFF7F) {
      case 0xC001: return 0xFF;                  // coinage: 1 coin 1 credit
      case 0xC002: return this.dsw;
      case 0xC003: return this.in0;
      case 0xC004: return a & 0x80 ? 1 : 0;      // flip screen latch
      case 0xC005: return this.in1;
      case 0xC007: return this.in2;
    }
    return 0xFF;
  }

  subWrite(a, v) {
    if (a >= 0x8000 && a < 0x8800) this.subRam[a - 0x8000] = v;
    else if (a >= 0xA000 && a <= 0xA008) {
      this.toMain[a - 0xA000] = v;
      if (a === 0xA008) this.waiting = false;
    } else if (a >= 0xE000 && (a & 0x3FF) === 0) this.sn[(a >> 10) & 3].write(v);
  }

  // ---------------------------------------------------------------- inputs

  // Active low. IN0: right, up, left, down. IN1: fire, (fire), start 1, start 2.
  // IN2: tilt, test, service, freeze, coin 2, coin 1.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.right ? 0x01 : 0) | (s.up ? 0x02 : 0) | (s.left ? 0x04 : 0) | (s.down ? 0x08 : 0));
    this.in1 = 0xFF & ~((s.fire ? 0x03 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x80 : 0));
    this.in2 = 0xFF & ~(s.coin ? 0x20 : 0);
  }
  // Difficulty, rack test off, advance on diamond off, EXTRA difficulty, upright, lives.
  applySwitches(v) { this.dsw = v.difficulty | 0x04 | 0x08 | v.extra | v.lives; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const slice = LINE_CYCLES / SLICES;
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) { this.render(); this.cpu.irq = true; }
      if (line % 33 === 0) this.sub.irq = true;      // eight a frame
      for (let k = 0; k < SLICES; k++) {
        // The main CPU stops dead while it waits on the latch.
        this.cycleCarry += slice;
        const end = this.cpu.cycles + Math.floor(this.cycleCarry);
        this.cycleCarry -= Math.floor(this.cycleCarry);
        while (this.cpu.cycles < end && !this.waiting) this.cpu.step();
        if (this.cpu.cycles < end) this.cpu.cycles = end;
        this.subCarry += slice;
        this.subCarry -= this.sub.run(Math.floor(this.subCarry));
      }
      this.sampleCarry += SAMPLES_PER_LINE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, vram = this.vram, pal = this.palette, here = this.spriteHere;
    const tile = (x, y) => {
      const tx = x + LEFT, ty = y + TOP, i = (ty >> 3) * 32 + (tx >> 3), c = vram[0x400 + i];
      return [this.charPix[(vram[i] + ((c & 0x20) << 3)) * 64 + (ty & 7) * 8 + (tx & 7)], c & 0x1F];
    };
    for (let y = 0; y < NATIVE_H; y++) {
      for (let x = 0; x < NATIVE_W; x++) {
        const [pen, color] = tile(x, y);
        out[y * NATIVE_W + x] = pal[color * 8 + (pen & 7)];
      }
    }

    // Sprites (y, x, flips/color, code), last to first. Pens 8-14 are drawn;
    // pen 15 is a mask that only covers sprites already drawn beneath.
    here.fill(0);
    const spr = this.sprites;
    for (let offs = 0x1FC; offs >= 0; offs -= 4) {
      const code = spr[offs + 3], attr = spr[offs + 2], color = (attr & 0x1F) * 8;
      const flipX = attr & 0x40, flipY = attr & 0x80;
      const sx = ((spr[offs + 1] + 8) & 0xFF) - 8 - LEFT, sy = spr[offs] - TOP;
      for (let pass = 0; pass < 2; pass++) {
        for (let y = 0; y < 16; y++) {
          const py = sy + y;
          if (py < 0 || py >= NATIVE_H) continue;
          const src = code * 256 + (flipY ? 15 - y : y) * 16;
          for (let x = 0; x < 16; x++) {
            const px = sx + x;
            if (px < 0 || px >= NATIVE_W) continue;
            const pen = this.spritePix[src + (flipX ? 15 - x : x)], o = py * NATIVE_W + px;
            if (pass === 0 ? pen >= 8 && pen < 15 : pen === 15 && here[o]) { out[o] = pal[color + (pen & 7)]; here[o] = 1; }
          }
        }
      }
    }

    // Tile pixels with the top pen bit go in front.
    for (let y = 0; y < NATIVE_H; y++) {
      for (let x = 0; x < NATIVE_W; x++) {
        const [pen, color] = tile(x, y);
        if (pen & 8) out[y * NATIVE_W + x] = pal[color * 8 + (pen & 7)];
      }
    }

    rotate270(out, NATIVE_W, NATIVE_H, this.frame);
  }
}

DoCastle.id = 'docastle';
DoCastle.title = "Mr. Do's Castle";
DoCastle.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x00], ['3', 0xC0], ['4', 0x80], ['5', 0x40]], default: 0xC0 },
  { id: 'difficulty', label: 'Difficulty', options: [['1', 0x03], ['2', 0x02], ['3', 0x01], ['4', 0x00]], default: 0x03 },
  { id: 'extra', label: 'EXTRA', options: [['Easy', 0x10], ['Hard', 0x00]], default: 0x10 },
];
