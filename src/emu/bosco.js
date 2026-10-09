// Namco Bosconian (1981): the Galaga board's design (three Z80s, waveform
// sound, a 51xx for coins and controls) with two 06xx bus interfaces and more
// custom chips:
//   50xx (two) keeps the players' scores and checks bonus and high scores,
//   52xx plays the digitized speech from its own ROMs,
//   54xx makes the explosion noises.
// The 50xx and 54xx are microcontrollers whose programs aren't in the game's
// ROM set, so they're stood in for here: the 50xx from its documented command
// set, the 54xx with a burst of noise as on Galaga.
//
// Video: a scrolling 32x32 playfield on the left 224 pixels, the radar and
// score panel (an 8x32 tile layer) on the right 64, six 16x16 sprites, the
// radar dots and bullets, and a starfield that scrolls in both directions.

import { Galaga, NATIVE_W, NATIVE_H } from './galaga.js';
import { STARS } from './galaga-stars.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { capture, apply } from './state.js';

const LINES = 264, LINE_CYCLES = 192, VBLANK_LINE = 224;
const NMI_06XX_CYCLES = 614;
const SPEECH_RATE = 4000;                        // 52xx playback clock (a 555 timer)

// 50xx score increments: the low nibble of an 8x-Fx command picks a step from
// one of three tables; the high nibble picks the table and a power of ten.
const STEP_A = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 500];
const STEP_B = [10, 20, 30, 40, 50, 60, 80, 100, 120, 140, 160, 180, 200, 400, 600, 1000];
const STEP_C = [15, 30, 45, 60, 75, 90, 120, 150, 180, 210, 240, 270, 300, 600, 900, 1500];
const SCORE_STEP = {
  0x8: [STEP_A, 1], 0x9: [STEP_A, 10], 0xA: [STEP_A, 100],
  0xB: [STEP_B, 1], 0xC: [STEP_B, 10], 0xD: [STEP_B, 100],
  0xE: [STEP_C, 1], 0xF: [STEP_C, 10],
};

const bcd = (bytes) => bytes.reduce((n, b) => n * 100 + (b >> 4) * 10 + (b & 15), 0);
const toBcd = (n) => ((n / 10 | 0) % 10) << 4 | (n % 10);

// The 50xx: two players' scores, the first and repeating bonus scores and the
// high score. Commands arrive one byte at a time; reading returns the current
// player's score in four BCD bytes, the first carrying flags (80 high score,
// 40 first bonus reached, 20 repeating bonus reached).
class Score50 {
  constructor() { this.reset(); }
  saveState() { return { ...this, }; }
  loadState(s) { Object.assign(this, s); }
  reset() {
    this.scores = [0, 0]; this.player = 0; this.down = false;
    this.first = 0; this.interval = 0; this.high = 0; this.nextBonus = [0, 0];
    this.flags = 0; this.args = []; this.argFor = 0; this.out = [0, 0, 0, 0]; this.outPos = 0;
  }
  write(v) {
    if (this.argFor) {
      this.args.push(v);
      if (this.args.length === 3) {
        const n = bcd(this.args);
        if (this.argFor === 2) { this.first = n; this.nextBonus = [n, n]; }
        else if (this.argFor === 3) this.interval = n;
        else if (this.argFor === 5) this.high = n;
        this.argFor = 0;
      }
      return;
    }
    const hi = v >> 4;
    if (hi === 1) { this.scores = [0, 0]; this.nextBonus = [this.first, this.first]; this.flags = 0; }
    else if (hi >= 2 && hi <= 5) { this.argFor = hi; this.args = []; }   // 4x's three bytes aren't documented: ignored
    else if (hi === 6) this.player = (v & 8) ? 1 : 0;
    else if (hi === 7) this.down = (v & 0x0F) !== 0;
    else if (hi >= 8) {
      const [table, mul] = SCORE_STEP[hi];
      const p = this.player, step = table[v & 0x0F] * mul;
      this.scores[p] = Math.max(0, Math.min(9999999, this.scores[p] + (this.down ? -step : step)));
      const s = this.scores[p];
      if (this.nextBonus[p] && s >= this.nextBonus[p]) {
        this.flags |= this.nextBonus[p] === this.first ? 0x40 : 0x20;
        this.nextBonus[p] = this.interval ? this.nextBonus[p] + this.interval : 0;
      }
      if (s > this.high) { this.high = s; this.flags |= 0x80; }
    }
  }
  // A read request: latch the current player's score for the next reads.
  request() {
    const s = this.scores[this.player];
    this.out = [(this.flags & 0xF0) | ((s / 1000000 | 0) % 10), toBcd(s / 10000 | 0), toBcd(s / 100 | 0), toBcd(s)];
    this.flags = 0;
    this.outPos = 0;
  }
  read() {
    const v = this.out[this.outPos & 3];
    this.outPos++;
    return v;
  }
}

// The 52xx: command n plays the nth stretch of 4-bit samples in the speech
// ROMs (the start addresses are tabled at the front), at 4 kHz.
class Speech52 {
  constructor(rom) { this.rom = rom; this.reset(); }
  saveState() { return { pos: this.pos, end: this.end, phase: this.phase, hp: this.hp, hpIn: this.hpIn, lp: this.lp }; }
  loadState(s) { Object.assign(this, s); }
  reset() { this.pos = this.end = 0; this.phase = 0; this.hp = this.hpIn = this.lp = 0; }
  play(n) {
    n &= 0x0F;
    if (!n) return;
    const r = this.rom, at = (i) => r[i] | (r[i + 0x10] << 8);
    this.pos = at(n - 1) * 2;                         // in nibbles
    this.end = Math.min(at(n), r.length) * 2;
    this.phase = 0;
  }
  // One 48 kHz output sample.
  next() {
    let x = 0;
    if (this.pos < this.end) {
      const b = this.rom[this.pos >> 1];
      x = (((this.pos & 1) ? b >> 4 : b) & 0x0F) - 8;
      this.phase += SPEECH_RATE / 48000;
      if (this.phase >= 1) { this.phase -= 1; this.pos++; }
    }
    // Band-limit roughly as the board does (high-pass ~80 Hz, low-pass ~2.4 kHz).
    this.hp = 0.99 * (this.hp + x - this.hpIn); this.hpIn = x;
    this.lp += (this.hp - this.lp) * 0.27;
    return this.lp * 0.06;
  }
}

export class Bosconian extends Galaga {
  constructor(roms) {
    super(roms);
    this.controls = 'eight-way';
    this.score = [new Score50(), new Score50()];
    this.speech = new Speech52(roms.speech);
    this.wsg.extra = () => this.speech.next();
    this.front = new Uint8Array(NATIVE_W * NATIVE_H);
    // A horizontal game: the picture is shown as generated.
    this.width = NATIVE_W;
    this.height = NATIVE_H;
    this.frame = this.native;
    this.reset();
  }

  reset() {
    super.reset();
    if (!this.score) return;                    // first call comes from Galaga's constructor
    this.score.forEach((s) => s.reset());
    this.speech.reset();
    this.cmd06b = 0x10;
    this.next06bNmi = Infinity;
    this.radarAttr = new Uint8Array(16);
    this.scroll = [0, 0];
    this.starCtl = 0;
    this.starBlink = [0, 0];
    this.starPos = [0, 0];
  }

  saveState() {
    return {
      ...super.saveState(), ramB: this.ram.slice(0x7800, 0x8000),
      ...capture(this, ['cmd06b', 'next06bNmi', 'radarAttr', 'scroll', 'starCtl', 'starBlink', 'starPos', 'score', 'speech']),
    };
  }
  loadState(s) {
    super.loadState(s);
    this.ram.set(s.ramB, 0x7800);
    apply(this, ['cmd06b', 'next06bNmi', 'radarAttr', 'scroll', 'starCtl', 'starBlink', 'starPos', 'score', 'speech'], s);
  }

  // ---------------------------------------------------------------- bus

  read(cpu, a) {
    if (a < 0x4000) return super.read(cpu, a);
    if (a >= 0x7800 && a < 0x9000) return this.ram[a];
    if (a >= 0x9000 && a < 0x9100) return this.read06b();
    if (a === 0x9100) return this.cmd06b;
    return super.read(cpu, a);                   // switches, 06xx #0
  }

  write(cpu, a, v) {
    if (a >= 0x7800 && a < 0x9000) { this.ram[a] = v; return; }
    if (a >= 0x9000 && a < 0x9100) { this.write06b(v); return; }
    if (a === 0x9100) { this.control06b(v); return; }
    if (a >= 0x9800 && a < 0x9810) { this.radarAttr[a & 0x0F] = v; return; }
    switch (a) {
      case 0x9810: this.scroll[0] = v; return;
      case 0x9820: this.scroll[1] = v; return;
      case 0x9830: this.starCtl = v; return;
      case 0x9874: case 0x9875: this.starBlink[a & 1] = v & 1; return;
    }
    if (a >= 0x6800 && a < 0x6828) super.write(cpu, a, v);   // sound, latches
    else if (a >= 0x7000 && a <= 0x7100) super.write(cpu, a, v);   // 06xx #0
  }

  // 06xx #0 (main CPU): 51xx, (none), 50xx, 54xx.
  control06(v) {
    super.control06(v);
    if ((v & 0x10) && (v & 0x0F) === 0x4) this.score[0].request();
  }
  read06() {
    if (!(this.cmd06 & 0x10)) return 0;
    switch (this.cmd06 & 0x0F) {
      case 0x1: return this.read51();
      case 0x4: return this.score[0].read();
      default: return 0xFF;
    }
  }
  write06(v) {
    if (this.cmd06 & 0x10) return;
    switch (this.cmd06 & 0x0F) {
      case 0x1: this.write51(v); break;
      case 0x4: this.score[0].write(v); break;
      case 0x8: this.write54(v); break;
    }
  }
  // The 54xx stand-in: Bosconian sends 50 for each shot and 60/70 for
  // explosions (20-40 and their data bytes set the chip up at power-on).
  write54(v) {
    if (v === 0x50) this.explosion = Math.max(this.explosion, 3);
    else if (v === 0x60 || v === 0x70) this.explosion = 24;
  }

  // 06xx #1 (sub CPU): 50xx, 52xx.
  control06b(v) {
    this.cmd06b = v;
    this.next06bNmi = (v & 0x0F) ? this.cpus[1].cycles + NMI_06XX_CYCLES : Infinity;
    if ((v & 0x10) && (v & 0x0F) === 0x1) this.score[1].request();
  }
  read06b() {
    if (!(this.cmd06b & 0x10)) return 0;
    return (this.cmd06b & 0x0F) === 0x1 ? this.score[1].read() : 0xFF;
  }
  write06b(v) {
    if (this.cmd06b & 0x10) return;
    if ((this.cmd06b & 0x0F) === 0x1) this.score[1].write(v);
    else if ((this.cmd06b & 0x0F) === 0x2) this.speech.play(v);
  }

  // ---------------------------------------------------------------- inputs

  // IN1: up, right, down, left.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.fire ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0) | (s.coin ? 0x10 : 0));
    this.in1 = 0xFF & ~((s.up ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.down ? 0x04 : 0) | (s.left ? 0x08 : 0));
  }

  // A: difficulty, demo sounds, freeze off, continues, upright.
  // B: 1 coin 1 credit, bonus fighter, lives.
  applySwitches(v) {
    this.dswA = 0xF4 | v.difficulty | v.demoSounds;
    this.dswB = 0x07 | v.bonus | v.lives;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const [main, sub, snd] = this.cpus;
    for (let line = 0; line < LINES; line++) {
      if ((line === 64 || line === 192) && this.subRunning && !this.latch[2]) snd.nmi();
      if (line === VBLANK_LINE) {
        if (this.latch[0]) main.irq = true;
        if (this.latch[1] && this.subRunning) sub.irq = true;
        this.render();
        this.moveStars();
      }
      const end = main.cycles + LINE_CYCLES;
      while (main.cycles < end) {
        if (main.cycles >= this.next06Nmi) { main.nmi(); this.next06Nmi += NMI_06XX_CYCLES; }
        main.step();
      }
      if (this.subRunning) {
        const subEnd = sub.cycles + LINE_CYCLES;
        while (sub.cycles < subEnd) {
          if (sub.cycles >= this.next06bNmi) { sub.nmi(); this.next06bNmi += NMI_06XX_CYCLES; }
          sub.step();
        }
        snd.run(LINE_CYCLES);
      }
      this.wsg.line(this.explosion > 0);
    }
    if (this.explosion > 0) this.explosion--;
    this.frameCount++;
  }

  moveStars() {
    const DX = [-1, -2, -3, 0, 3, 2, 1, 0], DY = [0, -1, -2, -3, 0, 3, 2, 1];
    this.starPos[0] = (this.starPos[0] + DX[this.starCtl & 7]) & 0xFF;
    this.starPos[1] = (this.starPos[1] + DY[(this.starCtl >> 3) & 7]) & 0xFF;
  }

  // ---------------------------------------------------------------- video

  decodeGraphics() {
    super.decodeGraphics();                      // chars, palette, star colors (as Galaga)
    const { sprites, dots } = this.roms;
    // Sprites: the four 4-pixel columns are stored in the order 1, 2, 3, 0.
    this.spritePix = decodeTiles(sprites, {
      count: sprites.length / 64, width: 16, height: 16, planes: [0, 4],
      xs: [...run(64, 4), ...run(128, 4), ...run(192, 4), ...run(0, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
    // Radar dots: eight 4x4 shapes, 3 bits a pixel (bit 2 = see-through).
    this.dotPix = decodeTiles(dots, {
      count: 8, width: 4, height: 4, planes: [5, 6, 7], xs: run(0, 4, 8), ys: run(0, 4, 32), size: 128,
    });
    // One lookup PROM serves both tiles (palette 16-31) and sprites (0-15).
    this.charLut = Uint8Array.from(this.roms.charLut, (v) => v & 0x0F);
    this.spriteLut = this.charLut;
  }

  render() {
    const out = this.native, front = this.front, ram = this.ram, pal = this.palette;
    out.fill(0xFF000000);
    front.fill(0);

    // Stars, behind everything.
    const setA = this.starBlink[0], setB = this.starBlink[1] | 2;
    for (let i = 0; i < STARS.length; i += 4) {
      const set = STARS[i + 3];
      if (set !== setA && set !== setB) continue;
      const x = (STARS[i] + this.starPos[0]) & 0xFF, y = (STARS[i + 1] + this.starPos[1]) & 0xFF;
      if (x < 224 && y >= 16 && y < 224) out[(y - 16) * NATIVE_W + x] = this.starColors[STARS[i + 2]];
    }

    // Tiles: the playfield (codes 8400, attributes 8C00) scrolled into x 0-223,
    // the radar panel (codes 8000, attributes 8800; 8 columns) at x 224-287.
    // Color 15 of the lookup is see-through; attribute bit 5 puts a tile in
    // front of the sprites.
    const lut = this.charLut, chars = this.charPix;
    for (let y = 0; y < NATIVE_H; y++) {
      const ry = y + 16;
      for (let x = 0; x < NATIVE_W; x++) {
        let i, tx, ty;
        if (x < 224) {
          tx = (x + this.scroll[0] + 3) & 0xFF; ty = (ry + this.scroll[1]) & 0xFF;
          i = 0x400 + (ty >> 3) * 32 + (tx >> 3);
        } else {
          tx = x & 63; ty = ry;
          i = (ty >> 3) * 32 + (tx >> 3);
        }
        const attr = ram[0x8800 + i];
        const fx = attr & 0x40 ? tx & 7 : 7 - (tx & 7), fy = attr & 0x80 ? 7 - (ty & 7) : ty & 7;
        const c = lut[(attr & 0x3F) * 4 + chars[ram[0x8000 + i] * 64 + fy * 8 + fx]];
        if (c === 0x0F) continue;
        const o = y * NATIVE_W + x;
        out[o] = pal[0x10 + c];
        if (attr & 0x20) front[o] = 1;
      }
    }

    // Sprites: registers at 83D4-83DF and 8BD4-8BDF.
    for (let offs = 0; offs < 12; offs += 2) {
      const a = ram[0x83D4 + offs], b = ram[0x83D5 + offs], c = ram[0x8BD4 + offs], d = ram[0x8BD5 + offs];
      const code = a >> 2, flipX = a & 1, flipY = a & 2, color = (d & 0x3F) * 4;
      const sx = b - 1, sy = 240 - c - 16;
      for (let y = 0; y < 16; y++) {
        const py = sy + y;
        if (py < 0 || py >= NATIVE_H) continue;
        const src = code * 256 + (flipY ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x;
          if (px < 0 || px >= NATIVE_W) continue;
          const v = this.spriteLut[color + this.spritePix[src + (flipX ? 15 - x : x)]];
          const o = py * NATIVE_W + px;
          if (v !== 0x0F && !front[o]) out[o] = pal[v];
        }
      }
    }

    // Radar dots and bullets: positions at 83F4-83FF / 8BF4-8BFF, shapes and
    // the x high bit in the attribute latches (9804-980F). Colors 28-31.
    for (let offs = 4; offs < 16; offs++) {
      const attr = this.radarAttr[offs];
      const x = ram[0x83F0 + offs] + ((~attr & 1) << 8), y = 253 - ram[0x8BF0 + offs] - 16;
      const shape = ((attr & 0x0E) >> 1) ^ 7;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        const pen = this.dotPix[shape * 16 + dy * 4 + dx], px = x + dx, py = y + dy;
        if (pen & 4 || px >= NATIVE_W || py < 0 || py >= NATIVE_H) continue;
        out[py * NATIVE_W + px] = pal[31 - pen];
      }
    }
  }
}

Bosconian.id = 'bosco';
Bosconian.title = 'Bosconian';
Bosconian.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x00], ['2', 0x40], ['3', 0x80], ['5', 0xC0]], default: 0x80 },
  { id: 'bonus', label: 'Bonus', options: [['10K/50K', 0x08], ['15K/50K', 0x10], ['15K/70K', 0x18], ['20K/70K', 0x20], ['30K/100K', 0x28], ['None', 0x00]], default: 0x08 },
  { id: 'difficulty', label: 'Difficulty', options: [['Medium', 0x03], ['Easy', 0x02], ['Hard', 0x01], ['Hardest', 0x00]], default: 0x03 },
  { id: 'demoSounds', label: 'Demo sounds', options: [['On', 0x00], ['Off', 0x08]], default: 0x00 },
];

// ---------------------------------------------------------------- Xevious

// Namco Xevious (1982): the same three-CPU board family, with one 06xx (51xx,
// 50xx, 54xx as on Bosconian's first one), two 64x32 tile layers (a 2-bit
// background and 1-bit text) that scroll independently, 3-bit sprites in four
// sizes, a 128-color palette from three PROMs, and a background-map reader:
// the game writes coordinates to F000-F001 and reads the terrain's tile and
// attribute back from three ROMs.
export class Xevious extends Bosconian {
  constructor(roms) {
    super({ ...roms, sprites: new Uint8Array(0), dots: new Uint8Array(256), charLut: new Uint8Array(256), palette: new Uint8Array(32) });
    this.roms = roms;
    this.coinageBytes = 6;
    this.buttons = 2;
    this.button2 = 'Blaster';
    this.width = 224;
    this.height = 288;
    this.frame = new Uint32Array(224 * 288);
    this.decodeXevious(roms);
  }

  reset() {
    super.reset();
    this.scrollRegs = new Uint16Array(4);       // bg x, fg x, bg y, fg y
    this.bs = [0, 0];
  }
  // A000-CFFF (sprite registers, both tile layers) beyond what Galaga's RAM covers.
  saveState() { return { ...super.saveState(), ramX: this.ram.slice(0xA000, 0xD000), scrollRegs: this.scrollRegs.slice(), bs: this.bs.slice() }; }
  loadState(s) { super.loadState(s); this.ram.set(s.ramX, 0xA000); this.scrollRegs.set(s.scrollRegs); this.bs = s.bs.slice(); }

  decodeGraphics() {}                           // see decodeXevious

  decodeXevious(roms) {
    const level = (v) => 0x0E * (v & 1) + 0x1F * ((v >> 1) & 1) + 0x43 * ((v >> 2) & 1) + 0x8F * ((v >> 3) & 1);
    this.xpal = Uint32Array.from({ length: 129 }, (_, i) => (i < 128 ? rgba(level(roms.red[i]), level(roms.green[i]), level(roms.blue[i])) : 0xFF000000));
    // Lookups: two 4-bit PROMs side by side. Sprite entries without bit 7 are see-through.
    this.bgLut = Uint8Array.from({ length: 512 }, (_, i) => (roms.bgLutLo[i] & 15) | ((roms.bgLutHi[i] & 15) << 4));
    this.spLut = Uint16Array.from({ length: 512 }, (_, i) => {
      const c = (roms.spLutLo[i] & 15) | ((roms.spLutHi[i] & 15) << 4);
      return c & 0x80 ? c & 0x7F : 0x100;
    });
    this.fgPix = decodeTiles(roms.fg, { count: 512, width: 8, height: 8, planes: [0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    this.bgPix = decodeTiles(roms.bg, { count: 512, width: 8, height: 8, planes: [0, 0x8000], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    // Sprites: sets 1-3 with planes 0/1 packed in nibbles, plus a third plane
    // whose ROM holds two sets (high and low nibbles).
    const g = new Uint8Array(0xA000);
    g.set(roms.sp15, 0); g.set(roms.sp17, 0x2000); g.set(roms.sp16, 0x4000); g.set(roms.sp18, 0x5000);
    for (let i = 0; i < 0x2000; i++) g[0x7000 + i] = roms.sp18[i] >> 4;
    this.xSpritePix = decodeTiles(g, {
      count: 320, width: 16, height: 16, planes: [0x5000 * 8 + 4, 0, 4],
      xs: [...run(0, 4), ...run(64, 4), ...run(128, 4), ...run(192, 4)], ys: [...run(0, 8, 8), ...run(256, 8, 8)], size: 512,
    });
  }

  // ---------------------------------------------------------------- bus

  read(cpu, a) {
    if (a >= 0x7800 && a < 0xD000) return this.ram[a];
    if (a >= 0xF000) return this.terrain(a & 1);
    if (a < 0x7800) return super.read(cpu, a);
    return 0xFF;
  }

  write(cpu, a, v) {
    if (a >= 0x7800 && a < 0xD000) { this.ram[a] = v; return; }
    if (a >= 0xD000 && a < 0xD080) {
      const reg = (a >> 4) & 7;
      if (reg < 4) this.scrollRegs[reg] = v | ((a & 1) << 8);
      return;
    }
    if (a >= 0xF000) { this.bs[a & 1] = v; return; }
    if (a < 0x7800) super.write(cpu, a, v);
  }

  // The background map: 2A/2B give a 12-bit block number for the coordinates,
  // 2C the tile (BB0) and attribute (BB1) within the block, with the block's
  // flips applied.
  terrain(which) {
    const map = this.roms.bgMap, bs = this.bs;
    const a2b = ((bs[1] & 0x7E) << 6) | ((bs[0] & 0xFE) >> 1);
    const hi = map[a2b >> 1];
    const block = ((a2b & 1 ? hi & 0xF0 : (hi & 0x0F) << 4) << 4) | map[0x1000 + a2b];
    let a2c = ((block & 0x1FF) << 2) | ((bs[1] & 1) << 1) | (bs[0] & 1);
    if (block & 0x400) a2c ^= 1;
    if (block & 0x200) a2c ^= 2;
    if (which) return map[0x3000 + (a2c | 0x800)];
    let d = map[0x3000 + a2c];
    d = (d & 0x3F) | ((d & 0x40) << 1) | ((d & 0x80) >> 1);      // swap bits 6 and 7
    if (block & 0x400) d ^= 0x40;
    if (block & 0x200) d ^= 0x80;
    return d;
  }

  // ---------------------------------------------------------------- inputs

  // As Bosconian, plus the Blaster (bombs), read through switch bank B.
  setInputs(s) {
    super.setInputs(s);
    this.dswB = (this.dswB & 0xFE) | (s.fire2 ? 0 : 1);
  }
  applySwitches(v) {
    this.dswA = 0x9F | v.lives;                  // 1 coin 1 credit, bonus 20K/60K, upright
    this.dswB = 0x9F | v.difficulty;             // flags award bonus, freeze off
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, ram = this.ram, pal = this.xpal, W = NATIVE_W;
    const [bgX, fgX, bgY, fgY] = this.scrollRegs;

    // Background: codes C800, attributes B800 (color, bank, flips). The scroll
    // registers add to the screen position; each layer also has a fixed offset.
    for (let y = 0; y < NATIVE_H; y++) {
      const ty = (y + bgY + 16) & 0xFF;
      for (let x = 0; x < W; x++) {
        const tx = (x + bgX + 20) & 0x1FF;
        const i = (ty >> 3) * 64 + (tx >> 3), code = ram[0xC800 + i], attr = ram[0xB800 + i];
        const color = ((attr & 0x3C) >> 2) | ((code & 0x80) >> 3) | ((attr & 3) << 5);
        const px = attr & 0x40 ? 7 - (tx & 7) : tx & 7, py = attr & 0x80 ? 7 - (ty & 7) : ty & 7;
        const v = this.bgLut[color * 4 + this.bgPix[(code + ((attr & 1) << 8)) * 64 + py * 8 + px]];
        out[y * W + x] = pal[v & 0x80 ? 128 : v];
      }
    }

    // Sprites: registers in the top of the three work RAMs.
    for (let offs = 0; offs < 0x80; offs += 2) {
      const s1 = ram[0xA780 + offs], s1b = ram[0xA781 + offs];
      if (s1b & 0x40) continue;
      const s2 = ram[0x8780 + offs], s2b = ram[0x8781 + offs], s3 = ram[0x9780 + offs], s3b = ram[0x9781 + offs];
      let code = s3 & 0x80 ? (s1 & 0x3F) + 0x100 : s1;
      const color = (s1b & 0x3F) * 8, flipX = s3 & 4, flipY = s3 & 8;
      const sx = s2b - 40 + 0x100 * (s3b & 1), sy = 28 * 8 - s2 - 1;
      const draw = (c, x, y) => this.drawXSprite(c, color, flipX, flipY, x, y);
      if (s3 & 2) {
        if (s3 & 1) {
          code &= ~3;
          draw(code + 3, flipX ? sx : sx + 16, flipY ? sy - 16 : sy);
          draw(code + 1, flipX ? sx : sx + 16, flipY ? sy : sy - 16);
        }
        code &= ~2;
        draw(code + 2, flipX ? sx + 16 : sx, flipY ? sy - 16 : sy);
        draw(code, flipX ? sx + 16 : sx, flipY ? sy : sy - 16);
      } else if (s3 & 1) {
        code &= ~1;
        draw(code, flipX ? sx + 16 : sx, flipY ? sy - 16 : sy);
        draw(code + 1, flipX ? sx : sx + 16, flipY ? sy - 16 : sy);
      } else draw(code, sx, sy);
    }

    // Text: codes C000, attributes B000; pen 1 takes the color directly.
    for (let y = 0; y < NATIVE_H; y++) {
      const ty = (y + fgY + 18) & 0xFF;
      for (let x = 0; x < W; x++) {
        const tx = (x + fgX + 32) & 0x1FF;
        const i = (ty >> 3) * 64 + (tx >> 3), attr = ram[0xB000 + i];
        const px = attr & 0x40 ? 7 - (tx & 7) : tx & 7, py = attr & 0x80 ? 7 - (ty & 7) : ty & 7;
        if (this.fgPix[ram[0xC000 + i] * 64 + py * 8 + px]) out[y * W + x] = pal[((attr & 3) << 4) | ((attr & 0x3C) >> 2)];
      }
    }
    rotate90(out, W, NATIVE_H, this.frame);
  }

  drawXSprite(code, color, flipX, flipY, sx, sy) {
    const out = this.native, pix = (code % 320) * 256;
    for (let y = 0; y < 16; y++) {
      const py = sy + y;
      if (py < 0 || py >= NATIVE_H) continue;
      const src = pix + (flipY ? 15 - y : y) * 16;
      for (let x = 0; x < 16; x++) {
        const px = sx + x;
        if (px < 0 || px >= NATIVE_W) continue;
        const v = this.spLut[color + this.xSpritePix[src + (flipX ? 15 - x : x)]];
        if (v < 0x100) out[py * NATIVE_W + px] = this.xpal[v];
      }
    }
  }
}
Xevious.id = 'xevious';
Xevious.stateVersion = 2;                       // saves from before the 51xx setup fix restore broken controls
Xevious.title = 'Xevious';
Xevious.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x40], ['2', 0x20], ['3', 0x60], ['5', 0x00]], default: 0x60 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x40], ['Normal', 0x60], ['Hard', 0x20], ['Hardest', 0x00]], default: 0x60 },
];
