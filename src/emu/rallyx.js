// Namco Rally-X (1980): one Z80, Namco's waveform sound, a scrolling 32x32
// playfield on the left 224 pixels and the radar panel (an 8x32 tile layer)
// on the right 64, six 16x16 sprites (the cars), and the radar dots. Tiles
// whose attribute has bit 5 set sit in front of the sprites. The design
// Bosconian's video grew out of.
//
// 264 lines of 192 cycles (60.6 Hz); the picture is 288x224, horizontal.

import { Z80 } from './z80.js';
import { WSG } from './wsg.js';
import { decodeTiles, promPalette, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 288, H = 224;
const LINES = 264, LINE_CYCLES = 192, VBLANK_LINE = 224;
const STATE = ['ram', 'work', 'radarAttr', 'scroll', 'irqEnable', 'bang', 'explosion', 'in0', 'in1', 'cpu', 'wsg'];

export class RallyX {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 16K, gfx 4K, dots 256, palette 32, lut 256, wave 256 }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = 60.606;
    this.controls = 'four-way';
    this.buttons = 1;                            // smoke screen
    this.roms = roms;
    this.ram = new Uint8Array(0x1000);          // 8000-8FFF: radar/playfield codes and attributes, sprite registers
    this.work = new Uint8Array(0x800);          // 9800-9FFF
    this.radarAttr = new Uint8Array(16);
    this.wsg = new WSG(roms.wave);
    this.sound = this.wsg;
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v), output: (p, v) => this.out(p & 0xFF, v) });
    this.frame = new Uint32Array(W * H);
    this.front = new Uint8Array(W * H);

    this.charPix = decodeTiles(roms.gfx, {
      count: 256, width: 8, height: 8, planes: [0, 4], xs: [64, 65, 66, 67, 0, 1, 2, 3], ys: run(0, 8, 8), size: 128,
    });
    this.spritePix = decodeTiles(roms.gfx, {
      count: 64, width: 16, height: 16, planes: [0, 4],
      xs: [...run(64, 4), ...run(128, 4), ...run(192, 4), ...run(0, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    // Radar dots: eight 4x4 shapes, 2 bits a pixel (3 = see-through).
    this.dotPix = decodeTiles(roms.dots, { count: 8, width: 4, height: 4, planes: [6, 7], xs: run(0, 4, 8), ys: run(0, 4, 32), size: 128 });
    this.palette = promPalette(roms.palette, 32, [0x47, 0x97]);
    this.lut = Uint8Array.from(roms.lut, (v) => v & 0x0F);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.work.fill(0); this.radarAttr.fill(0);
    this.cpu.reset();
    this.wsg.reset();
    this.wsg.enabled = true;
    this.scroll = [0, 0];
    this.irqEnable = false;
    this.bang = 0;
    this.explosion = 0;
  }

  // ---------------------------------------------------------------- bus

  read(a) {
    if (a < 0x4000) return this.roms.main[a];
    if (a >= 0x8000 && a < 0x9000) return this.ram[a - 0x8000];
    if (a >= 0x9800 && a < 0xA000) return this.work[a - 0x9800];
    if (a === 0xA000) return this.in0;
    if (a === 0xA080) return this.in1;
    if (a === 0xA100) return this.dsw;
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x8000 && a < 0x9000) { this.ram[a - 0x8000] = v; return; }
    if (a >= 0x9800 && a < 0xA000) { this.work[a - 0x9800] = v; return; }
    if (a >= 0xA000 && a < 0xA010) { this.radarAttr[a & 0x0F] = v; return; }
    if (a >= 0xA100 && a < 0xA120) { this.wsg.write(a & 0x1F, v); return; }
    if (a === 0xA130) { this.scroll[0] = v; return; }
    if (a === 0xA140) { this.scroll[1] = v; return; }
    if (a >= 0xA180 && a < 0xA188) {
      const bit = v & 1;
      switch (a & 7) {
        case 0:                                   // BANG: the crash sound, on the falling edge
          if (!bit && this.bang) this.explosion = 20;
          this.bang = bit;
          break;
        case 1: this.irqEnable = !!bit; if (!bit) this.cpu.irq = false; break;
        // 2 sound enable (unused), 3 flip screen, 4-5 lamps, 6 coin lockout, 7 coin counter
      }
    }
  }

  // OUT (0) sets the interrupt vector and acknowledges the interrupt.
  out(port, v) { if (port === 0) { this.cpu.irqVector = v; this.cpu.irq = false; } }

  // ---------------------------------------------------------------- inputs

  // IN0: smoke, left, right, down, up, start 1, coin. IN1: upright, start 2.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.fire ? 0x02 : 0) | (s.left ? 0x04 : 0) | (s.right ? 0x08 : 0) | (s.down ? 0x10 : 0)
      | (s.up ? 0x20 : 0) | (s.start1 ? 0x40 : 0) | (s.coin ? 0x80 : 0));
    this.in1 = 0xFF & ~(s.start2 ? 0x40 : 0);
  }

  // 1 coin 1 credit, cars and difficulty, bonus, service switch off.
  applySwitches(v) { this.dsw = 0xC0 | v.cars | v.bonus | 0x01; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) {
        if (this.irqEnable) this.cpu.irq = true;     // held until the program acknowledges it
        this.render();
      }
      this.cpu.run(LINE_CYCLES);
      this.wsg.line(this.explosion > 0);
    }
    if (this.explosion > 0) this.explosion--;
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, front = this.front, ram = this.ram, pal = this.palette, lut = this.lut;
    front.fill(0);
    // Tiles: playfield (codes 8400, attributes 8C00) scrolled into x 0-223,
    // the radar panel (codes 8000, attributes 8800) at x 224-287.
    for (let y = 0; y < H; y++) {
      const ry = y + 16;
      for (let x = 0; x < W; x++) {
        let i, tx, ty;
        if (x < 224) {
          tx = (x + this.scroll[0] - 3) & 0xFF; ty = (ry + this.scroll[1]) & 0xFF;
          i = 0x400 + (ty >> 3) * 32 + (tx >> 3);
        } else {
          tx = x & 63; ty = ry;
          i = (ty >> 3) * 32 + (tx >> 3);
        }
        const attr = ram[0x800 + i];
        const fx = attr & 0x40 ? tx & 7 : 7 - (tx & 7), fy = attr & 0x80 ? 7 - (ty & 7) : ty & 7;
        const o = y * W + x;
        out[o] = pal[lut[(attr & 0x3F) * 4 + this.charPix[ram[i] * 64 + fy * 8 + fx]]];
        if (attr & 0x20) front[o] = 1;
      }
    }

    // Sprites: registers at 8014-801F and 8814-881F; color 0 is see-through.
    for (let offs = 0x1E; offs >= 0x14; offs -= 2) {
      const a = ram[offs], b = ram[offs + 1], c = ram[0x800 + offs], d = ram[0x801 + offs];
      const sx = b + ((d & 0x80) << 1) - 1, sy = 241 - c - 1 - 16, color = (d & 0x3F) * 4;
      const flipX = a & 1, flipY = a & 2, src = (a >> 2) * 256;
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= H) continue;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= W) continue;
          const v = lut[color + this.spritePix[src + (flipY ? 15 - y : y) * 16 + (flipX ? 15 - x : x)]];
          if (v && !front[py * W + px]) out[py * W + px] = pal[v];
        }
      }
    }

    // Radar dots: positions at 8034-803F / 8834-883F, shapes and the x high
    // bit in the attribute latches. Colors 16-19.
    for (let offs = 0x14; offs < 0x20; offs++) {
      const attr = this.radarAttr[offs & 0x0F];
      const x = ram[0x20 + offs] + ((~attr & 1) << 8), y = 253 - ram[0x820 + offs] - 16;
      const shape = ((attr & 0x0E) >> 1) ^ 7;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        const pen = this.dotPix[shape * 16 + dy * 4 + dx], px = x + dx, py = y + dy;
        if (pen === 3 || px >= W || py < 0 || py >= H) continue;
        out[py * W + px] = pal[16 + pen];
      }
    }
  }
}

RallyX.id = 'rallyx';
RallyX.title = 'Rally-X';
RallyX.switches = [
  { id: 'cars', label: 'Cars', options: [['3, easy', 0x08], ['3, medium', 0x20], ['3, hard', 0x38], ['2, easy', 0x00], ['2, medium', 0x18], ['1, medium', 0x10]], default: 0x08 },
  { id: 'bonus', label: 'Bonus', options: [['Low', 0x02], ['Medium', 0x04], ['High', 0x06], ['None', 0x00]], default: 0x02 },
];
