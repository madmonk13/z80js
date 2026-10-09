// Namco Galaga (1981) board: three Z80s sharing video and work RAM, the 06xx
// bus interface with a 51xx I/O chip (coins, credits, controls) and a 54xx
// explosion generator, a tile layer, 64 hardware sprites, the 05xx starfield
// and the 3-voice Namco waveform sound generator.
//
// Timing: 18.432 MHz master clock. Each CPU runs at 3.072 MHz; a frame is 264
// lines of 192 CPU cycles (60.606 Hz). The picture is 288x224, mounted on a
// vertical monitor, so the frame is handed out rotated to 224x288.

import { Z80 } from './z80.js';
import { WSG } from './wsg.js';
import { STARS } from './galaga-stars.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const SCREEN_W = 224, SCREEN_H = 288;   // as displayed (rotated)
export const NATIVE_W = 288, NATIVE_H = 224;
const LINES = 264, LINE_CYCLES = 192, VBLANK_LINE = 224;
const NMI_06XX_CYCLES = 614;                     // 200 us at 3.072 MHz

// 51xx joystick remap: LDRU bits (active low) to a direction code 0-8.
const JOY_MAP = [0xF, 0xE, 0xD, 0x5, 0xC, 0x9, 0x7, 0x6, 0xB, 0x3, 0xA, 0x4, 0x1, 0x2, 0x0, 0x8];

const GALAGA_STATE = ['ram', 'latch', 'subRunning', 'soundRegs', 'starControl', 'starScroll', 'cmd06', 'next06Nmi', 'io', 'frameCount', 'explosion', 'in0', 'in1', 'cpus', 'wsg'];

export class Galaga {
  // Save states: everything that changes while running (not ROM-derived data).
  // RAM is kept by address for convenience; only 8000-9FFF is real.
  saveState() { return { ...capture(this, GALAGA_STATE.filter((f) => f !== 'ram')), ram: this.ram.slice(0x8000, 0xA000) }; }
  loadState(s) {
    apply(this, GALAGA_STATE.filter((f) => f !== 'ram'), s);
    this.ram.fill(0);
    this.ram.set(s.ram, 0x8000);
  }

  // roms: { main 16K, sub 4K, sound 4K, chars 4K, sprites 8K, palette 32,
  //         charLut 256, spriteLut 256, wave 256 }
  constructor(roms) {
    this.width = SCREEN_W;
    this.height = SCREEN_H;
    this.refresh = 60.606;
    this.controls = 'two-way';
    this.buttons = 1;
    this.roms = roms;
    this.ram = new Uint8Array(0x10000);     // video RAM and the three work RAMs, by address
    this.applySwitches(defaultSwitches(this.constructor.switches));
    // Inputs, active low as the hardware reads them.
    //   IN0: 0 fire, 2 start 1, 3 start 2, 4 coin 1, 5 coin 2, 6 service, 7 test
    //   IN1: 1 right, 3 left (player 1)
    this.in0 = 0xFF;
    this.in1 = 0xFF;
    this.wsg = new WSG(roms.wave);
    this.sound = this.wsg;
    this.cpus = [0, 1, 2].map((n) => new Z80({
      read: (a) => this.read(n, a),
      write: (a, v) => this.write(n, a, v),
    }));
    this.frame = new Uint32Array(SCREEN_W * SCREEN_H);
    this.native = new Uint32Array(NATIVE_W * NATIVE_H);
    this.decodeGraphics();
    this.reset();
  }

  reset() {
    this.ram.fill(0);
    for (const c of this.cpus) c.reset();
    this.latch = new Uint8Array(8);         // LS259 outputs, all low at power-on
    this.subRunning = false;
    this.soundRegs = new Uint8Array(32);
    this.wsg.reset();
    this.starControl = new Uint8Array(6);
    this.starScroll = 0;
    this.cmd06 = 0x10;
    this.next06Nmi = Infinity;
    this.io = {
      mode: 0, coinCredMode: 0, coinsPerCred: [1, 1], credsPerCoin: [1, 1], credits: 0,
      coins: [0, 0], count: 0, lastCoins: 0, lastButtons: 0, remapJoy: 0,
    };
    this.frameCount = 0;
    this.explosion = 0;                      // 54xx stand-in: frames of noise left
  }

  // ---------------------------------------------------------------- bus

  read(cpu, a) {
    if (a < 0x4000) {
      const rom = cpu === 0 ? this.roms.main : cpu === 1 ? this.roms.sub : this.roms.sound;
      return a < rom.length ? rom[a] : 0;
    }
    if (a >= 0x8000 && a < 0xA000) return this.ram[a];
    if (a >= 0x6800 && a < 0x6808) {
      const bit = a & 7;
      return ((this.dswB >> bit) & 1) | (((this.dswA >> bit) & 1) << 1);
    }
    if (a >= 0x7000 && a < 0x7100) return this.read06();
    if (a === 0x7100) return this.cmd06;
    return 0;
  }

  write(cpu, a, v) {
    if (a >= 0x8000 && a < 0xA000) {
      // Only the mapped RAM blocks exist: 8000-8BFF, 9000-93FF, 9800-9BFF.
      if (a < 0x8C00 || (a >= 0x9000 && a < 0x9400) || a >= 0x9800 && a < 0x9C00) this.ram[a] = v;
      return;
    }
    if (a >= 0x6800 && a < 0x6820) { this.soundRegs[a & 0x1F] = v & 0x0F; this.wsg.write(a & 0x1F, v); return; }
    if (a >= 0x6820 && a < 0x6828) { this.writeLatch(a & 7, v & 1); return; }
    if (a >= 0x7000 && a < 0x7100) { this.write06(v); return; }
    if (a === 0x7100) { this.control06(v); return; }
    if (a >= 0xA000 && a < 0xA006) { this.starControl[a & 7] = v & 1; return; }
    // 6830 watchdog and A007 flip screen are ignored (upright cabinet only).
  }

  writeLatch(n, bit) {
    this.latch[n] = bit;
    const [main, sub, snd] = this.cpus;
    if (n === 0 && !bit) main.irq = false;        // IRQ1 enable / acknowledge
    if (n === 1 && !bit) sub.irq = false;         // IRQ2 enable / acknowledge
    if (n === 3) {                                // low holds the sub and sound CPUs in reset
      if (!bit) { sub.reset(); snd.reset(); }
      this.subRunning = !!bit;
    }
  }

  // ---------------------------------------------------------------- 06xx / 51xx / 54xx

  control06(v) {
    this.cmd06 = v;
    // While a chip is selected the 06xx interrupts the main CPU every 200 us so
    // its NMI handler can move the next byte.
    const main = this.cpus[0];
    this.next06Nmi = (v & 0x0F) ? main.cycles + NMI_06XX_CYCLES : Infinity;
  }

  read06() {
    if (!(this.cmd06 & 0x10)) return 0;
    switch (this.cmd06 & 0x0F) {
      case 0x1: return this.read51();
      case 0x2: return this.read53();
      default: return 0xFF;
    }
  }

  // Chip select 2 is empty on Galaga; Dig Dug puts its 53xx there.
  read53() { return 0xFF; }

  write06(v) {
    if (this.cmd06 & 0x10) return;
    switch (this.cmd06 & 0x0F) {
      case 0x1: this.write51(v); break;
      case 0x8: this.write54(v); break;
    }
  }

  // 51xx commands: 1 + 4 args set coinage, 2 credit mode, 3/4 joystick remap
  // off/on, 5 switch mode.
  write51(v) {
    const io = this.io;
    v &= 7;
    if (io.coinCredMode) {
      switch (io.coinCredMode--) {
        case 4: io.coinsPerCred[0] = v; break;
        case 3: io.credsPerCoin[0] = v; break;
        case 2: io.coinsPerCred[1] = v; break;
        case 1: io.credsPerCoin[1] = v; break;
      }
      return;
    }
    switch (v) {
      // Xevious follows this command with six bytes rather than four (the first
      // two unused), and expects joystick remapping from then on.
      case 1: io.coinCredMode = this.coinageBytes ?? 4; io.credits = 0; if (this.coinageBytes === 6) io.remapJoy = 1; break;
      case 2: io.mode = 1; io.count = 0; break;
      case 3: io.remapJoy = 0; break;
      case 4: io.remapJoy = 1; break;
      case 5: io.mode = 0; io.count = 0; break;
    }
  }

  // The 51xx answers in a cycle of three reads: credits (or raw buttons in
  // switch mode), then player 1 and player 2 controls.
  read51() {
    const io = this.io;
    const p0 = this.in0 & 0x0F, p1 = this.in0 >> 4, p2 = this.in1 & 0x0F, p3 = this.in1 >> 4;
    const step = io.count++ % 3;
    if (io.mode === 0) {
      if (step === 0) return p0 | (p1 << 4);
      if (step === 1) return p2 | (p3 << 4);
      return 0;
    }
    if (step === 0) {
      const inp = ~(p0 | (p1 << 4)) & 0xFF;
      const toggle = inp ^ io.lastCoins;
      io.lastCoins = inp;
      if (io.coinsPerCred[0] > 0) {
        if (io.credits < 99) {
          for (let s = 0; s < 2; s++) {
            if (toggle & inp & (0x10 << s)) {
              if (++io.coins[s] >= io.coinsPerCred[s]) {
                io.credits += io.credsPerCoin[s];
                io.coins[s] -= io.coinsPerCred[s];
              }
            }
          }
          if (toggle & inp & 0x40) io.credits++;          // service credit
        }
      } else io.credits = 100;                            // free play
      if (io.mode === 1) {
        if (toggle & inp & 0x04) {
          if (io.credits >= 1) { io.credits--; io.mode = 2; }
        } else if (toggle & inp & 0x08) {
          if (io.credits >= 2) { io.credits -= 2; io.mode = 2; }
        }
      }
      if (!(this.in0 & 0x80)) return 0xBB;                // test switch
      return ((io.credits / 10) | 0) * 16 + (io.credits % 10);
    }
    // Controls: direction code in the low nibble, fire in bits 4-5.
    const bit = step === 1 ? 1 : 2;
    let joy = (step === 1 ? p2 : p3) & 0x0F;
    const inp = ~p0 & 0x0F;
    const toggle = inp ^ io.lastButtons;
    io.lastButtons = (io.lastButtons & ~bit) | (inp & bit);
    if (io.remapJoy) joy = JOY_MAP[joy];
    const pressed = inp & bit ? 1 : 0, edge = toggle & inp & bit ? 1 : 0;
    return joy | ((edge ^ 1) << 4) | ((pressed ^ 1) << 5);
  }

  // The 54xx makes the explosion sounds from commands sent by the main CPU:
  // Galaga sends 10/20 when something blows up (30/40 and their data bytes set
  // the chip up at power-on). The chip's own program isn't part of the game
  // ROMs, so a burst of noise stands in.
  write54(v) {
    if (v === 0x10 || v === 0x20) this.explosion = 24;
  }

  // ---------------------------------------------------------------- inputs

  setInputs(s) {
    this.in0 = 0xFF & ~((s.fire ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0) | (s.coin ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.right ? 0x02 : 0) | (s.left ? 0x08 : 0));
  }

  // DIP switches, read by the game at power-on. A: difficulty and demo sounds
  // (other bits off, upright). B: 1 coin 1 credit, bonus 20K/70K/70K, lives.
  applySwitches(v) {
    this.dswA = 0xF4 | v.difficulty | v.demoSounds;
    this.dswB = 0x07 | 0x10 | v.lives;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const [main, sub, snd] = this.cpus;
    for (let line = 0; line < LINES; line++) {
      // The sound CPU gets an NMI twice a frame (64V) while enabled (latch 2 low).
      if ((line === 64 || line === 192) && this.subRunning && !this.latch[2]) snd.nmi();
      if (line === VBLANK_LINE) {
        if (this.latch[0]) main.irq = true;
        if (this.latch[1] && this.subRunning) sub.irq = true;
        this.render();
        this.scrollStars();
      }
      const end = main.cycles + LINE_CYCLES;
      while (main.cycles < end) {
        if (main.cycles >= this.next06Nmi) {
          main.nmi();
          this.next06Nmi += NMI_06XX_CYCLES;
        }
        main.step();
      }
      if (this.subRunning) {
        sub.run(LINE_CYCLES);
        snd.run(LINE_CYCLES);
      }
      this.wsg.line(this.explosion > 0);
    }
    if (this.explosion > 0) this.explosion--;
    this.frameCount++;
  }

  // ---------------------------------------------------------------- video

  decodeGraphics() {
    const { chars, sprites, palette, charLut, spriteLut } = this.roms;
    const bit = (rom, b) => (rom[b >> 3] >> (7 - (b & 7))) & 1;

    // 256 chars, 8x8, 2 bits per pixel; planes at bit 0 and 4 of each byte.
    this.charPix = new Uint8Array(256 * 64);
    for (let c = 0; c < 256; c++) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const o = c * 128 + y * 8 + (x < 4 ? 64 + x : x - 4);
        this.charPix[c * 64 + y * 8 + x] = (bit(chars, o) << 1) | bit(chars, o + 4);
      }
    }
    // 128 sprites, 16x16, same plane arrangement in four 4-pixel columns.
    this.spritePix = new Uint8Array(128 * 256);
    for (let s = 0; s < 128; s++) {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const o = s * 512 + (y < 8 ? y * 8 : 256 + (y - 8) * 8) + ((x >> 2) * 64) + (x & 3);
        this.spritePix[s * 256 + y * 16 + x] = (bit(sprites, o) << 1) | bit(sprites, o + 4);
      }
    }

    // 32-color palette PROM: 3 bits red, 3 green, 2 blue.
    const rgba = (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
    const level = (b0, b1, b2) => 0x21 * b0 + 0x47 * b1 + 0x97 * b2;
    this.palette = new Uint32Array(32);
    for (let i = 0; i < 32; i++) {
      const v = palette[i];
      this.palette[i] = rgba(level(v & 1, (v >> 1) & 1, (v >> 2) & 1),
        level((v >> 3) & 1, (v >> 4) & 1, (v >> 5) & 1), level(0, (v >> 6) & 1, (v >> 7) & 1));
    }
    const STAR = [0x00, 0x47, 0x97, 0xDE];
    this.starColors = new Uint32Array(64);
    for (let i = 0; i < 64; i++) this.starColors[i] = rgba(STAR[i & 3], STAR[(i >> 2) & 3], STAR[(i >> 4) & 3]);

    // Lookup PROMs pick a palette entry per color code and pen (low 4 bits;
    // some dumps have the unused top bits set). 15 is transparent.
    this.charLut = Uint8Array.from(charLut, (v) => v & 0x0F);
    this.spriteLut = Uint8Array.from(spriteLut, (v) => v & 0x0F);
  }

  scrollStars() {
    const SPEEDS = [-1, -2, -3, 0, 3, 2, 1, 0];
    const s = this.starControl;
    this.starScroll += SPEEDS[s[0] + s[1] * 2 + s[2] * 4];
  }

  render() {
    const out = this.native, ram = this.ram;
    out.fill(0xFF000000);

    // Stars: two of four sets of 63 at once, when the starfield is on.
    const sc = this.starControl;
    if (sc[5]) {
      const setA = sc[3], setB = sc[4] | 2;
      for (let i = 0; i < STARS.length; i += 4) {
        const set = STARS[i + 3];
        if (set !== setA && set !== setB) continue;
        const x = (((STARS[i] + this.starScroll) % 256) + 256) % 256 + 16;
        const y = (112 + STARS[i + 1]) % 256;
        if (y < NATIVE_H) out[y * NATIVE_W + x] = this.starColors[STARS[i + 2]];
      }
    }

    // Sprites: registers in the top 128 bytes of each work RAM.
    for (let offs = 0; offs < 0x80; offs += 2) {
      const code = ram[0x8B80 + offs] & 0x7F, color = ram[0x8B81 + offs] & 0x3F;
      const attr = ram[0x9B80 + offs];
      const flipX = attr & 1, flipY = (attr >> 1) & 1, sizeX = (attr >> 2) & 1, sizeY = (attr >> 3) & 1;
      const sx = ram[0x9381 + offs] - 40 + 0x100 * (ram[0x9B81 + offs] & 3);
      let sy = 256 - ram[0x9380 + offs] + 1 - 16 * sizeY;
      sy = (sy & 0xFF) - 32;
      for (let ty = 0; ty <= sizeY; ty++) for (let tx = 0; tx <= sizeX; tx++) {
        const tile = code + [[0, 1], [2, 3]][ty ^ (sizeY & flipY)][tx ^ (sizeX & flipX)];
        this.drawSprite(tile, color, flipX, flipY, sx + 16 * tx, sy + 16 * ty);
      }
    }

    // Tiles on top: 36x28, mapped from a 32x32 RAM layout.
    for (let row = 0; row < 28; row++) {
      for (let col = 0; col < 36; col++) {
        const r = row + 2, c = col - 2;
        const offs = (c & 0x20) ? r + ((c & 0x1F) << 5) : c + (r << 5);
        const code = ram[0x8000 + offs] & 0x7F, color = ram[0x8400 + offs] & 0x3F;
        const pix = code * 64, lut = color * 4;
        for (let y = 0; y < 8; y++) {
          let o = (row * 8 + y) * NATIVE_W + col * 8;
          for (let x = 0; x < 8; x++, o++) {
            const pen = this.charLut[lut + this.charPix[pix + y * 8 + x]];
            if (pen !== 0x0F) out[o] = this.palette[0x10 + pen];
          }
        }
      }
    }

    // Rotate to the vertical monitor (90 degrees clockwise).
    const f = this.frame;
    for (let y = 0; y < NATIVE_H; y++) {
      const dx = NATIVE_H - 1 - y;
      for (let x = 0; x < NATIVE_W; x++) f[x * SCREEN_W + dx] = out[y * NATIVE_W + x];
    }
  }

  drawSprite(tile, color, flipX, flipY, sx, sy) {
    const out = this.native, pix = tile * 256, lut = color * 4;
    for (let y = 0; y < 16; y++) {
      const py = sy + y;
      if (py < 0 || py >= NATIVE_H) continue;
      const srcY = flipY ? 15 - y : y;
      for (let x = 0; x < 16; x++) {
        const px = sx + x;
        if (px < 0 || px >= NATIVE_W) continue;
        const pen = this.spriteLut[lut + this.spritePix[pix + srcY * 16 + (flipX ? 15 - x : x)]];
        if (pen !== 0x0F) out[py * NATIVE_W + px] = this.palette[pen];
      }
    }
  }
}

Galaga.id = 'galaga';
Galaga.title = 'Galaga';
Galaga.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x00], ['3', 0x80], ['4', 0x40], ['5', 0xC0]], default: 0x80 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x03], ['Med', 0x00], ['Hard', 0x01]], default: 0x03 },
  { id: 'demoSounds', label: 'Demo sounds', options: [['On', 0x00], ['Off', 0x08]], default: 0x00 },
];
