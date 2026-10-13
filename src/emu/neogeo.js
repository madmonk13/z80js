// SNK Neo Geo MVS (1990-2004): a 68000 at 12 MHz, a Z80 at 4 MHz driving a
// YM2610, and the LSPC video chip. Games come on cartridges (P program, S
// fix-layer tiles, M sound program, V samples, C sprite tiles) and boot
// through the system BIOS, which is part of the ROM set.
//
// Video is all sprites: 381 vertical strips one tile (16 pixels) wide and up
// to 32 tiles tall, each shrinkable (horizontally to 1-16 pixels, vertically
// through a ROM table), chained side by side into larger objects, at most 96
// on a line. A fixed 40x32 layer of 8x8 tiles sits on top. 4096 colors of
// 16-bit RGB (plus a shared low bit) in two switchable banks. Video RAM is
// reached through an address/modulo register pair, and the line counter
// drives a programmable raster interrupt (level 2) next to the vertical
// blank one (level 1).
//
// 304x224 shown (the hardware's 320 includes columns most games leave dirty),
// at 59.19 Hz.

import { M68000 } from './m68000.js';
import { Z80 } from './z80.js';
import { YM2610 } from './ym2610.js';
import { SoundMix } from './mixer.js';
import { rgba } from './video.js';
import { capture, apply } from './state.js';

const W = 304, H = 224, LEFT = 8, TOP = 16;
const LINES = 264, LINE_PIXELS = 384, VBSTART = 0xF0, VBLANK_RELOAD = 0x11F;
const WATCHDOG = 0.128762 * 6000000;          // in pixel clocks
const CPU_PER_PIXEL = 2, Z80_PER_LINE = 4000000 / 15625, REFRESH = 6000000 / LINE_PIXELS / LINES;

// Horizontal shrink: which of a tile's 16 columns are drawn at each of the 16 sizes.
const ZOOM_X = [
  '0000000010000000', '0000100010000000', '0000100010001000', '0010100010001000',
  '0010100010001010', '0010101010001010', '0010101010101010', '1010101010101010',
  '1010101010111010', '1011101010111010', '1011101010111011', '1011101110111011',
  '1011101110111111', '1111101110111111', '1111101111111111', '1111111111111111',
].map((s) => Uint8Array.from(s, Number));

const STATE = ['ram', 'sram', 'vram', 'palettes', 'vOffset', 'vModulo', 'vBuffer', 'animSpeed', 'animOff', 'animCount', 'animFrame',
  'irqCtl', 'counter', 'posTimer', 'vblankPending', 'posPending', 'irq3Pending', 'bank', 'vectors', 'audioResult', 'latch',
  'zBanks', 'zram', 'sramOpen', 'fixSource', 'dark', 'palBank', 'rtc', 'watchdog', 'cycleCarry', 'zCarry', 'sampleCarry', 'in0', 'in1', 'in2', 'in3',
  'cpu', 'snd', 'ym'];

export class NeoGeo {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); this.regeneratePens(); }

  // roms: { bios, p (program, big-endian), s (fix tiles), sfix, m (Z80), v (samples), c (sprite tiles, interleaved), zoom }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 3;
    this.button2 = this.constructor.button2 || 'Jump';
    this.button3 = this.constructor.button3 || 'Grenade';
    this.roms = roms;
    const tiles = roms.c.length / 128;
    let pow = 1;
    while (pow < tiles) pow *= 2;
    this.tileMask = pow - 1;
    this.tileCount = tiles;

    this.ram = new Uint8Array(0x10000);
    this.sram = new Uint8Array(0x10000);
    this.vram = new Uint16Array(0x10000);
    this.palettes = new Uint16Array(0x2000);
    this.zram = new Uint8Array(0x800);
    this.pens = new Uint32Array(4096);
    this.lineSprites = new Uint16Array(97);
    this.frame = new Uint32Array(W * H);
    this.line = new Uint32Array(LINE_PIXELS);

    this.cpu = new M68000({
      read8: (a) => this.read8(a), read16: (a) => this.read16(a),
      write8: (a, v) => this.write8(a, v), write16: (a, v) => this.write16(a, v),
    });
    this.snd = new Z80({ read: (a) => this.zRead(a), write: (a, v) => this.zWrite(a, v), input: (p) => this.zIn(p), output: (p, v) => this.zOut(p, v) });
    this.ym = new YM2610(8000000, roms.v, 1);
    this.sound = new SoundMix([this.ym], 1);
    this.in0 = 0xFF; this.in1 = 0xFF; this.in2 = 0xFFFF; this.in3 = 0xFF;
    this.applySwitches();
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.vram.fill(0); this.palettes.fill(0); this.zram.fill(0);
    this.rtc = this.calendarNow();
    this.boardReset();
    this.irq3Pending = 1;                      // power-on (not a watchdog reset) starts with an IRQ3
    this.updateIrq();
  }

  // What the reset line (and the watchdog) resets: the CPUs and the system
  // registers; memory keeps its contents.
  boardReset() {
    this.vOffset = 0; this.vModulo = 0; this.vBuffer = 0;
    this.animSpeed = 0; this.animOff = 0; this.animCount = 0; this.animFrame = 0;
    this.irqCtl = 0; this.counter = 0; this.posTimer = -1;
    this.vblankPending = 0; this.posPending = 0; this.irq3Pending = 0;
    this.watchdog = 0;
    this.bank = this.roms.p.length > 0x100000 ? 0x100000 : 0;
    this.vectors = 0; this.audioResult = 0; this.latch = 0;
    this.zBanks = new Uint8Array([0x1E, 0x0E, 0x06, 0x02]);
    this.sramOpen = 0; this.fixSource = 0; this.dark = 0; this.palBank = 0;
    this.cycleCarry = this.zCarry = this.sampleCarry = 0;
    this.regeneratePens();
    this.cpu.reset(); this.snd.reset(); this.sound.reset();
    this.updateIrq();
  }

  // ---------------------------------------------------------------- 68000 bus

  word(rom, a) { return a + 1 < rom.length ? (rom[a] << 8) | rom[a + 1] : 0xFFFF; }

  read16(a) {
    const top = a >> 20;
    switch (top) {
      case 0x0: return a < 0x80 && !this.vectors ? this.word(this.roms.bios, a) : this.word(this.roms.p, a);
      case 0x1: { const o = a & 0xFFFF; return (this.ram[o] << 8) | this.ram[o + 1]; }
      case 0x2: return this.word(this.roms.p, this.bank + (a & 0xFFFFF));
      case 0x3: return this.io(a);
      case 0x4: case 0x5: case 0x6: case 0x7: return this.palettes[this.palBank * 4096 + ((a >> 1) & 0xFFF)];
      case 0xC: return this.word(this.roms.bios, a & 0x1FFFF);
      case 0xD: { const o = a & 0xFFFF; return (this.sram[o] << 8) | this.sram[o + 1]; }
      case 0x8: case 0x9: case 0xA: case 0xB: return 0xFFFF;   // no memory card
    }
    return this.openBus();
  }

  // Unmapped reads see the last word on the data bus: almost always the
  // instruction prefetch, i.e. the word at the program counter. Some games
  // check for this.
  openBus() {
    if (this.inOpenBus) return 0xFFFF;
    this.inOpenBus = true;
    const v = this.read16(this.cpu.pc & 0xFFFFFE);
    this.inOpenBus = false;
    return v;
  }
  read8(a) { const w = this.read16(a & ~1); return a & 1 ? w & 0xFF : w >> 8; }

  io(a) {
    switch ((a >> 16) & 0xE) {
      case 0x0: return a & 0x80 ? 0xFFC0 : (this.in0 << 8) | this.dips;
      case 0x2: {
        // Coins, the calendar's test and data bits, and the sound CPU's reply in the high byte.
        const cal = (this.rtc.test ? 0x40 : 0) | (this.rtc.out ? 0x80 : 0);
        return (this.audioResult << 8) | (this.in3 & 0x3F) | cal;
      }
      case 0x4: return (this.in1 << 8) | 0xFF;
      case 0x8: return this.in2;
      case 0x6: case 0xA: case 0xE: return this.openBus();
      case 0xC: {
        switch ((a >> 1) & 3) {
          case 0: case 1: return this.vBuffer;   // (byte reads of the low half see the open bus on hardware)
          case 2: return this.vModulo;
          default: {
            let v = (((LINES + this.vpos) % LINES) + 0x100);
            if (v >= 0x200) v -= LINES;
            return ((v << 7) | (this.animCount & 7)) & 0xFFFF;
          }
        }
      }
    }
    return this.openBus();
  }

  // lsb/msb: which halves of the word were written.
  write16(a, v) { this.write(a, v, true, true); }
  write8(a, v) { if (a & 1) this.write(a & ~1, v & 0xFF, false, true); else this.write(a, (v & 0xFF) << 8, true, false); }

  write(a, v, msb, lsb) {
    const top = a >> 20;
    switch (top) {
      case 0x1: { const o = a & 0xFFFF; if (msb) this.ram[o] = v >> 8; if (lsb) this.ram[o + 1] = v; return; }
      case 0x2: if (a >= 0x2FFFF0) this.bankSelect(lsb ? v & 0xFF : v >> 8); return;
      case 0x3: this.ioWrite(a, v, msb, lsb); return;
      case 0x4: case 0x5: case 0x6: case 0x7: {
        const i = this.palBank * 4096 + ((a >> 1) & 0xFFF), old = this.palettes[i];
        this.palettes[i] = (msb ? v & 0xFF00 : old & 0xFF00) | (lsb ? v & 0xFF : old & 0xFF);
        this.pens[i & 0xFFF] = this.pen(this.palettes[i]);
        return;
      }
      case 0xD: if (this.sramOpen) { const o = a & 0xFFFF; if (msb) this.sram[o] = v >> 8; if (lsb) this.sram[o + 1] = v; } return;
    }
  }

  bankSelect(d) {
    const len = this.roms.p.length;
    if (len <= 0x100000) return;
    let b = ((d & 7) + 1) * 0x100000;
    if (b >= len) b = 0x100000;
    this.bank = b;
  }

  ioWrite(a, v, msb, lsb) {
    switch ((a >> 16) & 0xE) {
      case 0x0: if (lsb) this.watchdog = 0; return;                       // only a low-byte write kicks the watchdog
      case 0x2: if (msb) { this.latch = v >> 8; this.snd.nmi(); } return;      // sound command
      case 0x8: {
        if (!lsb) return;
        const off = (a & 0x7F) >> 1;
        if (off === 0x28) this.rtcControl(v & 7);                            // the calendar's serial lines
        return;
      }
      case 0xA: {
        if (!lsb) return;
        const off = (a & 0x1F) >> 1, bit = (off >> 3) & 1;
        switch (off & 7) {
          case 0: if (this.dark !== bit) { this.dark = bit; this.regeneratePens(); } break;
          case 1: this.vectors = bit; break;
          case 5: this.fixSource = bit; break;
          case 6: this.sramOpen = bit; break;
          case 7: if (this.palBank !== bit) { this.palBank = bit; this.regeneratePens(); } break;
        }
        return;
      }
      case 0xC: {
        if (!msb) return;
        if (!lsb) v = (v & 0xFF00) | (v >> 8);
        this.videoWrite((a >> 1) & 7, v & 0xFFFF);
        return;
      }
    }
    // 380000's controller select and LED outputs aren't needed.
  }

  videoWrite(r, v) {
    switch (r) {
      case 0: this.vOffset = v; this.vBuffer = this.vram[v]; break;
      case 1:
        this.vram[this.vOffset] = v;
        this.vOffset = (this.vOffset & 0x8000) | ((this.vOffset + this.vModulo) & 0x7FFF);
        this.vBuffer = this.vram[this.vOffset];
        break;
      case 2: this.vModulo = v; break;
      case 3: this.animSpeed = v >> 8; this.animOff = v & 8; this.irqCtl = v & 0xF0; break;
      case 4: this.counter = (this.counter & 0xFFFF) | (v << 16); break;
      case 5:
        this.counter = ((this.counter & 0xFFFF0000) | v) >>> 0;
        if (this.irqCtl & 0x20) this.loadTimer();
        break;
      case 6:
        if (v & 1) this.irq3Pending = 0;
        if (v & 2) this.posPending = 0;
        if (v & 4) this.vblankPending = 0;
        this.updateIrq();
        break;
    }
  }

  // The raster timer counts pixels from now; it reloads on demand, at vertical blank or when it fires.
  loadTimer() { this.posTimer = this.counter + 1; }

  updateIrq() {
    this.cpu.irq = this.irq3Pending ? 3 : this.posPending ? 2 : this.vblankPending ? 1 : 0;
  }

  // ---------------------------------------------------------------- calendar (uPD4990A)

  calendarNow() {
    const d = new Date(), bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
    return {
      sec: bcd(d.getSeconds()), min: bcd(d.getMinutes()), hour: bcd(d.getHours()), day: bcd(d.getDate()),
      wday: d.getDay(), month: d.getMonth() + 1, year: bcd(d.getFullYear() % 100),
      lo: 0, hi: 0, bit: 0, reading: 0, out: 0, test: 0, waits: 0, maxWaits: 1, clk: 0, stb: 0, frames: 0,
    };
  }

  rtcControl(v) {
    const r = this.rtc;
    if (r.stb && !(v & 4)) this.rtcCommand();
    r.stb = v & 4;
    if (r.clk && !(v & 2)) {
      // Shift a bit in (and the next one out when reading the time).
      if (r.bit <= 31) r.lo |= (v & 1) << r.bit; else r.hi |= (v & 1) << (r.bit - 32);
      r.bit++;
      if (r.reading) this.rtcOut();
      if (r.reading && r.bit === 0x34) { r.reading = 0; r.lo = r.hi = r.bit = 0; }
    }
    r.clk = v & 2;
  }

  rtcCommand() {
    const r = this.rtc;
    const cmd = (r.bit <= 31 ? r.lo >>> (r.bit - 4) : r.hi >>> (r.bit - 36)) & 15;
    switch (cmd) {
      case 1: r.bit = 0; if (r.reading) this.rtcOut(); r.lo = r.hi = 0; break;
      case 2: r.sec = r.lo & 0xFF; r.min = (r.lo >> 8) & 0xFF; r.hour = (r.lo >> 16) & 0xFF; r.day = (r.lo >>> 24) & 0xFF;
        r.wday = r.hi & 15; r.month = (r.hi >> 4) & 15; r.year = (r.hi >> 8) & 0xFF; break;
      case 3: r.reading = 1; break;
      case 7: r.maxWaits = 1; break;
      case 8: r.maxWaits = 30; break;
    }
    r.lo = r.hi = r.bit = 0;
  }

  rtcOut() {
    const r = this.rtc, b = r.bit;
    const fields = [[0, r.sec], [8, r.min], [16, r.hour], [24, r.day], [32, r.wday], [36, r.month], [40, r.year]];
    for (let i = fields.length - 1; i >= 0; i--) {
      if (b >= fields[i][0]) { if (b < 48) r.out = (fields[i][1] >> (b - fields[i][0])) & 1; return; }
    }
  }

  rtcFrame() {
    const r = this.rtc;
    if (++r.waits >= r.maxWaits) { r.test ^= 1; r.waits = 0; }
    if (++r.frames < 60) return;
    r.frames = 0;
    // Tick the BCD seconds (minutes and up roll over too; the date is left alone).
    const inc = (v, lim) => { v++; if ((v & 15) >= 10) v = (v & 0xF0) + 0x10; return v >= lim ? -1 : v; };
    let s = inc(r.sec, 0x60);
    if (s >= 0) { r.sec = s; return; }
    r.sec = 0; s = inc(r.min, 0x60);
    if (s >= 0) { r.min = s; return; }
    r.min = 0; s = inc(r.hour, 0x24);
    r.hour = s >= 0 ? s : 0;
  }

  // ---------------------------------------------------------------- sound CPU

  zRead(a) {
    const m = this.roms.m;
    if (a < 0x8000) return m[a];
    if (a >= 0xF800) return this.zram[a - 0xF800];
    const r = a < 0xC000 ? 3 : a < 0xE000 ? 2 : a < 0xF000 ? 1 : 0;
    const base = [0xF000, 0xE000, 0xC000, 0x8000][r];
    const off = ((this.zBanks[r] << (11 + r)) & 0x3FFFF) & (m.length - 1);
    return m[(off + (a - base)) % m.length];
  }
  zWrite(a, v) { if (a >= 0xF800) this.zram[a - 0xF800] = v; }
  zIn(p) {
    const lo = p & 0xFF;
    if ((lo & 0x0F) >= 8 && (lo & 0x0F) <= 0x0B && (lo & 0xF0) === 0) { this.zBanks[lo - 8] = (p >> 8) & 0xFF; return 0; }
    switch (lo) {
      case 0x00: return this.latch;
      case 0x04: return this.ym.statusA();
      case 0x05: return this.ym.readData();
      case 0x06: return this.ym.statusB();
    }
    return 0;
  }
  zOut(p, v) {
    switch (p & 0xFF) {
      case 0x04: this.ym.selectA(v); break;
      case 0x05: this.ym.writeA(v); break;
      case 0x06: this.ym.selectB(v); break;
      case 0x07: this.ym.writeDataB(v); break;
      case 0x0C: this.audioResult = v; break;
    }
  }

  // ---------------------------------------------------------------- inputs

  // IN0 (player 1): up, down, left, right, A-D, active low. IN3: coin. IN2: starts (bit 8, 10).
  setInputs(s) {
    const c = this.constructor.buttonMap || [['fire', 0x10], ['fire2', 0x20], ['fire3', 0x40], ['hyper', 0x40]];
    let b = 0;
    for (const [flag, bit] of c) if (s[flag]) b |= bit;
    this.in0 = 0xFF & ~((s.up ? 1 : 0) | (s.down ? 2 : 0) | (s.left ? 4 : 0) | (s.right ? 8 : 0) | b);
    this.in3 = 0xFF & ~(s.coin ? 1 : 0);
    this.in2 = 0xFFFF & ~((s.start1 ? 0x100 : 0) | (s.start2 ? 0x400 : 0));
  }
  applySwitches() { this.dips = 0xFF; }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const zl = Z80_PER_LINE, samples = 48000 / REFRESH / LINES, dt = 1 / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      this.vpos = line;
      if (line === 0) this.animTick();
      if (line === VBSTART) { this.rtcFrame(); this.vblankPending = 1; this.updateIrq(); }
      if (line >= TOP && line < TOP + H) this.parseSprites(line);
      // Run the line, stopping where the raster timer fires or the vertical blank reloads it.
      let px = 0;
      while (px < LINE_PIXELS) {
        let next = LINE_PIXELS;
        if (this.posTimer > 0 && px + this.posTimer < next) next = px + this.posTimer;
        if (line === VBSTART && px < VBLANK_RELOAD && VBLANK_RELOAD < next) next = VBLANK_RELOAD;
        const n = next - px;
        this.cycleCarry += n * CPU_PER_PIXEL;
        this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
        if (this.posTimer > 0) this.posTimer -= n;
        px = next;
        if (this.posTimer === 0) {
          this.posTimer = -1;
          if (this.irqCtl & 0x10) { this.posPending = 1; this.updateIrq(); }
          if (this.irqCtl & 0x80) this.loadTimer();
        }
        if (line === VBSTART && px === VBLANK_RELOAD && (this.irqCtl & 0x40)) this.loadTimer();
      }
      // The watchdog resets the board if the program stops kicking it for 0.13 s;
      // some games rely on that as a protection check.
      this.watchdog += LINE_PIXELS;
      if (this.watchdog > WATCHDOG) { this.boardReset(); continue; }
      this.snd.irq = this.ym.irq;
      this.zCarry += zl;
      this.zCarry -= this.snd.run(Math.floor(this.zCarry));
      this.ym.timers(dt);
      if (line >= TOP && line < TOP + H) this.drawLine(line);
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  animTick() {
    if (this.animFrame === 0) { this.animFrame = this.animSpeed; this.animCount = (this.animCount + 1) & 0xFF; }
    else this.animFrame--;
  }

  // ---------------------------------------------------------------- video

  pen(d) {
    let k = d & 0x8000 ? 0.96 : 1;
    if (this.dark) k *= 0.6;
    const ch = (hi, lsb) => Math.round(((((d >> hi) & 15) << 1) | ((d >> lsb) & 1)) * 255 / 31 * k);
    return rgba(ch(8, 14), ch(4, 13), ch(0, 12));
  }
  regeneratePens() { const base = this.palBank * 4096; for (let i = 0; i < 4096; i++) this.pens[i] = this.pen(this.palettes[base + i]); }

  // The sprites on this line, in order (at most 96).
  parseSprites(line) {
    const v = this.vram, list = this.lineSprites;
    let y = 0, rows = 0, n = 0;
    for (let s = 0; s < 381 && n < 96; s++) {
      const yc = v[0x8200 | s];
      if (!(yc & 0x40)) { y = 0x200 - (yc >> 7); rows = yc & 0x3F; }
      if (rows === 0 || !onLine(line, y, rows)) continue;
      list[n++] = s;
    }
    list[n] = 0xFFFF;
  }

  drawLine(line) {
    const buf = this.line, pens = this.pens, v = this.vram, c = this.roms.c, zoom = this.roms.zoom;
    buf.fill(pens[0xFFF]);
    // Sprites.
    let x = 0, y = 0, rows = 0, zy = 0, zx = 0;
    for (let k = 0; k < 96; k++) {
      const s = this.lineSprites[k];
      if (s === 0xFFFF) break;
      const yc = v[0x8200 | s], zc = v[0x8000 | s];
      if (yc & 0x40) { x = (x + zx + 1) & 0x1FF; zx = (zc >> 8) & 15; }
      else { y = 0x200 - (yc >> 7); x = v[0x8400 | s] >> 7; zy = zc & 0xFF; zx = (zc >> 8) & 15; rows = yc & 0x3F; }
      if (x >= 0x140 && x <= 0x1F0) continue;
      if (!onLine(line, y, rows)) continue;
      const sl = (line - y) & 0x1FF;
      let zl = sl & 0xFF, invert = sl & 0x100;
      if (invert) zl ^= 0xFF;
      if (rows > 0x20) {
        zl %= (zy + 1) << 1;
        if (zl > zy) { zl = ((zy + 1) << 1) - 1 - zl; invert = !invert; }
      }
      const yt = zoom[(zy << 8) | zl];
      let sy = yt & 15, tile = yt >> 4;
      if (invert) { sy ^= 15; tile ^= 0x1F; }
      const o = (s << 6) | (tile << 1), attr = v[o + 1];
      let code = ((attr << 12) & 0x70000) | v[o];
      if (!this.animOff) {
        if (attr & 8) code = (code & ~7) | (this.animCount & 7);
        else if (attr & 4) code = (code & ~3) | (this.animCount & 3);
      }
      if (attr & 2) sy ^= 15;
      code &= this.tileMask;
      if (code >= this.tileCount) continue;
      // One row of the tile: the left 8 pixels from bytes 40-43, the right 8 from 00-03.
      const base = code * 128 + (sy << 2);
      const pal = (attr >> 8) << 4, flip = attr & 1, zt = ZOOM_X[zx];
      let px = x;
      for (let i = 0; i < 16; i++) {
        const col = flip ? 15 - i : i;
        if (!zt[i]) continue;
        const b = base + (col < 8 ? 0x40 : 0), bit = col & 7;
        const pen = ((c[b + 3] >> bit) & 1) << 3 | ((c[b + 1] >> bit) & 1) << 2 | ((c[b + 2] >> bit) & 1) << 1 | ((c[b] >> bit) & 1);
        const sx = px & 0x1FF;
        if (pen && sx < 320) buf[sx] = pens[pal | pen];
        px++;
      }
    }
    // The fix layer.
    const fix = this.fixSource ? this.roms.s : this.roms.sfix, fmask = fix.length - 1;
    for (let col = 0; col < 40; col++) {
      const t = v[0x7000 | (line >> 3) | (col << 5)];
      const g = ((t & 0xFFF) << 5) | (line & 7), pal = (t >> 12) << 4;
      for (let i = 0; i < 8; i++) {
        const byte = fix[(g + [0x10, 0x18, 0x00, 0x08][i >> 1]) & fmask];
        const pen = i & 1 ? byte >> 4 : byte & 15;
        if (pen) buf[col * 8 + i] = pens[pal | pen];
      }
    }
    this.frame.set(buf.subarray(LEFT, LEFT + W), (line - TOP) * W);
  }
}

function onLine(line, y, rows) {
  const h = (rows === 0 || rows > 0x20 ? 0x20 : rows) * 16;
  const max = (y + h - 1) & 0x1FF;
  return max >= y ? line >= y && line <= max : line >= y || line <= max;
}

export class MetalSlug extends NeoGeo {}
MetalSlug.id = 'mslug'; MetalSlug.title = 'Metal Slug'; MetalSlug.switches = [];
export class MetalSlug2 extends NeoGeo {}
MetalSlug2.id = 'mslug2'; MetalSlug2.title = 'Metal Slug 2'; MetalSlug2.switches = [];
// Metal Slug X checks a protection device; patch out the checks (the same
// spots MAME patches): every "andi.w #1,d3 / bne" pair in the first megabyte,
// and three fixed sequences.
export class MetalSlugX extends NeoGeo {
  constructor(roms) {
    const p = roms.p, nop = (a) => { p[a] = 0x4E; p[a + 1] = 0x71; };
    const w = (a) => (p[a] << 8) | p[a + 1];
    for (let a = 0; a < 0x100000 - 8; a += 2) {
      if (w(a) === 0x0243 && w(a + 2) === 0x0001 && w(a + 4) === 0x6600) { nop(a + 4); nop(a + 6); }
    }
    for (const a of [0x3BDC, 0x3BDE, 0x3BE0, 0x3C0C, 0x3C0E, 0x3C10, 0x3C36, 0x3C38]) nop(a);
    super(roms);
  }
}
MetalSlugX.id = 'mslugx'; MetalSlugX.title = 'Metal Slug X'; MetalSlugX.switches = [];
