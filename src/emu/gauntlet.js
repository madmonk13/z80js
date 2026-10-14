// Atari Gauntlet (1985): a 68010 at 7.16 MHz and a 6502 at 1.79 MHz for
// sound (YM2151, POKEY, and a TMS5220 for the narrator), up to four players.
//
// Video: a 64x64 playfield of 8x8 tiles at 4 bits per pixel (scrolling, with
// a tile bank), 1024 motion objects of up to 8x8 tiles in linked lists (a
// "SLIP" table gives the first object for each 8-line band), and a 64x32
// text layer on top. Motion-object pen 1 darkens the playfield under it
// instead of drawing. 1024 colors of 4 bits plus an intensity. 336x240.
//
// Part of the program ROM (38000-3FFFF) sits behind a slapstic: a chip that
// switches which 8K bank appears there when the program touches particular
// address sequences, so the code can't be copied without it.
//
// Each player has a stick, Fire and Magic (which is also that player's
// start) and a coin slot of their own.

import { M68000 } from './m68000.js';
import { CPU6502 } from './m6502.js';
import { YM2151 } from './ym2151.js';
import { Pokey, PokeyVoice } from './pokey.js';
import { TMS5220 } from './tms5220.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { capture, apply } from './state.js';

const W = 336, H = 240, LINES = 262, REFRESH = 14318180 / 2 / 456 / LINES;
const MAIN_CLOCK = 14318180 / 2, SOUND_CLOCK = 14318180 / 8, SUBSLICES = 4;
const STATE = ['ram', 'eeprom', 'pf', 'mo', 'spare', 'alpha', 'pal', 'xscroll', 'yscroll', 'line', 'videoInt', 'soundInt',
  'eepromUnlocked', 'soundReset', 'toSound', 'toSoundReady', 'toMain', 'toMainReady', 'timedInt', 'speechVal', 'lastSpeech',
  'squeak', 'mixer', 'bootFilter', 'soundRam', 'slap', 'in', 'coins', 'slot', 'joinTimer', 'cycleCarry', 'soundCarry', 'sampleCarry',
  'speechCarry', 'cpu', 'snd', 'sound'];

// The slapstic 137412-104's address patterns (word offsets in its 16K window): [mask, value].
const SLAP = {
  bankStart: 3, banks: [0x20, 0x28, 0x30, 0x38],
  alt1: [0x007F, 0x0069], alt2: [0x3FFF, 0x3735], alt3: [0x3FFC, 0x3764], alt4: [0x3FE7, 0x0020],
  bit1: [0x3FF0, 0x3D90], bit2c0: [0x3FF3, 0x3D90], bit2s0: [0x3FF3, 0x3D91], bit2c1: [0x3FF3, 0x3D92], bit2s1: [0x3FF3, 0x3D93], bit3: [0x3FF8, 0x3DA0],
};
const DISABLED = 0, ENABLED = 1, ALT1 = 2, ALT2 = 3, ALT3 = 4, BIT1 = 5, BIT2 = 6, BIT3 = 7;
const is = (v, [mask, value]) => (v & mask) === value;

// A sound chip's output scaled by the board's mixer setting.
class Level {
  constructor(voice, level) { this.voice = voice; this.level = level; this.out = 0; }
  reset() { this.voice.reset(); }
  saveState() { return this.voice.saveState(); }
  loadState(s) { this.voice.loadState(s); }
  sample() { this.voice.sample(); this.out = this.voice.out * this.level(); }
}

export class Gauntlet {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 1024; i++) this.setColor(i); }

  // roms: { main (0x80000), sound (0x10000), alpha (2-bit text tiles), tiles (the playfield / motion object planes) }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Magic';
    this.startLabels = ['Warrior', 'Valkyrie', 'Wizard', 'Elf'];
    this.startsCoin = true;
    this.roms = roms;
    this.ram = new Uint16Array(0x1000);        // 800000-801FFF
    this.eeprom = new Uint8Array(0x800);       // 802000-802FFF, the low byte of each word
    this.nvram = this.eeprom;
    this.pf = new Uint16Array(0x1000);         // 900000-901FFF
    this.mo = new Uint16Array(0x1000);         // 902000-903FFF: four 1024-word tables
    this.spare = new Uint16Array(0x800);       // 904000-904FFF
    this.alpha = new Uint16Array(0x800);       // 905000-905FFF (includes the y scroll and SLIP table)
    this.pal = new Uint16Array(0x400);         // 910000-9107FF
    this.soundRam = new Uint8Array(0x1000);
    this.palette = new Uint32Array(1024).fill(0xFF000000);
    this.slap = new Int32Array(5);             // state, bank, alt bank, bit bank, bit xor
    this.eeprom.fill(0xFF);

    const q = roms.tiles.length / 4 * 8;
    this.tilePix = decodeTiles(roms.tiles, { count: roms.tiles.length / 32, width: 8, height: 8, planes: [3 * q, 2 * q, q, 0], xs: run(0, 8), ys: run(0, 8, 8), size: 64 });
    this.tileCount = roms.tiles.length / 32;
    this.alphaPix = decodeTiles(roms.alpha, { count: roms.alpha.length / 16, width: 8, height: 8, planes: [4, 0], xs: [0, 1, 2, 3, 8, 9, 10, 11], ys: run(0, 8, 16), size: 128 });
    this.alphaCount = roms.alpha.length / 16;

    this.cpu = new M68000({
      read8: (a) => this.read8(a), read16: (a) => this.read16(a),
      write8: (a, v) => this.write8(a, v), write16: (a, v) => this.write16(a, v),
    });
    this.cpu.onIrqAck = () => {};               // the lines stay up until the board acknowledges them
    this.snd = new CPU6502({ read: (a) => this.sndRead(a), write: (a, v) => this.sndWrite(a, v) });
    this.ym = new YM2151(14318180 / 4, 0.5);
    this.pokey = new Pokey(SOUND_CLOCK, 2);
    this.speech = new TMS5220(0.9);
    const lv = (bits, max, shift) => () => ((this.mixer >> shift) & bits) / max;
    this.sound = new SoundMix([new Level(this.ym, lv(7, 7, 0)), new Level(new PokeyVoice(this.pokey), lv(3, 3, 3)),
      new Level(this.speech, lv(7, 7, 5))], 1);
    this.frame = new Uint32Array(W * H);
    this.idx = new Uint16Array(W * H);
    this.in = new Uint8Array(4).fill(0xFF);
    this.coins = 0x0F;
    this.slot = 0;
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.pf, this.mo, this.spare, this.alpha, this.pal, this.soundRam]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.xscroll = 0; this.yscroll = 0; this.line = 0;
    this.videoInt = 0; this.soundInt = 0; this.eepromUnlocked = 0; this.soundReset = 1;
    this.toSound = 0; this.toSoundReady = 0; this.toMain = 0; this.toMainReady = 0; this.timedInt = 0;
    this.speechVal = 0; this.lastSpeech = 0x80; this.bootFilter = 1; this.squeak = 0; this.mixer = 0xFF; this.joinTimer = 0;
    this.slap.fill(0); this.slap[0] = DISABLED; this.slap[1] = SLAP.bankStart;
    this.cycleCarry = this.soundCarry = this.sampleCarry = this.speechCarry = 0;
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
  }

  // IIIIRRRRGGGGBBBB: an intensity scales the 4-bit guns.
  setColor(i) {
    const v = this.pal[i], z = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17][v >> 12];
    this.palette[i] = rgba(((v >> 8) & 15) * z, ((v >> 4) & 15) * z, (v & 15) * z);
  }

  updateIrq() { this.cpu.irq = this.soundInt ? 6 : this.videoInt ? 4 : 0; }

  // ---------------------------------------------------------------- slapstic

  // The chip watches each access (word offset o in its window) and may switch banks.
  slapTweak(o) {
    const s = this.slap;
    if (o === 0) { s[0] = ENABLED; return; }
    const bankHit = SLAP.banks.indexOf(o);
    switch (s[0]) {
      case ENABLED:
        if (is(o, SLAP.bit1)) s[0] = BIT1;
        else if (is(o, SLAP.alt1)) s[0] = ALT1;
        else if (is(o, SLAP.alt2)) s[0] = this.altKludge();
        else if (bankHit >= 0) { s[0] = DISABLED; s[1] = bankHit; }
        break;
      case ALT1: s[0] = is(o, SLAP.alt2) ? ALT2 : ENABLED; break;
      case ALT2:
        if (is(o, SLAP.alt3)) { s[0] = ALT3; s[2] = o & 3; } else s[0] = ENABLED;
        break;
      case ALT3: if (is(o, SLAP.alt4)) { s[0] = DISABLED; s[1] = s[2]; } break;
      case BIT1: if (bankHit >= 0) { s[0] = BIT2; s[3] = s[1]; s[4] = 0; } break;
      case BIT2:
        if (is(o ^ s[4], SLAP.bit2c0)) { s[3] &= ~1; s[4] ^= 3; }
        else if (is(o ^ s[4], SLAP.bit2s0)) { s[3] |= 1; s[4] ^= 3; }
        else if (is(o ^ s[4], SLAP.bit2c1)) { s[3] &= ~2; s[4] ^= 3; }
        else if (is(o ^ s[4], SLAP.bit2s1)) { s[3] |= 2; s[4] ^= 3; }
        else if (is(o, SLAP.bit3)) s[0] = BIT3;
        break;
      case BIT3: if (bankHit >= 0) { s[0] = DISABLED; s[1] = s[3]; } break;
    }
  }
  // The first step of an "alternate" switch is usually an opcode fetch that's
  // gone by: catch it from a MOVE.W (An),(An) / CMPM.W whose second operand completes the sequence.
  altKludge() {
    const pc = this.cpu.opPc;
    if (is(((pc + 2) >> 1) & 0x3FFF, SLAP.alt1)) {
      const op = this.read16Raw(pc & 0xFFFFFF);
      if ((op & 0xF1F8) === 0x3090 || (op & 0xF1F8) === 0xB148) {
        const reg = (this.cpu.a[(op >> 9) & 7] >>> 1) & 0x3FFF;
        if (is(reg, SLAP.alt3)) { this.slap[2] = reg & 3; return ALT3; }
      }
    }
    return ENABLED;
  }
  read16Raw(a) { const r = this.roms.main; return (r[a] << 8) | r[a + 1]; }

  // ---------------------------------------------------------------- main CPU

  // ROM at 000000 (mirrored); MBUS (RAM, EEPROM, I/O) at 800000 and VBUS (video) at 900000, each
  // mirrored through A00000-BFFFF by the unused address bits.
  read16(a) {
    a &= 0xFFFFFF;
    if (a < 0x800000) {
      a &= 0x7FFFF;
      if (a >= 0x38000 && a < 0x40000) {          // the slapstic window: read the bank, then let the chip watch
        const o = (a - 0x38000) >> 1, v = this.read16Raw(0x38000 + this.slap[1] * 0x2000 + ((o & 0xFFF) << 1));
        this.slapTweak(o);
        return v;
      }
      return this.read16Raw(a);
    }
    if (a >= 0xC00000) return 0xFFFF;
    if (!(a & 0x100000)) {                        // MBUS
      const m = a & 0x3FFF;
      if (m < 0x2000) return this.ram[m >> 1];
      if (m < 0x3000) return this.eeprom[(m - 0x2000) >> 1] | 0xFF00;
      switch (m & 0x310E) {
        case 0x3000: return 0xFF00 | this.in[0];
        case 0x3002: return 0xFF00 | this.in[1];
        case 0x3004: return 0xFF00 | this.in[2];
        case 0x3006: return 0xFF00 | this.in[3];
        case 0x3008: return 0xFF80 | (this.line >= H ? 0 : 0x40) | (this.toSoundReady ? 0x20 : 0) | (this.toMainReady ? 0x10 : 0) | 0x08;
        case 0x300E:
          this.toMainReady = 0; this.soundInt = 0; this.updateIrq();
          return 0xFF00 | this.toMain;
      }
      return 0xFFFF;
    }
    const v = a & 0x37FFF;                        // VBUS
    if (v >= 0x10000) return v < 0x20000 ? this.pal[(v & 0x7FF) >> 1] : 0xFFFF;
    if (v < 0x2000) return this.pf[v >> 1];
    if (v < 0x4000) return this.mo[(v - 0x2000) >> 1];
    if (v < 0x5000) return this.spare[(v - 0x4000) >> 1];
    if (v < 0x6000) return this.alpha[(v - 0x5000) >> 1];
    return 0xFFFF;
  }
  read8(a) { const w = this.read16(a & ~1); return a & 1 ? w & 0xFF : w >> 8; }

  write16(a, v) { this.write(a & ~1, v, 0xFFFF); }
  write8(a, v) { if (a & 1) this.write(a & ~1, v & 0xFF, 0x00FF); else this.write(a, (v & 0xFF) << 8, 0xFF00); }

  write(a, v, m) {
    a &= 0xFFFFFF;
    const merge = (old) => (old & ~m) | (v & m);
    if (a < 0x800000) { a &= 0x7FFFF; if (a >= 0x38000 && a < 0x40000) this.slapTweak((a - 0x38000) >> 1); return; }
    if (a >= 0xC00000) return;
    if (!(a & 0x100000)) {                        // MBUS
      const mm = a & 0x3FFF;
      if (mm < 0x2000) { this.ram[mm >> 1] = merge(this.ram[mm >> 1]); return; }
      if (mm < 0x3000) { if (this.eepromUnlocked && (m & 0xFF)) this.eeprom[(mm - 0x2000) >> 1] = v & 0xFF; this.eepromUnlocked = 0; return; }
      switch (mm & 0x3170) {
        case 0x3120: {                            // sound CPU reset line (bit 0 low holds it)
          if (m & 0xFF) {
            const old = this.soundReset;
            this.soundReset = v & 1;
            if ((old ^ this.soundReset) & 1) {
              // (A command NMI raised while the 6502 was held isn't seen: it finds the command by polling.)
              this.snd.reset(); this.snd.nmiPending = false; this.bootFilter = 1;
              this.toMainReady = 0; this.soundInt = 0; this.updateIrq();
            }
          }
          return;
        }
        case 0x3140: this.videoInt = 0; this.updateIrq(); return;
        case 0x3150: this.eepromUnlocked = 1; return;
        case 0x3170:
          if (m & 0xFF) {
            this.toSound = v & 0xFF; this.toSoundReady = 1;
            if (this.soundReset & 1) this.snd.nmi();
          }
          return;
      }
      return;
    }
    const vv = a & 0x37FFF;                       // VBUS
    if (vv >= 0x30000) { this.xscroll = merge(this.xscroll); return; }
    if (vv >= 0x10000) { if (vv < 0x20000) { const i = (vv & 0x7FF) >> 1; this.pal[i] = merge(this.pal[i]); this.setColor(i); } return; }
    if (vv < 0x2000) { this.pf[vv >> 1] = merge(this.pf[vv >> 1]); return; }
    if (vv < 0x4000) { this.mo[(vv - 0x2000) >> 1] = merge(this.mo[(vv - 0x2000) >> 1]); return; }
    if (vv < 0x5000) { this.spare[(vv - 0x4000) >> 1] = merge(this.spare[(vv - 0x4000) >> 1]); return; }
    if (vv < 0x6000) {
      const i = (vv - 0x5000) >> 1;
      this.alpha[i] = merge(this.alpha[i]);
      if (vv === 0x5F6E) this.yscroll = this.alpha[i];
    }
  }

  // ---------------------------------------------------------------- sound CPU

  // 0000-0FFF RAM (mirrored at 2000), I/O at 1000-1FFF (mirrored at 3000), ROM from 4000.
  sndRead(a) {
    if (a >= 0x4000) return this.roms.sound[a];
    if (!(a & 0x1000)) return this.soundRam[a & 0xFFF];
    switch (a & 0x1830) {
      case 0x1010: this.toSoundReady = 0; return this.toSound;
      case 0x1020: return 0xF0 | this.coins;
      case 0x1030: return 0x30 ^ (this.toSoundReady ? 0x80 : 0) ^ (this.toMainReady ? 0x40 : 0) ^ (this.speech.ready() ? 0x20 : 0);
      case 0x1800: return this.pokey.read(a & 15);
      case 0x1810: return a & 1 ? this.ym.read() : 0xFF;
      case 0x1830: this.timedInt = 0; return 0;
    }
    return 0xFF;
  }
  sndWrite(a, v) {
    if (a >= 0x4000) return;
    if (!(a & 0x1000)) { this.soundRam[a & 0xFFF] = v; return; }
    switch (a & 0x1830) {
      case 0x1000:
        // Right after a reset the 6502 writes a burst of self-test bytes through this latch and then
        // FF; the main program only accepts the FF (anything else makes it reset the sound CPU
        // again), so the burst is dropped.
        if (this.bootFilter) { if ((a & 0xF) || v !== 0xFF) return; this.bootFilter = 0; }
        this.toMain = v; this.toMainReady = 1; this.soundInt = 1; this.updateIrq();
        return;
      case 0x1020: this.mixer = v; return;
      case 0x1030:
        switch (a & 7) {
          case 1: if (((v ^ this.lastSpeech) & 0x80) && (v & 0x80)) this.speech.write(this.speechVal); this.lastSpeech = v; return;
          case 2: if (((v ^ this.lastSpeech) & 0x80) && (v & 0x80)) this.speech.reset(); return;
          case 3: this.squeak = 5 | ((v >> 6) & 2); return;
        }
        return;
      case 0x1800: this.pokey.write(a & 15, v); return;
      case 0x1810: if (a & 1) this.ym.write(v); else this.ym.select(v); return;
      case 0x1820: this.speechVal = v; return;
      case 0x1830: this.timedInt = 0; return;
    }
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const mainLine = MAIN_CLOCK / REFRESH / LINES / SUBSLICES, soundLine = SOUND_CLOCK / REFRESH / LINES / SUBSLICES;
    const samples = RATE / REFRESH / LINES / SUBSLICES, dt = 1 / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      this.line = line;
      if (line === H) { this.render(); this.videoInt = 1; this.updateIrq(); }
      if ((line & 31) === 0) this.timedInt = line & 32 ? 1 : 0;      // the sound CPU's IRQ follows 32V
      for (let k = 0; k < SUBSLICES; k++) {
        this.cycleCarry += mainLine;
        this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
        this.snd.irq = !!(this.timedInt || this.ym.irq);
        this.soundCarry += soundLine;
        const n = Math.floor(this.soundCarry);
        if (this.soundReset & 1) this.soundCarry -= this.snd.run(n); else this.soundCarry -= n;
        this.sampleCarry += samples;
        while (this.sampleCarry >= 1) {
          this.sampleCarry -= 1;
          // The speech chip runs at its clock / 80 (the "squeak" setting picks the clock divider).
          this.speechCarry += (14318180 / 2 / (16 - (this.squeak || 5)) / 80) / RATE;
          while (this.speechCarry >= 1) { this.speechCarry -= 1; this.speech.clock(); }
          this.sound.sample();
        }
      }
      this.ym.timers(dt);
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const frame = this.frame, idx = this.idx;
    const pal = this.palette, pix = this.tilePix, tc = this.tileCount;
    // Playfield: 64x64 tiles in columns; tile bank from the y scroll register.
    const bank = this.yscroll & 3, sx = this.xscroll & 0x1FF, sy = (this.yscroll >> 7) & 0x1FF;
    for (let y = 0; y < H; y++) {
      const ty = (y + sy) & 0x1FF;
      for (let x = 0; x < W; x++) {
        const tx = (x + sx) & 0x1FF, d = this.pf[(tx >> 3) * 64 + (ty >> 3)];
        const code = (((bank * 0x1000) + (d & 0xFFF)) ^ 0x800) % tc, flipX = d & 0x8000;
        const pen = pix[code * 64 + (ty & 7) * 8 + (flipX ? 7 - (tx & 7) : tx & 7)];
        idx[y * W + x] = 0x100 + (0x18 + ((d >> 12) & 7)) * 16 + pen;
      }
    }
    this.drawMotionObjects(idx);
    for (let i = 0; i < W * H; i++) frame[i] = pal[idx[i]];
    // Text on top: pen 0 is see-through unless the tile is marked opaque.
    const ap = this.alphaPix, ac = this.alphaCount;
    for (let row = 0; row < 30; row++) {
      for (let col = 0; col < 42; col++) {
        const d = this.alpha[row * 64 + col], code = (d & 0x3FF) % ac, color = ((d >> 10) & 0x0F) | ((d >> 9) & 0x20), opaque = d & 0x8000;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const pen = ap[code * 64 + y * 8 + x];
            if (pen || opaque) frame[(row * 8 + y) * W + col * 8 + x] = pal[color * 4 + pen];
          }
        }
      }
    }
  }

  // Motion objects, band by band (8 lines each) from the SLIP table, following the links;
  // later objects in a list draw over earlier ones.
  drawMotionObjects(idx) {
    const mo = this.mo, pix = this.tilePix, tc = this.tileCount;
    const xscroll = this.xscroll & 0x1FF, yscroll = (this.yscroll >> 7) & 0x1FF;
    const buf = this.moBuf || (this.moBuf = new Uint16Array(W * H));
    buf.fill(0);
    const visit = new Uint8Array(1024);
    for (let band = 0; band < 64; band++) {
      let minY = ((band << 3) - yscroll + 1) & 0x1FF;
      if (minY > H - 1) minY -= 512;
      const maxY = minY + 7;
      if (maxY < 0 || minY >= H) continue;
      let link = this.alpha[0x7C0 + band] & 0x3FF;    // 905F80: the SLIP table
      visit.fill(0);
      while (!visit[link]) {
        visit[link] = 1;
        const w0 = mo[link], w1 = mo[0x400 + link], w2 = mo[0x800 + link], w3 = mo[0xC00 + link];
        let code = (w0 & 0x7FFF) ^ 0x800;
        const color = 0x100 + (w1 & 15) * 16;
        let xpos = (w1 >> 7) - xscroll, ypos = -(w2 >> 7) - yscroll;
        const hflip = w2 & 0x40, width = ((w2 >> 3) & 7) + 1, height = (w2 & 7) + 1;
        ypos -= height * 8;
        xpos &= 0x1FF; ypos &= 0x1FF;
        if (xpos > W - 1) xpos -= 512;
        if (ypos > H - 1) ypos -= 512;
        let xadv = 8;
        if (hflip) { xpos += (width - 1) * 8; xadv = -8; }
        for (let ty = 0, sy = ypos; ty < height; ty++, sy += 8) {
          for (let tx = 0, sx = xpos; tx < width; tx++, sx += xadv, code++) {
            if (sy + 7 < minY || sy > maxY) continue;
            const c = (code % tc) * 64;
            for (let y = Math.max(0, minY - sy, -sy); y < 8 && sy + y <= maxY && sy + y < H; y++) {
              const row = (sy + y) * W;
              for (let x = 0; x < 8; x++) {
                const px = sx + x;
                if (px < 0 || px >= W) continue;
                const pen = pix[c + y * 8 + (hflip ? 7 - x : x)];
                if (pen) buf[row + px] = color + pen;
              }
            }
          }
        }
        link = w3 & 0x3FF;
      }
    }
    // Merge: pen 1 flips the playfield's color bit 0x80 (a shadow); others replace it.
    for (let i = 0; i < W * H; i++) {
      const m = buf[i];
      if (!m) continue;
      if ((m & 15) === 1) idx[i] ^= 0x80; else idx[i] = m;
    }
  }

  // ---------------------------------------------------------------- inputs

  // Each player: Magic/start (1), Fire (2), right, left, down, up (10-80), active low.
  // Coins (on the sound CPU): slot 1 = 8, 2 = 4, 3 = 2, 4 = 1. A character's button
  // drops that slot's coin and, a moment later, presses its Magic (start).
  setInputs(s) {
    const picked = [s.start1, s.start2, s.start3, s.start4].findIndex(Boolean);
    if (picked >= 0 && !this.wasPicked) { this.slot = picked; this.joinTimer = 1; }
    this.wasPicked = picked >= 0;
    const t = this.joinTimer;
    if (t) this.joinTimer = t < 76 ? t + 1 : 0;
    const coin = s.coin || (t >= 1 && t <= 4), start = t >= 70 && t <= 75;
    const p = (s.fire2 || start ? 1 : 0) | (s.fire ? 2 : 0) | (s.right ? 0x10 : 0) | (s.left ? 0x20 : 0) | (s.down ? 0x40 : 0) | (s.up ? 0x80 : 0);
    for (let i = 0; i < 4; i++) this.in[i] = i === this.slot ? 0xFF & ~p : 0xFF;
    this.coins = 0x0F & ~(coin ? 8 >> this.slot : 0);
  }
  applySwitches() {}
}
Gauntlet.id = 'gauntlet';
Gauntlet.title = 'Gauntlet';
Gauntlet.switches = [];
