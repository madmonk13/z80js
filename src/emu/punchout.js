// Nintendo Punch-Out!! (1984): two monitors, one above the other. A 4 MHz Z80
// runs the game; the top screen is a 32x32 tile layer (the fight stats), the
// bottom one a 64x32 tile layer whose rows scroll sideways (the ring), the
// opponent as a "big sprite" of 16x32 tiles that zooms and can appear on
// either screen, and Little Mac as a second, fixed-size one. A 2A03 (the NES's
// CPU and sound) plays music and the crowd from two latches; a VLM5030 talks
// ("Body blow!").
//
// Each screen is 256x224 at 60 Hz; the frame stacks them into 256x448.

import { Z80 } from './z80.js';
import { CPU6502 } from './m6502.js';
import { APU2A03 } from './apu2a03.js';
import { VLM5030 } from './vlm5030.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 256, H = 224, TOP = 16, LINES = 264, REFRESH = 60;
const LINE_CYCLES = 4000000 / REFRESH / LINES, SOUND_CYCLES = 1789773 / REFRESH / LINES, SAMPLES = RATE / REFRESH / LINES;
const STATE = ['nvram', 'ram', 'topRam', 'bs1Ram', 'bs2Ram', 'botRam', 'soundRam', 'latches', 'nmiOn', 'soundOn',
  'in0', 'in1', 'cycleCarry', 'subCarry', 'sampleCarry', 'cpu', 'sub', 'apu', 'vlm'];

export class PunchOut {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main 48K, sound 8K (E000), top 16K, bottom 16K, bs1 192K, bs2 64K, red, green, blue (1K each), speech 16K }
  constructor(roms) {
    this.width = W;
    this.height = H * 2;
    this.refresh = REFRESH;
    this.controls = 'four-way';
    this.buttons = 3;
    this.button2 = 'Right'; this.button3 = 'KO';
    this.roms = roms;
    this.nvram = new Uint8Array(0x400);               // C000-C3FF: settings and the hall of fame
    this.ram = new Uint8Array(0x800);                 // D000-D7FF
    this.topRam = new Uint8Array(0x800);              // D800-DFFF: top screen (the big sprite registers sit at its end)
    this.bs1Ram = new Uint8Array(0x800);              // E000-E7FF: the opponent
    this.bs2Ram = new Uint8Array(0x800);              // E800-EFFF: Little Mac
    this.botRam = new Uint8Array(0x1000);             // F000-FFFF: bottom screen (row scrolls in its first 64 bytes)
    this.soundRam = new Uint8Array(0x800);
    this.latches = new Uint8Array(2);
    this.cpu = new Z80({ read: (a) => this.read(a), write: (a, v) => this.write(a, v),
      input: (p) => this.input(p & 0xFF), output: (p, v) => this.output(p & 0xFF, v) });
    this.sub = new CPU6502({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.sub.binaryOnly = true;
    this.apu = new APU2A03({ read: (a) => this.soundRead(a), stall: () => {} });
    this.vlm = new VLM5030(3580000, roms.speech, 1);
    this.sound = new SoundMix([this.apu, this.vlm], 1.2);
    this.frame = new Uint32Array(W * H * 2);

    const chars2 = (rom, count) => decodeTiles(rom, { count, width: 8, height: 8, planes: [count * 64, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    this.topPix = chars2(roms.top, 1024);
    this.botPix = chars2(roms.bottom, 1024);
    this.bs1Pix = decodeTiles(roms.bs1, { count: 8192, width: 8, height: 8, planes: [2 * 8192 * 64, 8192 * 64, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    this.bs2Pix = chars2(roms.bs2, 4096);
    // Six 512x4 PROMs, one per gun for each half (top screen tiles; everything else), through
    // 2K/1K/470/240 ohm resistors into inverters.
    const level = (v) => 255 - (0x10 * (v & 1) + 0x21 * ((v >> 1) & 1) + 0x46 * ((v >> 2) & 1) + 0x88 * ((v >> 3) & 1));
    this.palette = Uint32Array.from({ length: 1024 }, (_, i) => rgba(level(roms.red[i]), level(roms.green[i]), level(roms.blue[i])));
    this.bs1Bitmap = new Int16Array(128 * 256);       // the big sprites drawn out (-1 = see-through)
    this.bs2Bitmap = new Int16Array(128 * 256);
    this.in0 = 0; this.in1 = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.topRam, this.bs1Ram, this.bs2Ram, this.botRam, this.soundRam, this.latches]) a.fill(0);
    this.nmiOn = false; this.soundOn = true;
    this.cycleCarry = this.subCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sub.reset(); this.sound.reset(); this.vlm.reset();
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < 0xC000) return this.roms.main[a];
    if (a < 0xC400) return this.nvram[a - 0xC000];
    if (a < 0xD000) return 0xFF;
    if (a < 0xD800) return this.ram[a - 0xD000];
    if (a < 0xE000) return this.topRam[a - 0xD800];
    if (a < 0xE800) return this.bs1Ram[a - 0xE000];
    if (a < 0xF000) return this.bs2Ram[a - 0xE800];
    return this.botRam[a - 0xF000];
  }

  write(a, v) {
    if (a < 0xC000) return;
    if (a < 0xC400) this.nvram[a - 0xC000] = v;
    else if (a < 0xD000) return;
    else if (a < 0xD800) this.ram[a - 0xD000] = v;
    else if (a < 0xE000) this.topRam[a - 0xD800] = v;
    else if (a < 0xE800) this.bs1Ram[a - 0xE000] = v;
    else if (a < 0xF000) this.bs2Ram[a - 0xE800] = v;
    else this.botRam[a - 0xF000] = v;
  }

  // Ports: 00-03 read the controls and switches (03 bit 4 low while the VLM5030 talks).
  input(p) {
    switch (p) {
      case 0x00: return this.in0;
      case 0x01: return this.in1;
      case 0x02: return this.dsw0;
      case 0x03: return (this.dsw1 & ~0x10) | (this.vlm.busy ? 0 : 0x10);
    }
    return 0;
  }

  output(p, v) {
    switch (p) {
      case 0x02: this.latches[0] = v; break;
      case 0x03: this.latches[1] = v; break;
      case 0x04: this.vlm.write(v); break;
      case 0x08: this.nmiOn = !!(v & 1); break;
      case 0x0B: {                                     // the 2A03's reset line
        const on = !(v & 1);
        if (on && !this.soundOn) this.sub.reset();
        this.soundOn = on;
        break;
      }
      case 0x0C: this.vlm.setRst(v & 1); break;
      case 0x0D: this.vlm.setSt(v & 1); break;
      // 0E: VLM5030 VCU (unused), 09 watchdog, 0A/0F unknown.
    }
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x800) return this.soundRam[a];
    if (a >= 0xE000) return this.roms.sound[a - 0xE000];
    if (a === 0x4016) return this.latches[0];
    if (a === 0x4017) return this.latches[1];
    if (a === 0x4015) return this.apu.readStatus();
    return 0;
  }
  soundWrite(a, v) {
    if (a < 0x800) this.soundRam[a] = v;
    else if (a >= 0x4000 && a < 0x4018) this.apu.write(a, v);
  }

  // ---------------------------------------------------------------- inputs

  // IN0 (active high): left punch, right punch, KO punch. IN1: right, left, up, down, coin.
  setInputs(s) {
    this.in0 = (s.fire || s.start1 ? 0x01 : 0) | (s.fire2 ? 0x04 : 0) | (s.fire3 ? 0x08 : 0);
    this.in1 = (s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.up ? 0x04 : 0) | (s.down ? 0x08 : 0) | (s.coin ? 0x80 : 0);
  }

  // DSW0: difficulty, time, demo sounds on. DSW1: 1 coin 1 credit, Nintendo copyright.
  applySwitches(v) {
    this.dsw0 = v.difficulty | v.time | 0x10;
    this.dsw1 = 0x00;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === 240) {
        this.render();
        if (this.nmiOn) this.cpu.nmi();
        if (this.soundOn) this.sub.nmi();
      }
      this.cycleCarry += LINE_CYCLES;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.subCarry += SOUND_CYCLES;
      while (this.subCarry >= 1) {
        let n = 1;
        if (this.soundOn) { const c0 = this.sub.cycles; this.sub.step(); n = this.sub.cycles - c0; }
        for (let i = 0; i < n; i++) this.apu.tick();
        this.subCarry -= n;
      }
      this.sampleCarry += SAMPLES;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  // Colors pass through an inverting jumper on the way to the PROMs: palette = base + (color * pens + pen) ^ inv.
  render() {
    const pal = this.palette, out = this.frame, top = this.topRam, bot = this.botRam;
    const bank = top[0x7FD], topBank = (bank >> 1) & 1, botBank = bank & 1;
    // Top screen tiles: 2 bytes each (code low; code high, color, flip x).
    for (let row = 2; row < 30; row++) for (let col = 0; col < 32; col++) {
      const o = (row * 32 + col) * 2, attr = top[o + 1];
      const code = top[o] | ((attr & 3) << 8), color = ((attr & 0x7C) >> 2) + 64 * topBank, flip = attr & 0x80;
      for (let y = 0; y < 8; y++) {
        const dst = ((row - 2) * 8 + y) * W + col * 8, src = code * 64 + y * 8;
        for (let x = 0; x < 8; x++) out[dst + x] = pal[(color * 4 + this.topPix[src + (flip ? 7 - x : x)]) ^ 0x03];
      }
    }
    const regs1 = top.subarray(0x7F0, 0x7F8);
    if (regs1[7] & 1) this.drawBig1(0, regs1, botBank);

    // Bottom screen: 64x32 tiles, each row scrolled sideways.
    const lower = W * H;
    for (let y = 0; y < H; y++) {
      const sy = y + TOP, row = sy >> 3, scroll = 58 + bot[row * 2] + 256 * (bot[row * 2 + 1] & 1);
      for (let x = 0; x < W; x++) {
        const sx = (x + scroll) & 511, o = (row * 64 + (sx >> 3)) * 2, attr = bot[o + 1];
        const code = bot[o] | ((attr & 3) << 8), color = ((attr & 0x7C) >> 2) + 64 * botBank;
        const px = attr & 0x80 ? 7 - (sx & 7) : sx & 7;
        out[lower + y * W + x] = pal[512 + ((color * 4 + this.botPix[code * 64 + (sy & 7) * 8 + px]) ^ 0xFC)];
      }
    }
    if (regs1[7] & 2) this.drawBig1(lower, regs1, botBank);
    this.drawBig2(lower, top.subarray(0x7F8, 0x7FD), botBank);
  }

  // Draw a big sprite's 16x32 tiles (4 bytes each: code low, code high, -, color and flip x) into a bitmap.
  bigBitmap(ram, bitmap, pix, bpp, codeMask, colorMask, colorBank, inv, clear) {
    const pens = 1 << bpp;
    for (let t = 0; t < 512; t++) {
      const o = t * 4, code = ram[o] | ((ram[o + 1] & codeMask) << 8), attr = ram[o + 3];
      const color = (attr & colorMask) + colorBank, flip = attr & 0x80, bx = (t & 15) * 8, by = (t >> 4) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const k = (color * pens + pix[code * 64 + y * 8 + (flip ? 7 - x : x)]) ^ inv;
        bitmap[(by + y) * 128 + bx + x] = (k & (pens - 1)) === clear ? -1 : 512 + (k & 0x1FF);
      }
    }
  }

  // The opponent: zoomed by a 12-bit factor (0x400 = full size), positioned in 12-bit x and 9-bit y.
  drawBig1(base, r, botBank) {
    const zoom = r[0] | ((r[1] & 0x0F) << 8);
    if (!zoom) return;
    this.bigBitmap(this.bs1Ram, this.bs1Bitmap, this.bs1Pix, 3, 0x1F, 0x1F, 32 * botBank, 0xFF, 0);
    let sx = 4096 - (r[2] | ((r[3] & 0x0F) << 8));
    if (sx > 4096 - 4 * 127) sx -= 4096;
    let sy = -(r[4] | ((r[5] & 1) << 8));
    if (sy <= -256 + zoom / 0x40) sy += 512;
    sy += 12;
    let startx = -sx * 0x4000 + 3740 * zoom, incx = zoom << 6;
    const starty = -sy * 0x10000 - 178 * zoom + 0x400 * zoom, incy = zoom << 6;
    if (r[6] & 1) { startx = (128 << 16) - startx - 1; incx = -incx; }
    const out = this.frame, pal = this.palette, bmp = this.bs1Bitmap;
    for (let y = 0; y < H; y++) {
      const cy = Math.floor((starty + (y + TOP) * incy) / 65536);
      if (cy < 0 || cy >= 256) continue;
      for (let x = 0; x < W; x++) {
        const cx = Math.floor((startx + x * incx) / 65536);
        if (cx < 0 || cx >= 128) continue;
        const c = bmp[cy * 128 + cx];
        if (c >= 0) out[base + y * W + x] = pal[c];
      }
    }
  }

  // Little Mac: full size, 9-bit x and y, flip x.
  drawBig2(base, r, botBank) {
    this.bigBitmap(this.bs2Ram, this.bs2Bitmap, this.bs2Pix, 2, 0x0F, 0x3F, 64 * botBank, 0xFC, 0);
    let sx = 512 - (r[0] | ((r[1] & 1) << 8));
    if (sx > 512 - 127) sx -= 512;
    sx -= 55;
    const sy = -r[2] + 256 * (r[3] & 1) + 3, flip = r[4] & 1;
    const out = this.frame, pal = this.palette, bmp = this.bs2Bitmap;
    for (let y = 0; y < 256; y++) {
      const py = sy + y - TOP;
      if (py < 0 || py >= H) continue;
      for (let x = 0; x < 128; x++) {
        const px = sx + x;
        if (px < 0 || px >= W) continue;
        const c = bmp[y * 128 + (flip ? 127 - x : x)];
        if (c >= 0) out[base + py * W + px] = pal[c];
      }
    }
  }
}

PunchOut.id = 'punchout';
PunchOut.title = 'Punch-Out!!';
PunchOut.switches = [
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x00], ['Medium', 0x01], ['Hard', 0x02], ['Hardest', 0x03]], default: 0x00 },
  { id: 'time', label: 'Time', options: [['Longest', 0x00], ['Long', 0x04], ['Short', 0x08], ['Shortest', 0x0C]], default: 0x00 },
];
