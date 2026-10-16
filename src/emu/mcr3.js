// Bally Midway MCR-III (1983-87): the same Z80 + CTC core and 32x32 sprites as
// the MCR boards in mcr.js, in two variants:
//
//   Monoboard (Sarge, Rampage): one board with the CPU and video, a 32x30
//     background of 16x16 tiles (8x8 shown at double size), and an external
//     sound board on an output port: the Turbo Chip Squeak (Sarge: a 6809
//     driving a 10-bit DAC) or Sounds Good (Rampage: a 68000 and DAC).
//   Scrolling (Spy Hunter, Crater Raider): a scrolling background of 64x32
//     tiles (32x16 shown at double size) over a 4096x1024 field, a fixed text
//     layer on top, the Super Sound I/O board (two AY-3-8910s) and, on Spy
//     Hunter, a Chip Squeak Deluxe (68000 and DAC) as well.
//
// The sound boards each take a command a nibble at a time through a 6821
// PIA's port B, strobed on CA1, and play through a 10-bit DAC on ports A and B.

import { MCR } from './mcr.js';
import { M6809 } from './m6809.js';
import { M68000 } from './m68000.js';
import { PIA6821 } from './pia6821.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { capture, apply } from './state.js';

const W = 512, H = 480;
const SLICES = 256;
const SAMPLES_PER_SLICE = 48000 / 60 / SLICES;

// A 10-bit DAC fed from a PIA: the top eight bits from port A, the low two from port B's top bits.
class DAC10 {
  constructor(gain) { this.gain = gain; this.reset(); }
  reset() { this.value = 512; this.out = 0; }
  saveState() { return { value: this.value }; }
  loadState(s) { this.value = s.value; }
  sample() { this.out = (this.value - 512) / 512 * this.gain; }
}

// The PIA's registers as these boards wire them: address bit 0 to RS1, bit 1 to RS0.
const alt = (o) => ((o << 1) & 2) | ((o >> 1) & 1);

// ---------------------------------------------------------------- sound boards

// The Turbo Chip Squeak (Sarge): a 6809 at 2 MHz, 2K of RAM, a PIA, ROM at 8000-FFFF.
class TurboChipSqueak {
  constructor(rom) {
    this.rom = rom;
    this.ram = new Uint8Array(0x800);
    this.dac = new DAC10(0.9);
    this.pia = new PIA6821({
      outA: (v) => { this.dac.value = (this.dac.value & 3) | (v << 2); },
      outB: (v) => { this.dac.value = (this.dac.value & 0x3FC) | (v >> 6); this.status = (v >> 4) & 3; },
      inB: () => this.nibble,
      irqA: () => this.updateIrq(), irqB: () => this.updateIrq(),
    });
    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.clock = 2000000;
    this.reset();
  }
  reset() { this.ram.fill(0); this.pia.reset(); this.cpu.reset(); this.status = 0; this.held = false; this.nibble = 0; }
  updateIrq() { this.cpu.irq = this.pia.irqA() || this.pia.irqB(); }
  read(a) {
    if (a < 0x4000) return this.ram[a & 0x7FF];
    if (a < 0x8000) return this.pia.read(alt(a & 3));
    return this.rom[(a - 0x10000 + this.rom.length) & (this.rom.length - 1)] ?? 0xFF;
  }
  write(a, v) {
    if (a < 0x4000) this.ram[a & 0x7FF] = v;
    else if (a < 0x8000) this.pia.write(alt(a & 3), v);
  }
  // A command from the main board: bits 1-4 the nibble, bit 0 the strobe (active low).
  command(v) { this.nibble = (v >> 1) & 0x0F; this.pia.setC1('A', ~v & 1); }
  run(n) { return this.held ? n : this.cpu.run(n); }
  saveState() { return { ram: this.ram.slice(), pia: this.pia.saveState(), cpu: this.cpu.saveState(), dac: this.dac.saveState(), status: this.status, held: this.held, nibble: this.nibble }; }
  loadState(s) { this.ram.set(s.ram); this.pia.loadState(s.pia); this.cpu.loadState(s.cpu); this.dac.loadState(s.dac); this.status = s.status; this.held = s.held; this.nibble = s.nibble; }
}

// Sounds Good (Rampage) and the Chip Squeak Deluxe (Spy Hunter): a 68000 with
// ROM, a little RAM and the PIA (on the high byte of the bus).
class SixtyEightKSqueak {
  // map: { romEnd, pia, ram, mask }; strobe: how the main board's byte splits into nibble and strobe.
  constructor(rom, { pia, ram, ramSize, mask, csd }) {
    this.rom = rom;
    this.map = { pia, ram, mask };
    this.csd = csd;
    this.ram = new Uint8Array(ramSize);
    this.dac = new DAC10(0.9);
    this.pia = new PIA6821({
      outA: (v) => { this.dac.value = (this.dac.value & 3) | (v << 2); },
      outB: (v) => {
        this.dac.value = (this.dac.value & 0x3FC) | (v >> 6);
        const z = ~this.pia.ddrB;
        if (~z & 0x10) this.status = (this.status & ~1) | ((v >> 4) & 1);
        if (~z & 0x20) this.status = (this.status & ~2) | ((v >> 4) & 2);
      },
      inB: () => this.nibble,
      irqA: () => this.updateIrq(), irqB: () => this.updateIrq(),
    });
    this.cpu = new M68000({
      read8: (a) => this.read8(a), read16: (a) => (this.read8(a) << 8) | this.read8(a + 1),
      write8: (a, v) => this.write8(a, v), write16: (a, v) => { this.write8(a, v >> 8); this.write8(a + 1, v & 0xFF); },
    });
    this.clock = 8000000;
    this.reset();
  }
  reset() { this.ram.fill(0); this.pia.reset(); this.cpu.reset(); this.status = 0; this.held = false; this.nibble = 0; }
  updateIrq() { this.cpu.irq = this.pia.irqA() || this.pia.irqB() ? 4 : 0; }
  read8(a) {
    a &= this.map.mask;
    if (a < this.rom.length) return this.rom[a];
    if (a >= this.map.pia && a < this.map.pia + 8) return a & 1 ? 0xFF : this.pia.read(alt((a - this.map.pia) >> 1));
    if (a >= this.map.ram && a < this.map.ram + this.ram.length) return this.ram[a - this.map.ram];
    return 0xFF;
  }
  write8(a, v) {
    a &= this.map.mask;
    if (a >= this.map.pia && a < this.map.pia + 8) { if (!(a & 1)) this.pia.write(alt((a - this.map.pia) >> 1), v); }
    else if (a >= this.map.ram && a < this.map.ram + this.ram.length) this.ram[a - this.map.ram] = v;
  }
  // Sounds Good: bits 1-4 the nibble, bit 0 the strobe. Chip Squeak Deluxe: bits 0-3, bit 4.
  command(v) {
    if (this.csd) { this.nibble = v & 0x0F; this.pia.setC1('A', ~v & 0x10); }
    else { this.nibble = (v >> 1) & 0x0F; this.pia.setC1('A', ~v & 1); }
  }
  setReset(on) {
    if (on && !this.held) this.cpu.reset();
    this.held = on;
  }
  run(n) { return this.held ? n : this.cpu.run(n); }
  saveState() { return { ram: this.ram.slice(), pia: this.pia.saveState(), cpu: this.cpu.saveState(), dac: this.dac.saveState(), status: this.status, held: this.held, nibble: this.nibble }; }
  loadState(s) { this.ram.set(s.ram); this.pia.loadState(s.pia); this.cpu.loadState(s.cpu); this.dac.loadState(s.dac); this.status = s.status; this.held = s.held; this.nibble = s.nibble; }
}

// ---------------------------------------------------------------- the board

// (Spy Hunter's wheel, pedal, gear and coin pulses ride along; undefined on the others.)
const MCR3_STATE = ['extraRam', 'alphaRam', 'scrollX', 'scrollY', 'lamps', 'mux', 'squeakCarry',
  'wheel', 'pedal', 'gear', 'coinQueue', 'coinPhase', 'coinWas'];

export class MCR3 extends MCR {
  // roms: { main, bg, fg, sound (SSIO, scrolling games), prom (SSIO), squeak (sound board), alpha (scrolling games) }
  constructor(roms) {
    super(roms);
    const cfg = this.cfg;
    this.extraRam = new Uint8Array(0x200);
    this.alphaRam = new Uint8Array(0x400);
    this.scrollX = 0; this.scrollY = 0;
    this.lamps = 0;
    this.mux = 0;
    if (cfg.scroll) {
      // Background: 32x16 source tiles (2+2 bitplanes in two ROM halves), shown at double size.
      const half = roms.bg.length * 4;
      this.bgPix = decodeTiles(roms.bg, { count: roms.bg.length / 256, width: 32, height: 16, planes: [half, half + 1, 0, 1], xs: run(0, 32, 2), ys: run(0, 16, 64), size: 1024 });
      this.alphaPix = decodeTiles(roms.alpha, { count: roms.alpha.length / 16, width: 8, height: 8, planes: [0, 1], xs: run(0, 8, 2), ys: run(0, 8, 16), size: 128 });
      this.alphaCount = roms.alpha.length / 16;
      this.native = new Uint32Array(480 * 480);
      this.nativeW = 480;
      this.pri = new Uint8Array(480 * 480);
    } else {
      this.nativeW = W;
    }
    this.width = cfg.rotate ? (cfg.scroll ? 480 : H) : this.nativeW;
    this.height = cfg.rotate ? this.nativeW : (cfg.scroll ? 480 : H);
    this.frame = cfg.rotate || cfg.flipX ? new Uint32Array(this.width * this.height) : this.native;
    // The external sound board.
    if (cfg.squeak === 'tcs') this.squeak = new TurboChipSqueak(roms.squeak);
    else if (cfg.squeak === 'sg') this.squeak = new SixtyEightKSqueak(roms.squeak, { pia: 0x60000, ram: 0x70000, ramSize: 0x1000, mask: 0x7FFFF });
    else if (cfg.squeak === 'csd') this.squeak = new SixtyEightKSqueak(roms.squeak, { pia: 0x18000, ram: 0x1C000, ramSize: 0x1000, mask: 0x1FFFF, csd: true });
    const chips = [];
    if (cfg.ssio) chips.push(...this.ay);
    if (this.squeak) chips.push(this.squeak.dac);
    this.sound = new SoundMix(chips, cfg.gain || 1);
    if (this.squeak) this.squeak.reset();
    this.squeakCarry = 0;
  }

  saveState() {
    return { ...super.saveState(), mcr3: capture(this, MCR3_STATE), squeak: this.squeak?.saveState() };
  }
  loadState(s) {
    super.loadState(s);
    apply(this, MCR3_STATE, s.mcr3);
    if (this.squeak && s.squeak) this.squeak.loadState(s.squeak);
  }

  reset() {
    super.reset();
    this.ram.fill(0);                               // the battery-backed RAM starts zeroed (its settings then default)
    this.extraRam?.fill(0); this.alphaRam?.fill(0);
    this.scrollX = 0; this.scrollY = 0;
    if (this.squeak) this.squeak.reset();
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0xE000) return this.roms.main[a] ?? 0xFF;
    if (this.cfg.scroll) {
      if (a < 0xE800) return this.vram[a & 0x7FF];
      if (a < 0xF000) return this.alphaRam[a & 0x3FF];
      if (a < 0xF800) return this.ram[a & 0x7FF];
      if (a < 0xFA00) return this.spriteRam[a & 0x1FF];
      return 0xFF;
    }
    if (a < 0xE800) return this.ram[a & 0x7FF];
    if (a < 0xEA00) return this.spriteRam[a & 0x1FF];
    if (a < 0xEC00) return this.extraRam[a & 0x1FF];
    if (a < 0xF000) return 0xFF;
    if (a < 0xF800) return this.vram[a & 0x7FF];
    return this.roms.main[a] ?? 0xFF;
  }

  write(a, v) {
    if (a < 0xE000) return;
    if (this.cfg.scroll) {
      if (a < 0xE800) this.vram[a & 0x7FF] = v;
      else if (a < 0xF000) this.alphaRam[a & 0x3FF] = v;
      else if (a < 0xF800) this.ram[a & 0x7FF] = v;
      else if (a < 0xFA00) this.spriteRam[a & 0x1FF] = v;
      else if (a < 0xFC00) this.setColor((a & 0x7F) >> 1, v | ((a & 1) << 8));
      return;
    }
    if (a < 0xE800) this.ram[a & 0x7FF] = v;
    else if (a < 0xEA00) this.spriteRam[a & 0x1FF] = v;
    else if (a < 0xEC00) this.extraRam[a & 0x1FF] = v;
    else if (a < 0xF000) this.setColor((a & 0x7F) >> 1, v | ((a & 1) << 8));
    else if (a < 0xF800) this.vram[a & 0x7FF] = v;
  }

  // Monoboard I/O: inputs at 00-04 (mirrored), 05 control, 06 the sound board,
  // 07 watchdog, F0-FF the CTC. Scrolling board: the SSIO's ports, scroll
  // registers at 84-86 and the CTC.
  input(p) {
    if (p >= 0xF0) return this.ctc.read(p & 3);
    if (this.cfg.scroll) return super.input(p);
    if (p < 0x80) {
      const n = p & 7;
      if (n <= 4) return this.inputPort(n);
    }
    return 0xFF;
  }

  output(p, v) {
    if (p >= 0xF0) { this.ctc.write(p & 3, v); this.cpu.irq = this.ctc.irq(); return; }
    if (this.cfg.scroll) {
      if (p >= 0x84 && p <= 0x86) this.setScroll(p - 0x84, v);
      else if (p >= 4 && p <= 7) this.op4(v);                 // the SSIO's output port 4 (0x1C-0x1F are its command latches)
      else super.output(p, v);
      return;
    }
    if (p < 0x80 && (p & 7) === 6) this.op6(v);
  }

  setScroll(n, v) {
    if (n === 0) this.scrollX = (this.scrollX & ~0xFF) | v;
    else if (n === 1) { this.scrollX = (this.scrollX & 0xFF) | ((v & 7) << 8); this.scrollY = (this.scrollY & 0xFF) | ((v & 0x80) << 1); }
    else this.scrollY = (this.scrollY & ~0xFF) | v;
  }

  // Port 6 (monoboard): the sound board's command and, on Sounds Good, its reset line (bit 5, active low).
  op6(v) {
    if (this.cfg.squeak === 'sg') this.squeak.setReset(!(v & 0x20));
    this.squeak.command(v);
  }

  // Port 4 (Spy Hunter): the Chip Squeak Deluxe's command, the lamps, and the analog input select.
  op4(v) {
    this.mux = (v >> 7) & 1;
    if (this.squeak) this.squeak.command(v);
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    this.ctc.trigger(2, 1); this.ctc.trigger(2, 0);
    if (!this.field) { this.ctc.trigger(3, 1); this.ctc.trigger(3, 0); }
    this.field ^= 1;
    this.cpu.irq = this.ctc.irq();

    const perSlice = this.cfg.clock / 60 / SLICES, soundPerSlice = 2000000 / 60 / SLICES;
    const squeakPerSlice = this.squeak ? this.squeak.clock / 60 / SLICES : 0;
    for (let s = 0; s < SLICES; s++) {
      this.cycleCarry += perSlice;
      const ran = this.cpu.run(Math.floor(this.cycleCarry));
      this.cycleCarry -= ran;
      this.ctc.clock(ran);
      this.cpu.irq = this.ctc.irq();
      if (this.cfg.ssio) {
        this.soundCarry += soundPerSlice;
        const sran = this.sndCpu.run(Math.floor(this.soundCarry));
        this.soundCarry -= sran;
        this.soundTicks(sran);
      }
      if (this.squeak) {
        this.squeakCarry += squeakPerSlice;
        const qran = this.squeak.run(Math.floor(this.squeakCarry));
        this.squeakCarry -= qran;
      }
      this.sampleCarry += SAMPLES_PER_SLICE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    this.render();
  }

  // ---------------------------------------------------------------- video

  render() {
    if (this.cfg.scroll) this.renderScrolling(); else this.renderMono();
    if (this.cfg.rotate) rotate90(this.native, this.nativeW, this.cfg.scroll ? 480 : H, this.frame);
    else if (this.cfg.flipX) {
      const w = this.nativeW, h = this.native.length / w;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.frame[y * w + x] = this.native[y * w + (w - 1 - x)];
    }
  }

  // Monoboard: 32x30 tiles of 16x16; a tile's color bank is inverted; tile codes reach 11 bits.
  renderMono() {
    const out = this.native, vram = this.vram, pal = this.palette, bg = this.bgPix, count = this.bgPix.length / 64;
    for (let row = 0; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const i = row * 32 + col, data = vram[i * 2] | (vram[i * 2 + 1] << 8);
        const code = ((data & 0x3FF) | ((data >> 4) & 0x400)) % count;
        const base = (((data >> 12) & 3) ^ 3) * 16, flip = (data >> 10) & 3;
        for (let y = 0; y < 16; y++) {
          const src = code * 64 + ((flip & 2 ? 15 - y : y) >> 1) * 8;
          let o = (row * 16 + y) * W + col * 16;
          for (let x = 0; x < 16; x++, o++) out[o] = pal[base + bg[src + ((flip & 1 ? 15 - x : x) >> 1)]];
        }
      }
    }
    this.sprites3(W, H, 3, 0, 0);
  }

  // Scrolling: the background is 64x32 tiles of 64x32 over a 4096x1024 field
  // (scrolled by the registers), then sprites, then the text layer.
  renderScrolling() {
    const out = this.native, vram = this.vram, pal = this.palette, bg = this.bgPix, w = 480;
    const sx0 = this.scrollX * 2 + this.cfg.scrollOffset, sy0 = this.scrollY * 2;
    for (let y = 0; y < 480; y++) {
      const fy = (y + sy0) & 1023, row = fy >> 5, ty = fy & 31;
      const memRow = (row & 0x0F) | ((row & 0x10) << 6);
      let o = y * w;
      for (let x = 0; x < w; x++, o++) {
        const fx = (x + sx0) & 4095, col = fx >> 6;
        const data = vram[memRow | (col << 4)];
        const code = (data & 0x3F) | ((data >> 1) & 0x40);
        const py = data & 0x40 ? 31 - ty : ty;
        out[o] = pal[16 + bg[code * 512 + (py >> 1) * 32 + ((fx & 63) >> 1)]];
      }
    }
    this.sprites3(w, 480, this.cfg.spriteColors, -12, 0);
    // The text layer: 32x32 tiles of 16x16 (8x8 at double size) down the columns, shifted 16 left; pen 0 shows through.
    const alpha = this.alphaPix, a = this.alphaRam, colors = ALPHA_COLORS;
    for (let col = 0; col < 32; col++) {
      for (let row = 0; row < 32; row++) {
        const code = a[col * 32 + row] % this.alphaCount;
        const x0 = col * 16 - 16, y0 = row * 16;
        if (x0 >= w || y0 >= 480 || x0 + 16 <= 0) continue;
        for (let y = 0; y < 16 && y0 + y < 480; y++) {
          const src = code * 64 + (y >> 1) * 8;
          for (let x = 0; x < 16; x++) {
            const px = x0 + x;
            if (px < 0 || px >= w) continue;
            const pen = alpha[src + (x >> 1)];
            if (pen) out[(y0 + y) * w + px] = colors[pen];
          }
        }
      }
    }
  }

  // Sprites, drawn from the end of sprite RAM back: pen 0 is clear; pen 8
  // draws nothing but keeps later sprites off that pixel.
  sprites3(w, h, colorMask, dx, dy) {
    const out = this.native, pri = this.pri, spr = this.spriteRam, pal = this.palette, pix = this.spritePix;
    pri.fill(0);
    for (let offs = 0x1FC; offs >= 0; offs -= 4) {
      if (!spr[offs]) continue;
      const flags = spr[offs + 1];
      const code = (spr[offs + 2] + 256 * ((flags >> 3) & 1)) % this.spriteCount;
      const color = (~flags & colorMask) << 4;
      const hflip = flags & 0x10 ? 31 : 0, vflip = flags & 0x20 ? 31 : 0;
      const sx = (spr[offs + 3] - 3) * 2 + dx, sy = (241 - spr[offs]) * 2 + dy;
      for (let y = 0; y < 32; y++) {
        const ty = sy + y;
        if (ty < 0 || ty >= h) continue;
        const src = code * 1024 + (y ^ vflip) * 32, rowBase = ty * w;
        for (let x = 0; x < 32; x++) {
          const tx = sx + x;
          if (tx < 0 || tx >= w || pri[rowBase + tx]) continue;
          const pen = pix[src + (x ^ hflip)];
          if (!pen) continue;
          pri[rowBase + tx] = 1;
          if (pen !== 8) out[rowBase + tx] = pal[color | pen];
        }
      }
    }
  }
}

// The text layer's four colors are wired, not programmable.
const ALPHA_COLORS = [rgba(0, 0, 0), rgba(0, 255, 0), rgba(0, 0, 255), rgba(255, 255, 255)];

// ---------------------------------------------------------------- games

export class Rampage extends MCR3 {
  constructor(roms) {
    super(roms);
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Jump';
  }
  // IP0: coins. IP1: up, right, down, left, punch, jump (player 1 is George). A
  // monster joins with its jump button (punch shows the directions), so Start is jump.
  setInputs(s) {
    this.ip[0] = 0xFF & ~(s.coin ? 0x01 : 0);
    this.ip[1] = 0xFF & ~((s.up ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.down ? 0x04 : 0) | (s.left ? 0x08 : 0)
      | (s.fire ? 0x10 : 0) | (s.fire2 || s.start1 ? 0x20 : 0));
  }
  // IP4's top bit is the Sounds Good board's status.
  inputPort(n) {
    if (n === 4) return (this.ip[4] & 0x7F) | ((this.squeak.status & 1) << 7);
    return this.ip[n];
  }
  applySwitches(v) { this.ip[3] = 0x80 | 0x70 | 0x08 | 0x04 | v.difficulty; }
}
Rampage.config = { clock: 5000000, squeak: 'sg', rotate: false, board: 'mono' };
Rampage.id = 'rampage';
Rampage.title = 'Rampage';
Rampage.switches = [
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x02], ['Normal', 0x03], ['Hard', 0x01]], default: 0x03 },
];

export class Sarge extends MCR3 {
  constructor(roms) {
    super(roms);
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Missile';
  }
  // Sarge drives a tank with a stick per tread; the touch stick steers both:
  // forward pushes both, back pulls both, left and right turn on the spot.
  setInputs(s) {
    let l = 0, r = 0;
    if (s.up) { l += 1; r += 1; }
    if (s.down) { l -= 1; r -= 1; }
    if (s.left) { l -= 1; r += 1; }
    if (s.right) { l += 1; r -= 1; }
    l = Math.sign(l); r = Math.sign(r);
    this.ip[0] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0));
    this.ip[1] = 0xFF & ~((l > 0 ? 0x01 : 0) | (l < 0 ? 0x02 : 0) | (r > 0 ? 0x04 : 0) | (r < 0 ? 0x08 : 0)
      | (s.fire ? 0x30 : 0) | (s.fire2 ? 0xC0 : 0));
  }
  applySwitches() { this.ip[3] = 0xFF; }
}
Sarge.config = { clock: 5000000, squeak: 'tcs', rotate: false, board: 'mono' };
Sarge.id = 'sarge';
Sarge.title = 'Sarge';
Sarge.switches = [];

export class SpyHunter extends MCR3 {
  constructor(roms) {
    super(roms);
    this.controls = 'eight-way';
    this.buttons = 3;
    this.button2 = 'Missiles';
    this.button3 = 'Smoke & oil';
    this.wheel = 0x74;
    this.pedal = 0x30;
    this.gear = 0;
  }
  // The wheel (left and right, centred at 74), the gas pedal (up: floor it;
  // down: brake to idle), and the gear: high once the pedal's been down a moment.
  setInputs(s) {
    const target = s.left ? 0x34 : s.right ? 0xB4 : 0x74;
    this.wheel += Math.sign(target - this.wheel) * Math.min(6, Math.abs(target - this.wheel));
    const want = s.up ? 0xFF : s.down ? 0x30 : 0x90;
    this.pedal += Math.sign(want - this.pedal) * Math.min(10, Math.abs(want - this.pedal));
    this.gear = this.pedal > 0xE0 ? Math.min(60, this.gear + 1) : Math.max(0, this.gear - 2);
    const high = this.gear >= 30;
    // The factory setting is two coins a credit: a tap of Coin drops two.
    if (s.coin && !this.coinWas) this.coinQueue = 2;
    this.coinWas = !!s.coin;
    let coin = false;
    if (this.coinQueue) { this.coinPhase = (this.coinPhase || 0) + 1; coin = (this.coinPhase % 12) < 6; if (this.coinPhase >= 24) { this.coinQueue = 0; this.coinPhase = 0; } }
    this.ip[0] = 0xFF & ~((coin ? 0x01 : 0) | (high ? 0 : 0x10));
    this.ip[1] = 0xFF & ~((s.fire ? 0x10 : 0) | (s.fire2 ? 0x02 : 0) | (s.fire3 ? 0x09 : 0) | (s.start1 ? 0x04 : 0));
  }
  // IP1 bits 5-6: the Chip Squeak Deluxe's status. IP2: the pedal, or (selected
  // by port 4's top bit) the wheel.
  inputPort(n) {
    if (n === 1) return (this.ip[1] & ~0x60) | ((this.squeak.status << 5) & 0x60);
    if (n === 2) return this.mux ? this.wheel : this.pedal;
    return this.ip[n];
  }
  applySwitches(v) { this.ip[3] = 0xFC | v.timer; }        // demo sounds on
}
SpyHunter.config = { clock: 5000000, ssio: true, squeak: 'csd', scroll: true, scrollOffset: 16, spriteColors: 0, rotate: true, gain: 0.8 };
SpyHunter.id = 'spyhunt';
SpyHunter.title = 'Spy Hunter';
SpyHunter.switches = [
  { id: 'timer', label: 'Game timer', options: [['1:00', 0x00], ['1:30', 0x01]], default: 0x01 },
];

export class CraterRaider extends MCR3 {
  constructor(roms) {
    super(roms);
    this.controls = 'four-way';
    this.buttons = 3;
    this.button2 = 'Bomb';
    this.button3 = 'Shield';
    this.dialControl = true;
  }
  // IP0: coin, starts, fire. IP1: the dial (left and right turn it too). IP2: up, down, two more buttons.
  setInputs(s) {
    const spin = (s.spin || 0) + (s.right ? 4 : 0) - (s.left ? 4 : 0);
    if (spin) this.dial = (this.dial - Math.round(spin)) & 0xFF;
    this.ip[0] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0) | (s.fire ? 0x10 : 0));
    this.ip[1] = this.dial;
    this.ip[2] = 0xFF & ~((s.up ? 0x04 : 0) | (s.down ? 0x08 : 0) | (s.fire3 ? 0x10 : 0) | (s.fire2 ? 0x40 : 0));
  }
  applySwitches() { this.ip[3] = 0xFF; }
}
CraterRaider.config = { clock: 5000000, ssio: true, scroll: true, scrollOffset: 96, spriteColors: 3, flipX: true, gain: 0.55 };
CraterRaider.id = 'crater';
CraterRaider.title = 'Crater Raider';
CraterRaider.switches = [];
