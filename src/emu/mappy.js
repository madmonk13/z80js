// Namco Mappy (1983) board: two 6809s at 1.536 MHz (main and sound) sharing
// 1K of RAM, which also holds the registers of the 15xx waveform sound chip
// (8 voices); two 58xx custom I/O chips that read the controls and switches
// and count coins into a small shared RAM; a 36x60 tile map that scrolls
// under fixed side columns; and 64 sprites of 16x16 to 32x32.
//
// The family (Super Pac-Man, Pac & Pal, Dig Dug II, Motos, The Tower of
// Druaga, Grobda, Phozon) differs mainly in maps and custom chips.
//
// 264 lines of 96 CPU cycles (60.6 Hz); the picture is 288x224 on a vertical
// monitor.

import { M6809 } from './m6809.js';
import { decodeTiles, promPalette, rotate90, run } from './video.js';
import { RATE } from './mixer.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 288, H = 224;
const LINES = 264, LINE_CYCLES = 96, VBLANK_LINE = 224;
const STATE = ['vram', 'ram', 'shared', 'ioRam', 'io', 'scroll', 'latch', 'subReset', 'in0', 'in1', 'main', 'sub', 'sound'];

// Namco 15xx: 8 voices, each a 32-step 4-bit waveform from the sound PROM at
// a 20-bit frequency, stepped at 24 kHz. Registers sit in the shared RAM.
class Namco15xx {
  constructor(wave, regs) {
    this.wave = wave; this.regs = regs;
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }
  saveState() { return { counter: this.counter.slice(), enabled: this.enabled }; }
  loadState(s) { this.counter.set(s.counter); this.enabled = s.enabled; }
  reset() { this.counter = new Uint32Array(8); this.enabled = false; this.writePos = this.readPos = 0; }

  sample() {
    let s = 0;
    if (this.enabled) {
      const r = this.regs;
      for (let v = 0; v < 8; v++) {
        const o = v * 8, vol = r[o + 3] & 15;
        const freq = r[o + 4] | (r[o + 5] << 8) | ((r[o + 6] & 15) << 16);
        // Half a 24 kHz step per 48 kHz output sample.
        this.counter[v] = (this.counter[v] + (freq >>> 1)) & 0xFFFFF;
        if (vol) s += ((this.wave[((r[o + 6] >> 4) & 7) * 32 + (this.counter[v] >>> 15)] & 15) - 8) * vol;
      }
    }
    const mask = this.buffer.length - 1;
    this.buffer[this.writePos] = s / (8 * 15 * 8) * 1.6;
    this.writePos = (this.writePos + 1) & mask;
    if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
  }

  available() { return (this.writePos - this.readPos) & (this.buffer.length - 1); }
  pull(out, outRate) {
    const buf = this.buffer, mask = buf.length - 1, step = RATE / outRate;
    if (this.available() > RATE * 0.075) this.readPos = (this.writePos - Math.floor(RATE * 0.035)) & mask;
    let pos = this.frac || 0, last = this.last || 0;
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) { out[i] = last *= 0.995; continue; }
      const s0 = buf[this.readPos], s1 = buf[(this.readPos + 1) & mask];
      last = out[i] = s0 + (s1 - s0) * pos;
      pos += step;
      while (pos >= 1 && this.available() > 1) { pos -= 1; this.readPos = (this.readPos + 1) & mask; }
    }
    this.frac = pos; this.last = last;
  }
}

// The answer each 58xx gives to Mappy's power-on check (mode 5), as
// documented: arguments 3 6 5 F A C E produce 8 4 6 E D 9 D.
const BOOT_QUERY = [3, 6, 5, 0xF, 0xA, 0xC, 0xE], BOOT_ANSWER = [0, 8, 4, 6, 0xE, 0xD, 9, 0xD];

export class Mappy {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); }

  // roms: { main (A000-FFFF), sub (E000-FFFF), chars 4K, sprites 8K, palette 32, charLut 256, spriteLut 256, wave 256 }
  constructor(roms) {
    this.width = H;
    this.height = W;
    this.refresh = 60.606;
    this.controls = 'two-way';
    this.buttons = 1;                            // open/close doors
    this.roms = roms;
    this.vram = new Uint8Array(0x1000);
    this.ram = new Uint8Array(0x1800);          // 1000-27FF, sprites inside
    this.shared = new Uint8Array(0x400);
    this.ioRam = new Uint8Array(0x20);
    this.main = new M6809({ read: (a) => this.mainRead(a), write: (a, v) => this.mainWrite(a, v) });
    this.sub = new M6809({ read: (a) => this.subRead(a), write: (a, v) => this.subWrite(a, v) });
    this.sound = new Namco15xx(roms.wave, this.shared);

    // Characters are stored inverted.
    const chars = roms.chars.map((v) => v ^ 0xFF);
    this.charPix = decodeTiles(chars, { count: 256, width: 8, height: 8, planes: [0, 4], xs: [64, 65, 66, 67, 0, 1, 2, 3], ys: run(0, 8, 8), size: 128 });
    const half = roms.sprites.length * 4;
    this.spritePix = decodeTiles(roms.sprites, {
      count: roms.sprites.length / 128, width: 16, height: 16, planes: [0, 4, half, half + 4],
      xs: [...run(0, 4), ...run(64, 4), ...run(128, 4), ...run(192, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    this.palette = promPalette(roms.palette, 32);
    this.charLut = Uint8Array.from(roms.charLut, (v) => (v & 15) + 16);
    this.spriteLut = Uint8Array.from(roms.spriteLut, (v) => v & 15);
    this.native = new Uint32Array(W * H);
    this.frame = new Uint32Array(W * H);
    this.front = new Uint8Array(W * H);
    this.in0 = this.in1 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.vram.fill(0); this.ram.fill(0); this.shared.fill(0); this.ioRam.fill(0);
    this.latch = new Uint8Array(8);             // all latches low at power-on
    this.io = [this.ioChip(), this.ioChip()];
    this.scroll = 0;
    this.subReset = true;
    this.main.reset(); this.sub.reset();
    this.sound.reset();
  }

  ioChip() { return { coinsPerCred: [1, 1], credsPerCoin: [1, 1], coins: [0, 0], credits: 0, lastCoins: 0, lastButtons: 0, mux: 0 }; }

  // ---------------------------------------------------------------- buses

  mainRead(a) {
    if (a < 0x1000) return this.vram[a];
    if (a < 0x2800) return this.ram[a - 0x1000];
    if (a >= 0x4000 && a < 0x4400) return this.shared[a & 0x3FF];
    if (a >= 0x4800 && a < 0x4C00) return 0xF0 | this.ioRam[a & 0x1F];
    if (a >= 0xA000) return this.roms.main[a - 0xA000];
    return 0xFF;
  }

  mainWrite(a, v) {
    if (a < 0x1000) { this.vram[a] = v; return; }
    if (a < 0x2800) { this.ram[a - 0x1000] = v; return; }
    if (a >= 0x3800 && a < 0x4000) { this.scroll = (a & 0x7FF) >> 3; return; }
    if (a >= 0x4000 && a < 0x4400) { this.shared[a & 0x3FF] = v; return; }
    if (a >= 0x4800 && a < 0x4C00) { this.ioRam[a & 0x1F] = v & 15; return; }
    if (a >= 0x5000 && a < 0x5010) this.writeLatch(a & 15);
  }

  subRead(a) {
    if (a < 0x400) return this.shared[a];
    if (a >= 0xE000) return this.roms.sub[a - 0xE000];
    return 0xFF;
  }
  subWrite(a, v) {
    if (a < 0x400) { this.shared[a] = v; return; }
    if (a >= 0x2000 && a < 0x2010) this.writeLatch(a & 15);
  }

  // Control latches: the address picks the latch, its low bit the value.
  writeLatch(o) {
    const bit = o & 1, n = o >> 1;
    this.latch[n] = bit;
    switch (n) {
      case 0: if (!bit) this.sub.irq = false; break;        // INT ON 2 (sound CPU)
      case 1: if (!bit) this.main.irq = false; break;       // INT ON
      case 3: this.sound.enabled = !!bit; break;            // SOUND ON
      case 4: if (!bit) this.io = [this.ioChip(), this.ioChip()]; break;   // I/O chips held in reset while low
      case 5:                                                // SUB RESET: low holds the sound CPU in reset
        if (!bit) { this.sub.reset(); this.subReset = true; } else this.subReset = false;
        break;
    }
  }

  // ---------------------------------------------------------------- 58xx I/O chips

  // Each chip has four 4-bit input ports and 16 nibbles of RAM; on each
  // frame it carries out the mode written to nibble 8.
  ports(chip) {
    if (chip === 0) return [this.in1 >> 4, this.in0 & 15, this.in0 >> 4, this.in1 & 15];
    return [(this.dsw2 >> (4 * this.io[1].mux)) & 15, this.dsw1 & 15, this.dsw1 >> 4, this.dsw0 & 15];
  }

  runIo(chip) {
    const ram = this.ioRam, base = chip * 16, io = this.io[chip];
    const rd = (n) => ram[base + n] & 15, wr = (n, v) => { ram[base + n] = v & 15; };
    let p = this.ports(chip);
    switch (rd(8)) {
      case 1: for (let i = 0; i < 4; i++) wr(4 + i, ~p[i]); break;                   // read switches
      case 2: io.coinsPerCred = [rd(9), rd(11)]; io.credsPerCoin = [rd(10), rd(12)]; break;   // coinage
      case 3: this.handleCoins(chip, p); break;                                         // coins, credits and controls
      case 4:                                                                            // switches, both mux halves
        io.mux = 0; p = this.ports(chip);
        for (let i = 0; i < 4; i++) wr(i * 2, ~p[i]);
        io.mux = 1; p = this.ports(chip);
        for (let i = 0; i < 4; i++) wr(i * 2 + 1, ~p[i]);
        break;
      case 5:                                                                            // power-on check
        if (BOOT_QUERY.every((q, i) => rd(9 + i) === q)) BOOT_ANSWER.forEach((v, i) => wr(i, v));
        else for (let i = 0; i < 8; i++) wr(i, 0);
        break;
    }
  }

  // Mode 3: count coins into BCD credits (start buttons spend them), and
  // report the controls with "pressed" and "just pressed" bits for buttons.
  handleCoins(chip, p) {
    const ram = this.ioRam, base = chip * 16, io = this.io[chip];
    const wr = (n, v) => { ram[base + n] = v & 15; };
    let val = ~p[0] & 15, toggled = val ^ io.lastCoins, add = 0, sub = 0;
    io.lastCoins = val;
    for (let c = 0; c < 2; c++) {
      if (val & toggled & (1 << c)) {
        io.coins[c]++;
        if (io.coins[c] >= (io.coinsPerCred[c] & 7)) { add = io.credsPerCoin[c] - (io.coinsPerCred[c] >> 3); io.coins[c] -= io.coinsPerCred[c] & 7; }
        else if (io.coinsPerCred[c] & 8) add = 1;
      }
    }
    if (val & toggled & 8) add = 1;                                    // service credit
    val = ~p[3] & 15; toggled = val ^ io.lastButtons;
    io.lastButtons = val;
    if ((ram[base + 9] & 15) === 0) {
      if (val & toggled & 4) { if (io.credits >= 1) sub = 1; }
      else if (val & toggled & 8) { if (io.credits >= 2) sub = 2; }
    }
    io.credits += add - sub;
    wr(2, io.credits / 10 | 0); wr(3, io.credits % 10); wr(0, add); wr(1, sub);
    wr(4, ~p[1]);
    wr(5, ((val & 5) << 1) | (val & toggled & 5));
    wr(6, ~p[2]);
    wr(7, (val & 0x0A) | ((val & toggled & 0x0A) >> 1));
  }

  // ---------------------------------------------------------------- inputs

  // IN0: right, left (player 1). IN1: door button, starts, coin.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.right ? 0x02 : 0) | (s.left ? 0x08 : 0));
    this.in1 = 0xFF & ~((s.fire ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0) | (s.coin ? 0x10 : 0));
  }
  // DSW0: upright, service off. DSW1: difficulty, coin B, demo sounds, rack
  // test and freeze off. DSW2: coin A, bonus, lives.
  applySwitches(v) { this.dsw0 = 0x0F; this.dsw1 = 0xD8 | v.difficulty | v.demoSounds; this.dsw2 = 0x3F | v.lives; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK_LINE) {
        if (this.latch[1]) this.main.irq = true;
        if (this.latch[0] && !this.subReset) this.sub.irq = true;
        this.render();
      }
      if (line === VBLANK_LINE + 1 && this.latch[4]) { this.runIo(0); this.runIo(1); }
      this.main.run(LINE_CYCLES);
      if (!this.subReset) this.sub.run(LINE_CYCLES);
      for (let k = 0; k < 3; k++) this.sound.sample();          // 3 x 16 kHz lines = 48 kHz
    }
  }

  // ---------------------------------------------------------------- video

  // Tile index for map column c (0-35) and row r (0-59).
  tileOffs(col, row) {
    const c = col - 2;
    if (c & 0x20) return row & 0x20 ? 0x7FF : ((row + 2) & 0x0F) + (row & 0x10) + ((c & 3) << 5) + 0x780;
    return c + (row << 5);
  }

  render() {
    const out = this.native, front = this.front, vram = this.vram, pal = this.palette, lut = this.charLut;
    front.fill(0);
    for (let x = 0; x < W; x++) {
      const col = x >> 3, scroll = col >= 2 && col < 34 ? this.scroll : 0;
      for (let y = 0; y < H; y++) {
        const ty = (y + scroll) % 480, offs = this.tileOffs(col, ty >> 3);
        const attr = vram[offs + 0x800];
        const c = lut[(attr & 0x3F) * 4 + this.charPix[vram[offs] * 64 + (ty & 7) * 8 + (x & 7)]];
        const o = y * W + x;
        out[o] = pal[c];
        if ((attr & 0x40) && c !== 31) front[o] = 1;          // priority tiles, where not see-through
      }
    }

    // Sprites: registers at 1780, 1F80 and 2780.
    const r1 = 0x780, r2 = 0xF80, r3 = 0x1780, ram = this.ram;
    for (let offs = 0; offs < 0x80; offs += 2) {
      if (ram[r3 + offs + 1] & 2) continue;
      const flags = ram[r3 + offs];
      const flipX = flags & 1, flipY = (flags >> 1) & 1, sizeX = (flags >> 2) & 1, sizeY = (flags >> 3) & 1;
      const code = ram[r1 + offs] & ~sizeX & ~(sizeY << 1), color = (ram[r1 + offs + 1] & 15) * 16;
      const sx = ram[r2 + offs + 1] + 0x100 * (ram[r3 + offs + 1] & 1) - 40;
      const sy = ((256 - ram[r2 + offs] + 1 - 16 * sizeY) & 0xFF) - 32;
      for (let ty = 0; ty <= sizeY; ty++) for (let tx = 0; tx <= sizeX; tx++) {
        const tile = code + [[0, 1], [2, 3]][ty ^ (sizeY * flipY)][tx ^ (sizeX * flipX)];
        this.drawSprite(tile, color, flipX, flipY, sx + 16 * tx, sy + 16 * ty);
      }
    }
    rotate90(out, W, H, this.frame);
  }

  drawSprite(code, color, flipX, flipY, sx, sy) {
    const out = this.native, pix = (code % (this.spritePix.length / 256)) * 256;
    for (let y = 0; y < 16; y++) {
      const py = sy + y;
      if (py < 0 || py >= H) continue;
      const src = pix + (flipY ? 15 - y : y) * 16;
      for (let x = 0; x < 16; x++) {
        const px = sx + x;
        if (px < 0 || px >= W) continue;
        const v = this.spriteLut[(color + this.spritePix[src + (flipX ? 15 - x : x)]) & 0xFF];
        if (v !== 15 && !this.front[py * W + px]) out[py * W + px] = this.palette[v];
      }
    }
  }
}

Mappy.id = 'mappy';
Mappy.title = 'Mappy';
Mappy.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x80], ['2', 0x40], ['3', 0xC0], ['5', 0x00]], default: 0xC0 },
  { id: 'difficulty', label: 'Difficulty', options: [['A (easiest)', 0x07], ['B', 0x06], ['C', 0x05], ['D', 0x04]], default: 0x07 },
  { id: 'demoSounds', label: 'Demo sounds', options: [['On', 0x20], ['Off', 0x00]], default: 0x20 },
];
