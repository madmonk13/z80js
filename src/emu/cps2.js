// Capcom CP System II (CPS-2, 1993-2003): the CPS-1's video chips (three
// tile layers, palette, layer control) on a board with its own sprite
// generator, a 68000 at 11.8 MHz whose program is encrypted (decrypted up
// front, see cps2crypt.js), a 93C46 EEPROM in place of DIP switches, and a
// Z80 at 8 MHz driving QSound, talking to the 68000 through shared RAM.
//
// Sprites: 1024 entries in object RAM (two banks the game swaps), latched at
// vertical blank; each has a 3-bit priority that, with the layer priorities
// in the object registers (400000), decides which tile layers cover it. The
// first sprite drawn at a pixel (the last in the list) keeps it.
//
// Interrupts: level 2 at vertical blank, level 4 at the two raster lines the
// game sets (used for mid-screen effects); the Z80 an IRQ 251 times a second.
// 384x224 at 59.6 Hz.

import { CPS1, W, H, LEFT, TOP } from './cps1.js';
import { Z80 } from './z80.js';
import { QSound } from './qsound.js';
import { SerialEEPROM } from './eeprom.js';
import { SoundMix, RATE } from './mixer.js';
import { decryptCps2, CPS2_KEYS } from './cps2crypt.js';
import { capture, apply } from './state.js';

const LINES = 262, REFRESH = 59.633333, CPU_CLOCK = 11800000, Z80_CLOCK = 8000000, Z80_IRQ_HZ = 251;
const OBJ_WORDS = 0x1000;                 // 8K of object RAM per bank
const STATE2 = ['ram', 'gfxram', 'out', 'objOut', 'obj1', 'obj2', 'objBank', 'objBuf2', 'qram1', 'qram2', 'bank', 'zHeld',
  'line1', 'line2', 'priCtrl', 'frameCount', 'cycleCarry', 'zCarry', 'zIrqCarry', 'sampleCarry', 'inp', 'cpu', 'snd', 'qs', 'eeprom'];

export class CPS2 extends CPS1 {
  saveState() { return capture(this, STATE2); }
  loadState(s) { apply(this, STATE2, s); }

  // roms: { main (68000, big-endian), gfx (unshuffled), sound (Z80, 0x50000 with banks from 10000), samples (QSound) }
  constructor(roms) {
    super(roms);
    // The CPS-1 constructor decoded the graphics; the raw copy isn't needed (no starfield on CPS-2).
    this.roms = { ...roms, gfx: null };
    const [key, limit] = CPS2_KEYS[this.constructor.id];
    this.ops = decryptCps2(roms.main, key, limit);
    this.cpu.opRead = (a) => (a < 0x400000 ? this.ops[a >> 1] : this.read16(a));
    this.objOut = new Uint16Array(6);          // 400000: object base, priorities, X/Y offsets
    this.obj1 = new Uint16Array(OBJ_WORDS);
    this.obj2 = new Uint16Array(OBJ_WORDS);
    this.objBuf2 = new Uint16Array(OBJ_WORDS);
    this.qram1 = new Uint8Array(0x1000);       // Z80 C000-CFFF, the 68000's 618000
    this.qram2 = new Uint8Array(0x1000);       // Z80 F000-FFFF
    this.pri = new Uint8Array(W * H);
    this.taken = new Uint8Array(W * H);
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.qs = new QSound(roms.samples, 1);
    this.sound = new SoundMix([this.qs], 1);
    this.eeprom = new SerialEEPROM({ addressBits: 6, dataBits: 16, read: '0110', write: '0101', erase: '0111' });
    this.nvram = this.eeprom.data;             // settings and high scores
    this.inp = new Uint16Array(3).fill(0xFFFF);
    this.button3 = 'Heavy';
    this.reset();
  }

  reset() {
    super.reset();
    if (!this.obj1) return;                    // (the CPS-1 constructor's reset)
    for (const a of [this.objOut, this.obj1, this.obj2, this.objBuf2, this.qram1, this.qram2]) a.fill(0);
    this.objBank = 0; this.bank = 0; this.zHeld = 1; this.line1 = this.line2 = 262; this.priCtrl = 0;
    this.zIrqCarry = 0;
    this.qs.reset();
    this.eeprom.reset();
    this.cpu.reset(); this.snd.reset();
  }

  // ---------------------------------------------------------------- 68000 bus

  read16(a) {
    if (a < 0x400000) { const r = this.roms.main; return (r[a] << 8) | r[a + 1]; }
    if (a >= 0xFF0000) { const o = a & 0xFFFF; return (this.ram[o] << 8) | this.ram[o + 1]; }
    if (a >= 0x900000 && a < 0x930000) { const o = a - 0x900000; return (this.gfxram[o] << 8) | this.gfxram[o + 1]; }
    if (a >= 0x708000 && a < 0x710000) return (this.objBank ? this.obj1 : this.obj2)[(a & 0x1FFF) >> 1];
    if (a >= 0x618000 && a < 0x61A000) return 0xFF00 | this.qram1[(a - 0x618000) >> 1];
    if (a >= 0x400000 && a < 0x40000C) return this.objOut[(a - 0x400000) >> 1];
    if (a >= 0x804100 && a < 0x804200) return this.io(a & 0x1FF);
    if (a >= 0x800100 && a < 0x800200) return this.io(a & 0x1FF);
    switch (a) {
      case 0x804000: return this.inp[0];
      case 0x804010: return this.inp[1];
      case 0x804020: return (this.inp[2] & 0xFFFE) | this.eeprom.readBit();
      case 0x804030: return 0xE021;              // volume; no extra memory or network board
      case 0x8040B0: case 0x8040B2: return 0xFFFF;
    }
    return 0xFFFF;
  }

  write16(a, v) {
    if (a >= 0xFF0000) { const o = a & 0xFFFF; this.ram[o] = v >> 8; this.ram[o + 1] = v; return; }
    if (a >= 0x900000 && a < 0x930000) { const o = a - 0x900000; this.gfxram[o] = v >> 8; this.gfxram[o + 1] = v; return; }
    this.writeOther(a, v, 3);
  }
  write8(a, v) {
    if (a >= 0xFF0000) { this.ram[a & 0xFFFF] = v; return; }
    if (a >= 0x900000 && a < 0x930000) { this.gfxram[a - 0x900000] = v; return; }
    this.writeOther(a & ~1, a & 1 ? v : v << 8, a & 1 ? 1 : 2);
  }
  // mask: 1 low byte, 2 high byte, 3 both.
  writeOther(a, v, mask) {
    const merge = (old) => (mask === 3 ? v : mask === 1 ? (old & 0xFF00) | (v & 0xFF) : (old & 0xFF) | (v & 0xFF00)) & 0xFFFF;
    if (a >= 0x708000 && a < 0x710000) { const arr = this.objBank ? this.obj1 : this.obj2, i = (a & 0x1FFF) >> 1; arr[i] = merge(arr[i]); return; }
    if (a >= 0x700000 && a < 0x702000) { const arr = this.objBank ? this.obj2 : this.obj1, i = (a & 0x1FFF) >> 1; arr[i] = merge(arr[i]); return; }
    if (a >= 0x618000 && a < 0x61A000) { if (mask & 1) this.qram1[(a - 0x618000) >> 1] = v & 0xFF; return; }
    if (a >= 0x400000 && a < 0x40000C) { const i = (a - 0x400000) >> 1; this.objOut[i] = merge(this.objOut[i]); return; }
    if ((a >= 0x804100 && a < 0x804200) || (a >= 0x800100 && a < 0x800200)) {
      const o = a & 0x1FF;
      this.ioWrite(o, v, mask);
      if (o === 0x150) this.line1 = this.out[0x50 >> 1] & 0x1FF;   // raster interrupt lines
      if (o === 0x152) this.line2 = this.out[0x52 >> 1] & 0x1FF;
      return;
    }
    if (a === 0x804040) {
      if (mask & 2) {                            // EEPROM: data, clock, select (active low)
        this.eeprom.writeBit(v & 0x1000);
        this.eeprom.setReset(!(v & 0x4000));
        this.eeprom.setClock(v & 0x2000);
      }
      if (mask & 1) {                            // bit 3 lets the Z80 run
        const held = v & 0x08 ? 0 : 1;
        if (held && !this.zHeld) this.snd.reset();
        this.zHeld = held;
      }
      return;
    }
    if (a === 0x8040E0 && (mask & 1)) this.objBank = v & 1;
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0xC000) return this.roms.sound[0x10000 + (this.bank & 0x0F) * 0x4000 + (a - 0x8000)] ?? 0xFF;
    if (a < 0xD000) return this.qram1[a - 0xC000];
    if (a === 0xD007) return this.qs.status();
    if (a >= 0xF000) return this.qram2[a - 0xF000];
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0xC000 && a < 0xD000) { this.qram1[a - 0xC000] = v; return; }
    if (a >= 0xF000) { this.qram2[a - 0xF000] = v; return; }
    switch (a) {
      case 0xD000: this.qs.dataHigh(v); break;
      case 0xD001: this.qs.dataLow(v); break;
      case 0xD002: this.qs.command(v); break;
      case 0xD003: this.bank = v & 0x0F; break;
    }
  }

  // ---------------------------------------------------------------- inputs

  // IN0: right, left, down, up, punches (light, medium, heavy) for player 1 in the low byte.
  // IN1: kicks. IN2: EEPROM, service, starts (8/9), coins (12/13), all active low.
  setInputs(s) {
    const p = this.constructor.buttons2;
    let in0 = (s.right ? 1 : 0) | (s.left ? 2 : 0) | (s.down ? 4 : 0) | (s.up ? 8 : 0), in1 = 0;
    for (const [flag, port, bit] of p) if (s[flag]) { if (port === 0) in0 |= bit; else in1 |= bit; }
    this.inp[0] = 0xFFFF & ~in0;
    this.inp[1] = 0xFFFF & ~in1;
    this.inp[2] = 0xFFFF & ~((s.start1 ? 0x100 : 0) | (s.start2 ? 0x200 : 0) | (s.coin ? 0x1000 : 0));
  }
  applySwitches() {}

  // ---------------------------------------------------------------- frame

  runFrame() {
    const cycles = CPU_CLOCK / REFRESH / LINES, zCycles = Z80_CLOCK / REFRESH / LINES;
    const samples = RATE / REFRESH / LINES, zIrq = Z80_IRQ_HZ / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === this.line1 || line === this.line2) this.cpu.irq = Math.max(this.cpu.irq, 4);
      if (line === 256 - 16 + TOP) {             // vertical blank
        this.render();
        this.priCtrl = this.objOut[2];
        this.objBuf2.set(this.objBank ? this.obj2 : this.obj1);
        this.cpu.irq = 2;
        this.frameCount = (this.frameCount + 1) >>> 0;
      }
      this.cycleCarry += cycles;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      if (!this.zHeld) {
        this.zIrqCarry += zIrq;
        if (this.zIrqCarry >= 1) { this.zIrqCarry -= 1; this.snd.irqVector = 0xFF; this.snd.irq = true; }
        this.zCarry += zCycles;
        this.zCarry -= this.snd.run(Math.floor(this.zCarry));
      }
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    this.buildPalette();
    const out = this.native, pal = this.palette;
    out.fill(pal[4095]);
    this.mask.fill(0);
    this.pri.fill(0);
    const layerCtl = this.out[this.cpsb.layer >> 1], en = this.cpsb.enable, pc = this.priCtrl;
    let l = [(layerCtl >> 6) & 3, (layerCtl >> 8) & 3, (layerCtl >> 10) & 3, (layerCtl >> 12) & 3];
    let lp = l.map((n) => (pc >> (4 * n)) & 15);
    // Take the CPS-1 sprite slot out of the order: three tile layers remain.
    const order = [], pris = [];
    l.forEach((n, i) => { if (n !== 0) { order.push(n); pris.push(lp[i]); } });
    const [p0, p1, p2] = pris;
    let mask0 = 0xAA, mask1 = 0xCC;
    if (p0 > p1) mask0 &= ~0x88;
    if (p0 > p2) mask0 &= ~0xA0;
    if (p1 > p2) mask1 &= ~0xC0;
    const primasks = [0xFF];
    for (let i = 1; i < 8; i++) {
      if (i <= p0 && i <= p1 && i <= p2) { primasks[i] = 0xFE; continue; }
      primasks[i] = (i <= p0 ? mask0 : 0) | (i <= p1 ? mask1 : 0) | (i <= p2 ? 0xF0 : 0);
    }
    order.slice(0, 3).forEach((n, k) => { if (layerCtl & en[n - 1]) this.drawLayer(n, false, 1 << k); });
    this.drawSprites2(primasks);
  }

  drawSprites2(primasks) {
    const base = this.objBuf2, pix = this.pixels, out = this.native, pal = this.palette, pri = this.pri, taken = this.taken;
    taken.fill(0);
    let last = OBJ_WORDS - 4;
    for (let o = 0; o < OBJ_WORDS; o += 4) {
      if (base[o + 1] >= 0x8000 || base[o + 3] >= 0xFF00) { last = o - 4; break; }
    }
    const xoffs = 64 - this.objOut[4], yoffs = 16 - this.objOut[5];
    const draw = (code, col, fx, fy, sx, sy, pmask) => {
      if (code >= this.count16) return;
      const colBase = col * 16;
      for (let y = 0; y < 16; y++) {
        const py = sy + y - TOP;
        if (py < 0 || py >= H) continue;
        const src = code * 256 + (fy ? 15 - y : y) * 16;
        for (let x = 0; x < 16; x++) {
          const px = sx + x - LEFT;
          if (px < 0 || px >= W) continue;
          const pen = pix[src + (fx ? 15 - x : x)];
          if (pen === 15) continue;
          const o = py * W + px;
          if (taken[o]) continue;
          taken[o] = 1;
          if (!((pmask >> pri[o]) & 1)) out[o] = pal[colBase + pen];
        }
      }
    };
    for (let i = last; i >= 0; i -= 4) {
      let x = base[i], y = base[i + 1];
      const pmask = primasks[(x >> 13) & 7];
      const code = base[i + 2] + ((y & 0x6000) << 3), attr = base[i + 3], col = attr & 0x1F;
      if (attr & 0x80) { x += this.objOut[4]; y += this.objOut[5]; }
      const fx = attr & 0x20, fy = attr & 0x40;
      if (!(attr & 0xFF00)) { draw(code, col, fx, fy, (x + xoffs) & 0x3FF, (y + yoffs) & 0x3FF, pmask); continue; }
      const nx = ((attr >> 8) & 15) + 1, ny = ((attr >> 12) & 15) + 1;
      for (let j = 0; j < ny; j++) {
        for (let k = 0; k < nx; k++) {
          const sx = (x + k * 16 + xoffs) & 0x3FF, sy = (y + j * 16 + yoffs) & 0x3FF;
          const cx = fx ? nx - 1 - k : k, cy = fy ? ny - 1 - j : j;
          const c = !fx && !fy ? (code & ~0xF) + ((code + k) & 0xF) + 0x10 * j : code + cx + 0x10 * cy;
          draw(c, col, fx, fy, sx, sy, pmask);
        }
      }
    }
  }
}

// Marvel Super Heroes (1995): punches and kicks; three of the six buttons are on screen
// (medium punch, medium kick, heavy punch); a keyboard or gamepad can reach the rest.
export class MarvelSuperHeroes extends CPS2 {}
MarvelSuperHeroes.id = 'msh';
MarvelSuperHeroes.title = 'Marvel Super Heroes';
MarvelSuperHeroes.config = { cpsb: 'NOBATTRY', banks: [4, 4, 4], cps2: true, in0: 0xFF, map: [], dsw: [0xFF, 0xFF, 0xFF], buttons: 3, button2: 'Kick' };
MarvelSuperHeroes.switches = [];
// [input flag, port (0 punches / 1 kicks), bit]
MarvelSuperHeroes.buttons2 = [['fire', 0, 0x20], ['fire2', 1, 0x02], ['fire3', 0, 0x40]];
