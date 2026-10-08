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
import { decodeTiles, run } from './video.js';
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
