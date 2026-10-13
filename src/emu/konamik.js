// Konami boards of 1987-90 built around the K052109 tilemaps and K051960
// sprites (see konamiic.js): Aliens, Crime Fighters, Super Contra, Gang
// Busters, Ajax and Bottom of the Ninth on 8-bit CPUs (the 052001/052526
// "Konami" CPU or a 6809), with a Z80 for sound driving a YM2151 and one or
// two K007232s. TMNT and M.I.A. put the same chips behind a 68000 (tmnt.js).
//
// The visible picture is a 288x224 window (x 112-399, y 16-239) of the
// chips' 512x256 bitmap. Colors are xBBBBBGGGGGRRRRR, two bytes each.

import { KonamiCPU } from './konami.js';
import { M6809 } from './m6809.js';
import { Z80 } from './z80.js';
import { YM2151 } from './ym2151.js';
import { K007232 } from './k007232.js';
import { K052109, K051960, K051316, deinterleave2 } from './konamiic.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba, rotate90 } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const WIN = { x: 112, y: 16, w: 288, h: 224 };
const LINES = 256, VBLANK = 240, REFRESH = 60;
const SOUND_CLOCK = 3579545;

export class KonamiBoard {
  saveState() { return capture(this, this.stateFields()); }
  loadState(s) { apply(this, this.stateFields(), s); this.rebuildPalette(); }
  stateFields() {
    return ['ram', 'palRam', 'soundRam', 'bank', 'latch', 'in', 'cycleCarry', 'soundCarry', 'sampleCarry',
      'cpu', 'snd', 'tiles', 'sprites', 'ym', 'k007232', ...(this.extraState || [])];
  }

  // cfg: { colors, rotate, k007232: [sample ROM, ...] }; the game creates its CPU in makeCpu().
  constructor(roms, cfg) {
    this.cfg = cfg;
    this.roms = roms;
    this.rotated = !!cfg.rotate;
    this.width = cfg.rotate ? WIN.h : WIN.w;
    this.height = cfg.rotate ? WIN.w : WIN.h;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Jump';
    this.ram = new Uint8Array(0x2000);
    this.palRam = new Uint8Array(cfg.colors * 2);
    this.soundRam = new Uint8Array(0x800);
    this.palette = new Uint32Array(cfg.colors).fill(0xFF000000);
    this.tiles = new K052109(deinterleave2(roms.tiles), (l, b, c, col) => this.tileCallback(l, b, c, col));
    this.sprites = new K051960(deinterleave2(roms.sprites), (c, col) => this.spriteCallback(c, col));
    this.cpu = this.makeCpu();
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.ym = new YM2151(SOUND_CLOCK, 0.6);
    this.k007232 = (cfg.samples || [roms.samples]).map((rom) => new K007232(SOUND_CLOCK, rom, 1));
    this.sound = new SoundMix([this.ym, ...this.k007232], 1);
    this.native = new Uint32Array(WIN.w * WIN.h);
    this.pri = new Uint8Array(WIN.w * WIN.h);
    this.frame = cfg.rotate ? new Uint32Array(WIN.w * WIN.h) : this.native;
    this.in = new Uint8Array(4).fill(0xFF);
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0); this.palRam.fill(0); this.soundRam.fill(0); this.palette.fill(0xFF000000);
    this.bank = 0; this.latch = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.tiles.reset(); this.sprites.reset();
    this.cpu.reset(); this.snd.reset(); this.ym.reset(); this.k007232.forEach((k) => k.reset());
  }

  // ---------------------------------------------------------------- shared pieces

  setColor(i) {
    const c = (this.palRam[i * 2] << 8) | this.palRam[i * 2 + 1];
    const l = (v) => (v << 3) | (v >> 2);
    this.palette[i] = rgba(l(c & 31), l((c >> 5) & 31), l((c >> 10) & 31));
  }
  writePalette(o, v) { this.palRam[o] = v; this.setColor(o >> 1); }
  rebuildPalette() { for (let i = 0; i < this.palette.length; i++) this.setColor(i); }

  // The K052109 / 051937 / K051960 window (16K): 3800-3807 sprite
  // registers, 3C00-3FFF sprite RAM, the rest the tilemap chip.
  videoRead(o) {
    if (this.tiles.rmrd) return this.tiles.read(o);
    if (o >= 0x3800 && o < 0x3808) return this.sprites.readReg(o - 0x3800);
    if (o < 0x3C00) return this.tiles.read(o);
    return this.sprites.read(o - 0x3C00);
  }
  videoWrite(o, v) {
    if (o >= 0x3800 && o < 0x3808) this.sprites.writeReg(o - 0x3800, v);
    else if (o < 0x3C00) this.tiles.write(o, v);
    else this.sprites.write(o - 0x3C00, v);
  }

  // ---------------------------------------------------------------- frame

  // Per-line slices for the CPUs and timers; the main CPU's vblank interrupt.
  runFrame() {
    const mainLine = this.cfg.clock / REFRESH / LINES, soundLine = SOUND_CLOCK / REFRESH / LINES;
    const samples = RATE / REFRESH / LINES, dt = 1 / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK) { this.vblank(); this.render(); }
      this.lineHook?.(line);
      this.cycleCarry += mainLine;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.runSubs?.(mainLine);
      this.ym.timers(dt);
      this.soundIrq?.();
      this.soundCarry += soundLine;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }
  vblank() { if (this.sprites.irqEnabled) this.cpu.irq = true; }

  finish() { if (this.rotated) rotate90(this.native, WIN.w, WIN.h, this.frame); }
  clear(color) { this.native.fill(color); this.pri.fill(0); }

  // Standard inputs, active low: stick left/right/up/down, two buttons; the
  // coin and start bits live wherever each board puts them.
  stick(s) { return 0xFF & ~((s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0) | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0) | (s.fire3 ? 0x40 : 0)); }
}

// The Konami CPU with its bank lines wired to the board.
function konamiCpu(board) {
  const cpu = new KonamiCPU({ read: (a) => board.read(a), write: (a, v) => board.write(a, v) });
  cpu.onTaken = (kind) => { if (kind === 'irq') cpu.irq = false; else cpu.firq = false; };
  cpu.onSetLines = (v) => board.setLines(v);
  return cpu;
}

// ---------------------------------------------------------------- Aliens

// Aliens (1990): work RAM at 0000-03FF can be switched to show the palette;
// the bank lines pick a ROM page for 2000-3FFF. Sprites sit at four priority
// levels against the three layers.
export class Aliens extends KonamiBoard {
  constructor(roms) {
    super(roms, { clock: 3000000, colors: 512 });
    this.extraState = ['palSelect'];
    this.palSelect = 0;
    // The K007232's port sets its channel volumes; the YM2151's CT pins its sample banks.
    const k = this.k007232[0];
    k.onPort = (v) => { k.setVolume(0, (v & 15) / 15); k.setVolume(1, (v >> 4) / 15); };
    this.ym.onPort = (v) => k.setBank((v >> 1) & 1, v & 1);
  }
  makeCpu() { return konamiCpu(this); }
  setLines(v) { this.bank = 0x18000 - (v & 0x10 ? 0x8000 : 0) + (v & 0x0F) * 0x2000; }
  reset() { super.reset(); this.bank = 0x10000; this.palSelect = 0; }

  read(a) {
    if (a < 0x400) return this.palSelect ? this.palRam[a] : this.ram[a];
    if (a < 0x2000) return this.ram[a];
    if (a < 0x4000) return this.roms.main[this.bank + a - 0x2000] ?? 0xFF;
    if (a >= 0x8000) return this.roms.main[a];
    switch (a) {
      case 0x5F80: return this.dsw3;
      case 0x5F81: return this.in[0];
      case 0x5F82: return this.in[1];
      case 0x5F83: return this.dsw2;
      case 0x5F84: return this.dsw1;
      case 0x5F88: return 0;
    }
    return this.videoRead(a - 0x4000);
  }
  write(a, v) {
    if (a < 0x400) { if (this.palSelect) this.writePalette(a, v); else this.ram[a] = v; return; }
    if (a < 0x2000) { this.ram[a] = v; return; }
    if (a < 0x4000 || a >= 0x8000) return;
    if (a === 0x5F88) { this.palSelect = v & 0x20; this.tiles.rmrd = v & 0x40; return; }
    if (a === 0x5F8C) { this.latch = v; this.snd.irqVector = 0xFF; this.snd.irq = true; return; }
    this.videoWrite(a - 0x4000, v);
  }

  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0x8800) return this.soundRam[a - 0x8000];
    if (a === 0xA001) return this.ym.read();
    if (a === 0xC000) return this.latch;
    if (a >= 0xE000 && a < 0xE00E) return this.k007232[0].read(a & 15);
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0x8000 && a < 0x8800) this.soundRam[a - 0x8000] = v;
    else if (a === 0xA000) this.ym.select(v);
    else if (a === 0xA001) this.ym.write(v);
    else if (a >= 0xE000 && a < 0xE00E) this.k007232[0].write(a & 15, v);
  }

  tileCallback(layer, bank, code, color) {
    return { code: code | ((color & 0x3F) << 8) | (bank << 14), color: [0, 4, 8][layer] + ((color & 0xC0) >> 6) };
  }
  // The sprite's priority against the layers (A 1, B 2, F 4 in the priority buffer).
  spriteCallback(code, color) {
    const mask = { 0x10: 0, 0x00: 0xF0, 0x40: 0xFC, 0x20: 0xFE, 0x60: 0xFE, 0x50: 0xCC, 0x30: 0xEE, 0x70: 0xEE }[color & 0x70];
    return { code: code | ((color & 0x80) << 6), color: 16 + (color & 0x0F), priority: mask, shadow: 0 };
  }

  render() {
    const p = this.palette;
    this.clear(p[4 * 16]);
    this.tiles.draw(1, this.native, this.pri, p, WIN, { priority: 1 });
    this.tiles.draw(2, this.native, this.pri, p, WIN, { priority: 2 });
    this.tiles.draw(0, this.native, this.pri, p, WIN, { priority: 4 });
    this.sprites.draw(this.native, this.pri, p, WIN, { mask: true });
    this.finish();
  }

  // IN0/IN1: player 1 / 2 stick, two buttons, coin (40), start (80).
  setInputs(s) {
    this.in[0] = this.stick(s) & ~((s.coin ? 0x40 : 0) | (s.start1 ? 0x80 : 0));
    this.in[1] = 0xFF & ~(s.start2 ? 0x80 : 0);
  }
  // DSW1 coinage 1/1; DSW2 lives, difficulty, demo sounds; DSW3 no flip, service off.
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = 0x1C | v.lives | v.difficulty; this.dsw3 = 0xFF; }
}
Aliens.id = 'aliens';
Aliens.title = 'Aliens';
Aliens.switches = [
  { id: 'lives', label: 'Lives', options: [['1', 0x03], ['2', 0x02], ['3', 0x01], ['5', 0x00]], default: 0x02 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Very hard', 0x00]], default: 0x40 },
];

// ---------------------------------------------------------------- Ajax

// Ajax (1987): the Konami CPU runs the game and the sprites; a 6809 drives
// the tilemaps and the K051316 rotate/zoom layer (the 3D stages, 7-bit
// graphics), sharing 8K of RAM. The main CPU kicks the 6809 with an FIRQ.
// Two K007232s and a YM2151 for sound. Vertical monitor.
export class Ajax extends KonamiBoard {
  constructor(roms) {
    super(roms, { clock: 3000000, colors: 2048, rotate: true, samples: [roms.samples1, roms.samples2] });
    this.buttons = 3; this.button2 = 'Missile'; this.button3 = 'Super';
    this.extraState = ['shared', 'subBank', 'firqEnable', 'priority', 'subCarry', 'sub', 'zoom', 'sndBank'];
    this.shared = new Uint8Array(0x2000);
    this.zoom = new K051316(roms.zoom, 7, (code, color) => ({ code: code | ((color & 7) << 8), color: 6 + ((color & 8) >> 3) }));
    this.sub = new M6809({ read: (a) => this.subRead(a), write: (a, v) => this.subWrite(a, v) });
    this.sub.onTaken = (kind) => { if (kind === 'firq') this.sub.firq = false; };
    const [k1, k2] = this.k007232;
    k1.onPort = (v) => { k1.setVolume(0, (v >> 4) / 15); k1.setVolume(1, (v & 15) / 15); };
    k2.onPort = (v) => k2.setVolume(1, ((v & 15) + (v >> 4)) / 30);
    k1.gain = 0.4; k2.gain = 1;
    this.reset();
  }
  makeCpu() { return konamiCpu(this); }
  setLines() {}
  reset() {
    super.reset();
    if (!this.sub) return;
    this.shared.fill(0); this.zoom.reset();
    this.bank = 0x10000; this.subBank = 0x10000; this.firqEnable = 1; this.priority = 0; this.subCarry = 0; this.sndBank = 0;
    this.sub.reset();
  }
  runSubs(cycles) { this.subCarry += cycles; this.subCarry -= this.sub.run(Math.floor(this.subCarry)); }

  // ---- main CPU (052001)
  read(a) {
    if (a < 0x200) {
      switch ((a & 0x1C0) >> 6) {
        case 4: return this.in[1];                                  // player 2
        case 6: return a & 2 ? [this.dsw1, this.dsw2][a & 1] : this.in[(a & 1) ? 2 : 0];
        case 7: return this.dsw3;
      }
      // 0000-003F: nothing drives the bus; the game walks a list from here
      // and needs a non-zero byte to leave it (MAME returns random data).
      return ((this.cpu.cycles * 0x9E37) >>> 7) & 0xFF;
    }
    if (a >= 0x800 && a < 0x808) return this.sprites.readReg(a - 0x800);
    if (a >= 0xC00 && a < 0x1000) return this.sprites.read(a - 0xC00);
    if (a >= 0x1000 && a < 0x2000) return this.palRam[a - 0x1000];
    if (a >= 0x2000 && a < 0x4000) return this.shared[a - 0x2000];
    if (a >= 0x4000 && a < 0x6000) return this.ram[a - 0x4000];
    if (a >= 0x6000 && a < 0x8000) return this.roms.main[this.bank + a - 0x6000] ?? 0xFF;
    if (a >= 0x8000) return this.roms.main[a];
    return 0xFF;
  }
  write(a, v) {
    if (a < 0x200) {
      switch ((a & 0x1C0) >> 6) {
        case 0: if (!a && this.firqEnable) this.sub.firq = true; break;   // (0020: watchdog)
        case 1: this.snd.irq = true; break;
        case 2: this.latch = v; break;
        case 3:                                                     // ROM bank, layer priority
          this.bank = 0x10000 + (v & 0x80 ? 0 : 0x8000) + (v & 7) * 0x2000;
          this.priority = v & 0x08;
          break;
        // 5: lamps and the joystick vibration motor
      }
      return;
    }
    if (a >= 0x800 && a < 0x808) this.sprites.writeReg(a - 0x800, v);
    else if (a >= 0xC00 && a < 0x1000) this.sprites.write(a - 0xC00, v);
    else if (a >= 0x1000 && a < 0x2000) this.writePalette(a - 0x1000, v);
    else if (a >= 0x2000 && a < 0x4000) this.shared[a - 0x2000] = v;
    else if (a >= 0x4000 && a < 0x6000) this.ram[a - 0x4000] = v;
  }

  // ---- video CPU (6809)
  subRead(a) {
    if (a < 0x800) return this.zoom.read(a);
    if (a >= 0x1000 && a < 0x1800) return this.zoom.readRom(a - 0x1000);
    if (a >= 0x2000 && a < 0x4000) return this.shared[a - 0x2000];
    if (a >= 0x4000 && a < 0x8000) return this.tiles.read(a - 0x4000);
    if (a >= 0x8000 && a < 0xA000) return this.roms.sub[this.subBank + a - 0x8000] ?? 0xFF;
    if (a >= 0xA000) return this.roms.sub[a];
    return 0xFF;
  }
  subWrite(a, v) {
    if (a < 0x800) this.zoom.write(a, v);
    else if (a >= 0x800 && a < 0x810) this.zoom.writeCtrl(a - 0x800, v);
    else if (a === 0x1800) {                                        // ROM bank, ROM reading, wraparound, FIRQ enable
      this.tiles.rmrd = v & 0x40; this.zoom.wrap = v & 0x20; this.firqEnable = v & 0x10;
      this.subBank = 0x10000 + (v & 0x0F) * 0x2000;
    }
    else if (a >= 0x2000 && a < 0x4000) this.shared[a - 0x2000] = v;
    else if (a >= 0x4000 && a < 0x8000) this.tiles.write(a - 0x4000, v);
  }

  // ---- sound CPU (Z80)
  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0x8800) return this.soundRam[a - 0x8000];
    if (a >= 0xA000 && a < 0xA00E) return this.k007232[0].read(a & 15);
    if (a >= 0xB000 && a < 0xB00E) return this.k007232[1].read(a & 15);
    if (a === 0xC001) return this.ym.read();
    if (a === 0xE000) return this.latch;
    return 0xFF;
  }
  soundWrite(a, v) {
    const [k1, k2] = this.k007232;
    if (a >= 0x8000 && a < 0x8800) this.soundRam[a - 0x8000] = v;
    else if (a === 0x9000) { this.sndBank = v; k1.setBank((v >> 1) & 1, v & 1); k2.setBank((v >> 4) & 3, (v >> 2) & 3); }
    else if (a >= 0xA000 && a < 0xA00E) k1.write(a & 15, v);
    else if (a === 0xB80C) k2.setVolume(0, (v & 15) / 15);
    else if (a >= 0xB000 && a < 0xB00E) k2.write(a & 15, v);
    else if (a === 0xC000) this.ym.select(v);
    else if (a === 0xC001) this.ym.write(v);
  }

  tileCallback(layer, bank, code, color) {
    return { code: code | ((color & 0x0F) << 8) | (bank << 12), color: [64, 0, 32][layer] + ((color & 0xF0) >> 4) };
  }
  // Priority buffer: B 1, A 2, zoom 4, F 8. Sprites never cover F; the color
  // byte's bits 4-6 decide whether they go under the zoom layer, A and B.
  spriteCallback(code, color) {
    let mask = 0xFF00;
    if (color & 0x10) mask |= 0xF0F0;
    if (~color & 0x40) mask |= 0xCCCC;
    if (color & 0x20) mask |= 0xAAAA;
    return { code, color: 16 + (color & 0x0F), priority: mask };
  }

  render() {
    const p = this.palette, f = this.native, pr = this.pri;
    this.clear(0xFF000000);
    this.tiles.draw(2, f, pr, p, WIN, { priority: 1 });
    if (this.priority) { this.zoom.draw(f, pr, p, WIN, { priority: 4 }); this.tiles.draw(1, f, pr, p, WIN, { priority: 2 }); }
    else { this.tiles.draw(1, f, pr, p, WIN, { priority: 2 }); this.zoom.draw(f, pr, p, WIN, { priority: 4 }); }
    this.tiles.draw(0, f, pr, p, WIN, { priority: 8 });
    this.sprites.draw(f, pr, p, WIN, { mask: true });
    this.finish();
  }

  // IN0: coin (01), starts (08, 10); IN1/IN2: player 1/2 stick and three buttons.
  setInputs(s) {
    this.in[0] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in[2] = this.stick(s);
    this.in[1] = 0xFF;
  }
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = v.lives | v.bonus | v.difficulty; this.dsw3 = 0xFF; }
}
Ajax.id = 'ajax';
Ajax.title = 'Ajax';
Ajax.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x03], ['3', 0x02], ['5', 0x01], ['7', 0x00]], default: 0x02 },
  { id: 'bonus', label: 'Bonus', options: [['30K 150K', 0x18], ['50K 200K', 0x10], ['30K', 0x08], ['50K', 0x00]], default: 0x10 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Very hard', 0x00]], default: 0x40 },
];

// ---------------------------------------------------------------- Crime Fighters

// Crime Fighters (1989, US 4-player): like Aliens, with the bank lines also
// switching the palette in at 0000-03FF and enabling ROM reads; no start
// buttons (each player's coin slot starts them). Sprites sit at one of three
// depths between the layers.
export class CrimeFighters extends KonamiBoard {
  constructor(roms) {
    super(roms, { clock: 3000000, colors: 512 });
    this.extraState = ['palSelect'];
    this.palSelect = 0;
    const k = this.k007232[0];
    k.onPort = (v) => { k.setVolume(0, (v & 15) / 15); k.setVolume(1, (v >> 4) / 15); };
    this.ym.onPort = (v) => k.setBank((v >> 1) & 1, v & 1);
  }
  makeCpu() { return konamiCpu(this); }
  setLines(v) { this.palSelect = v & 0x20; this.tiles.rmrd = v & 0x40; this.bank = 0x10000 + (v & 0x0F) * 0x2000; }
  reset() { super.reset(); this.bank = 0x10000; this.palSelect = 0; }
  vblank() { this.cpu.irq = true; }

  read(a) {
    if (a < 0x400) return this.palSelect ? this.palRam[a] : this.ram[a];
    if (a < 0x2000) return this.ram[a];
    if (a >= 0x6000 && a < 0x8000) return this.roms.main[this.bank + a - 0x6000] ?? 0xFF;
    if (a >= 0x8000) return this.roms.main[a];
    switch (a) {
      case 0x3F80: return this.in[3];                    // coins
      case 0x3F81: return this.in[0];
      case 0x3F82: return this.in[1];
      case 0x3F83: return this.dsw2;
      case 0x3F84: return this.dsw3;
      case 0x3F85: case 0x3F86: return 0xFF;            // players 3 and 4
      case 0x3F87: return this.dsw1;
      case 0x3F88: return 0;
    }
    return a < 0x6000 ? this.videoRead(a - 0x2000) : 0xFF;
  }
  write(a, v) {
    if (a < 0x400) { if (this.palSelect) this.writePalette(a, v); else this.ram[a] = v; return; }
    if (a < 0x2000) { this.ram[a] = v; return; }
    if (a === 0x3F8C) { this.latch = v; this.snd.irqVector = 0xFF; this.snd.irq = true; return; }
    if (a === 0x3F88) return;
    if (a < 0x6000) this.videoWrite(a - 0x2000, v);
  }
  soundRead(a) { return Aliens.prototype.soundRead.call(this, a); }
  soundWrite(a, v) { Aliens.prototype.soundWrite.call(this, a, v); }

  tileCallback(layer, bank, code, color) {
    return { code: code | ((color & 0x1F) << 8) | (bank << 13), color: [0, 4, 8][layer] + ((color & 0xC0) >> 6), flags: color & 0x20 ? 1 : 0 };
  }
  spriteCallback(code, color) {
    const p = { 0x10: 0, 0x00: 1, 0x40: 2, 0x20: 3, 0x60: 3, 0x50: 3, 0x30: 3, 0x70: 3 }[color & 0x70];
    return { code, color: 16 + (color & 0x0F), priority: p };
  }

  render() {
    const p = this.palette, f = this.native, pr = this.pri;
    this.clear(p[0]);
    this.tiles.draw(1, f, pr, p, WIN, { opaque: true });
    this.sprites.draw(f, pr, p, WIN, { min: 2, max: 2 });
    this.tiles.draw(2, f, pr, p, WIN);
    this.sprites.draw(f, pr, p, WIN, { min: 1, max: 1 });
    this.tiles.draw(0, f, pr, p, WIN);
    this.sprites.draw(f, pr, p, WIN, { min: 0, max: 0 });
    this.finish();
  }

  // Coin 1 inserts and starts player 1; the start button does the same here.
  setInputs(s) {
    this.in[0] = this.stick(s);
    this.in[1] = 0xFF;
    this.in[3] = 0xFF & ~(s.coin || s.start1 ? 0x01 : 0);
  }
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = 0x1F | v.difficulty; this.dsw3 = 0xFB; }
}
CrimeFighters.id = 'crimfght';
CrimeFighters.title = 'Crime Fighters';
CrimeFighters.switches = [
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Very hard', 0x00]], default: 0x40 },
];

// ---------------------------------------------------------------- Super Contra

// Super Contra (1988): palette or work RAM at 5800-5FFF, a ROM bank at
// 6000-7FFF, and a priority bit that swaps the two scrolling layers; sprites
// tested against the priority buffer. Vertical monitor.
export class SuperContra extends KonamiBoard {
  constructor(roms) {
    super(roms, { clock: 3000000, colors: 1024, rotate: true });
    this.extraState = ['palSelect', 'priority'];
    this.palSelect = 0; this.priority = 0;
    const k = this.k007232[0];
    k.onPort = (v) => { k.setVolume(0, (v >> 4) / 15); k.setVolume(1, (v & 15) / 15); };
  }
  makeCpu() { return konamiCpu(this); }
  setLines() {}
  reset() { super.reset(); this.bank = 0x10000; this.palSelect = 0; this.priority = 0; }
  vblank() { if (this.tiles.irqEnabled) this.cpu.irq = true; }

  read(a) {
    switch (a) {
      case 0x1F90: return this.in[3];
      case 0x1F91: return this.in[0];
      case 0x1F92: return this.in[1];
      case 0x1F93: return this.dsw3;
      case 0x1F94: return this.dsw1;
      case 0x1F95: return this.dsw2;
    }
    if (a < 0x4000) return this.videoRead(a);
    if (a < 0x5800) return this.ram[a - 0x4000];
    if (a < 0x6000) return this.palSelect ? this.palRam[a - 0x5800] : this.ram[a - 0x4000];
    if (a < 0x8000) return this.roms.main[this.bank + a - 0x6000] ?? 0xFF;
    return this.roms.main[a];
  }
  write(a, v) {
    switch (a) {
      case 0x1F80: this.bank = 0x10000 + (v & 0x0F) * 0x2000; this.palSelect = ~v & 0x10; this.priority = v & 0x80; return;
      case 0x1F84: this.latch = v; return;
      case 0x1F88: this.snd.irqVector = 0xFF; this.snd.irq = true; return;
      case 0x1F8C: case 0x1F98: return;
    }
    if (a < 0x4000) this.videoWrite(a, v);
    else if (a < 0x5800) this.ram[a - 0x4000] = v;
    else if (a < 0x6000) { if (this.palSelect) this.writePalette(a - 0x5800, v); else this.ram[a - 0x4000] = v; }
  }

  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0x8800) return this.soundRam[a - 0x8000];
    if (a === 0xA000) return this.latch;
    if (a >= 0xB000 && a < 0xB00E) return this.k007232[0].read(a & 15);
    if (a === 0xC001) return this.ym.read();
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0x8000 && a < 0x8800) this.soundRam[a - 0x8000] = v;
    else if (a >= 0xB000 && a < 0xB00E) this.k007232[0].write(a & 15, v);
    else if (a === 0xC000) this.ym.select(v);
    else if (a === 0xC001) this.ym.write(v);
    else if (a === 0xF000) this.k007232[0].setBank(v & 3, (v >> 2) & 3);
  }

  tileCallback(layer, bank, code, color) {
    return { code: code | ((color & 0x1F) << 8) | (bank << 13), color: [48, 0, 16][layer] + ((color & 0xE0) >> 5) };
  }
  spriteCallback(code, color) {
    const mask = [0xF0, 0xFE, 0xFC, 0xFFFF][(color & 0x30) >> 4];
    return { code, color: 32 + (color & 0x0F), priority: mask };
  }

  render() {
    const p = this.palette, f = this.native, pr = this.pri;
    this.clear(0xFF000000);
    const [lower, upper] = this.priority ? [2, 1] : [1, 2];
    this.tiles.draw(lower, f, pr, p, WIN, { opaque: true, priority: 1 });
    this.tiles.draw(upper, f, pr, p, WIN, { priority: 2 });
    this.tiles.draw(0, f, pr, p, WIN, { priority: 4 });
    this.sprites.draw(f, pr, p, WIN, { mask: true });
    this.finish();
  }

  // Coins and starts in their own port (coin 01, starts 08 / 10); players' sticks and two buttons.
  setInputs(s) {
    this.in[3] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x08 : 0) | (s.start2 ? 0x10 : 0));
    this.in[0] = this.stick(s); this.in[1] = 0xFF;
  }
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = v.lives | v.bonus | v.difficulty; this.dsw3 = 0xFF; }
}
SuperContra.id = 'scontra';
SuperContra.title = 'Super Contra';
SuperContra.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x03], ['3', 0x02], ['5', 0x01], ['7', 0x00]], default: 0x02 },
  { id: 'bonus', label: 'Bonus', options: [['30K 200K', 0x18], ['50K 300K', 0x10], ['30K', 0x08], ['50K', 0x00]], default: 0x18 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Very hard', 0x00]], default: 0x40 },
];

// ---------------------------------------------------------------- Gang Busters

// Gang Busters (1988): Super Contra's map, with the ROM bank on the CPU's
// bank lines (the first bank mirrored at 18000) and sprites at depths
// between the layers. A shooting gallery: the stick moves the sight, the
// buttons shoot and throw grenades. Vertical monitor.
export class GangBusters extends SuperContra {
  constructor(roms) { super(roms); this.button2 = 'Grenade'; }
  setLines(v) { this.bank = 0x10000 + (v & 0x0F) * 0x2000; }
  write(a, v) {
    if (a === 0x1F80) { this.palSelect = ~v & 0x01; this.priority = v & 0x08; return; }
    if (a === 0x1F98) { this.tiles.rmrd = v & 0x01; return; }
    if (a === 0x1F9C) return;
    super.write(a, v);
  }
  soundWrite(a, v) {
    if (a === 0xF000) { this.k007232[0].setBank(v & 1, (v >> 2) & 1); return; }
    super.soundWrite(a, v);
  }
  tileCallback(layer, bank, code, color) {
    return { code: code | ((color & 0x0D) << 8) | ((color & 0x10) << 5) | (bank << 12), color: [48, 0, 16][layer] + ((color & 0xE0) >> 5) };
  }
  spriteCallback(code, color) { return { code, color: 32 + (color & 0x0F), priority: (color & 0x30) >> 4 }; }
  render() {
    const p = this.palette, f = this.native, pr = this.pri;
    this.clear(0xFF000000);
    const [lower, upper] = this.priority ? [2, 1] : [1, 2];
    this.tiles.draw(lower, f, pr, p, WIN, { opaque: true });
    this.sprites.draw(f, pr, p, WIN, { min: 2, max: 2 });
    this.tiles.draw(upper, f, pr, p, WIN);
    this.sprites.draw(f, pr, p, WIN, { min: 0, max: 0 });
    this.tiles.draw(0, f, pr, p, WIN);
    this.finish();
  }
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = 0x04 | v.lives | v.bonus | v.difficulty; this.dsw3 = 0xFF; }
}
GangBusters.id = 'gbusters';
GangBusters.title = 'Gang Busters';
GangBusters.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0x03], ['3', 0x02], ['5', 0x01], ['7', 0x00]], default: 0x02 },
  { id: 'bonus', label: 'Bonus', options: [['50K 200K 400K', 0x18], ['70K 250K 500K', 0x10], ['50K', 0x08], ['70K', 0x00]], default: 0x10 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Very hard', 0x00]], default: 0x40 },
];

// ---------------------------------------------------------------- Bottom of the Ninth

// Bottom of the Ninth (1989): a 6809 main CPU; 0000-07FF and 2000-27FF are
// switched between the tile chip and the K051316 / palette (the field is
// the zoom layer, rotated as the view swings). Sound is two K007232s on a
// Z80 that takes 8 NMIs a frame. Sprites go behind or in front of the field
// and the two scrolling layers.
export class BottomOfTheNinth extends KonamiBoard {
  constructor(roms) {
    super(roms, { clock: 2000000, colors: 1024, samples: [roms.samples1, roms.samples2] });
    this.buttons = 2; this.button2 = 'Button 2';
    this.extraState = ['videoSel', 'zoomRoms', 'nmiEnable', 'zoom'];
    this.zoom = new K051316(roms.zoom, 4, (code, color) => ({ code: code | ((color & 3) << 8), color: 48 + ((color & 0x3C) >> 2), flags: color & 0x40 ? 1 : 0 }));
    for (const k of this.k007232) k.onPort = (v) => { k.setVolume(0, (v >> 4) / 15); k.setVolume(1, (v & 15) / 15); };
    this.sound = new SoundMix(this.k007232, 0.8);
    this.reset();
  }
  makeCpu() {
    const cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    cpu.onTaken = (kind) => { if (kind === 'irq') cpu.irq = false; };
    return cpu;
  }
  reset() {
    super.reset();
    this.bank = 0x10000; this.videoSel = 0; this.zoomRoms = 0; this.nmiEnable = 0;
    if (this.zoom) this.zoom.reset();
  }
  vblank() { if (this.tiles.irqEnabled) this.cpu.irq = true; }
  lineHook(line) { if (this.nmiEnable && (line & 31) === 0) this.snd.nmi(); }

  read(a) {
    if (a < 0x800) return this.videoSel ? this.videoRead(a) : this.zoomRoms ? this.zoom.readRom(a) : this.zoom.read(a);
    switch (a) {
      case 0x1FD0: return this.in[3];
      case 0x1FD1: return this.in[0];
      case 0x1FD2: return this.in[1];
      case 0x1FD3: return this.dsw1;
      case 0x1FE0: return this.dsw2;
    }
    if (a >= 0x2000 && a < 0x2800) return this.videoSel ? this.videoRead(a) : this.palRam[a - 0x2000];
    if (a < 0x4000) return this.videoRead(a);
    if (a < 0x6000) return this.ram[a - 0x4000];
    if (a < 0x8000) return this.roms.main[this.bank + a - 0x6000] ?? 0xFF;
    return this.roms.main[a];
  }
  write(a, v) {
    if (a < 0x800) { if (this.videoSel) this.videoWrite(a, v); else this.zoom.write(a, v); return; }
    switch (a) {
      case 0x1F80: this.bank = v & 0x10 ? 0x20000 + (v & 6) * 0x1000 : 0x10000 + (v & 0x0E) * 0x1000; return;
      case 0x1F90: this.tiles.rmrd = v & 4; this.zoomRoms = v & 0x10; this.videoSel = v & 0x20; return;
      case 0x1FA0: return;
      case 0x1FB0: this.latch = v; return;
      case 0x1FC0: this.snd.irqVector = 0xFF; this.snd.irq = true; return;
    }
    if (a >= 0x1FF0 && a < 0x2000) { this.zoom.writeCtrl(a - 0x1FF0, v); return; }
    if (a >= 0x2000 && a < 0x2800) { if (this.videoSel) this.videoWrite(a, v); else this.writePalette(a - 0x2000, v); return; }
    if (a < 0x4000) this.videoWrite(a, v);
    else if (a < 0x6000) this.ram[a - 0x4000] = v;
  }

  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0x8800) return this.soundRam[a - 0x8000];
    if (a >= 0xA000 && a < 0xA00E) return this.k007232[0].read(a & 15);
    if (a >= 0xB000 && a < 0xB00E) return this.k007232[1].read(a & 15);
    if (a === 0xD000) return this.latch;
    return 0xFF;
  }
  soundWrite(a, v) {
    const [k1, k2] = this.k007232;
    if (a >= 0x8000 && a < 0x8800) this.soundRam[a - 0x8000] = v;
    else if (a === 0x9000) { k1.setBank(v & 3, (v >> 2) & 3); k2.setBank((v >> 4) & 3, (v >> 6) & 3); }
    else if (a >= 0xA000 && a < 0xA00E) k1.write(a & 15, v);
    else if (a >= 0xB000 && a < 0xB00E) k2.write(a & 15, v);
    else if (a === 0xF000) this.nmiEnable = v;
  }

  tileCallback(layer, bank, code, color) {
    return { code: code | ((color & 0x3F) << 8), color: [0, 0, 16][layer] + ((color & 0xC0) >> 6) };
  }
  spriteCallback(code, color) { return { code, color: 32 + (color & 0x0F), priority: (color & 0x30) >> 4 }; }

  render() {
    const p = this.palette, f = this.native, pr = this.pri;
    this.clear(p[0]);
    this.sprites.draw(f, pr, p, WIN, { min: 1, max: 1 });
    this.zoom.draw(f, pr, p, WIN);
    this.sprites.draw(f, pr, p, WIN, { min: 0, max: 0 });
    this.tiles.draw(2, f, pr, p, WIN);
    this.sprites.draw(f, pr, p, WIN, { min: 2, max: 3 });
    this.tiles.draw(1, f, pr, p, WIN);
    this.finish();
  }

  // P1: start (01), up, down, left, right, two buttons; coins in their own port.
  setInputs(s) {
    this.in[0] = 0xFF & ~((s.start1 ? 1 : 0) | (s.up ? 2 : 0) | (s.down ? 4 : 0) | (s.left ? 8 : 0) | (s.right ? 0x10 : 0) | (s.fire ? 0x20 : 0) | (s.fire2 ? 0x40 : 0));
    this.in[1] = 0xFF & ~(s.start2 ? 1 : 0);
    this.in[3] = 0xFF & ~(s.coin ? 0x01 : 0);
  }
  applySwitches(v) { this.dsw1 = 0xFF; this.dsw2 = v.time | 0x08 | v.difficulty; }
}
BottomOfTheNinth.id = 'bottom9';
BottomOfTheNinth.title = 'Bottom of the Ninth';
BottomOfTheNinth.switches = [
  { id: 'time', label: 'Play time', options: [["1'00", 0x07], ["1'10", 0x06], ["1'20", 0x05], ["1'30", 0x04], ["1'40", 0x03], ["1'50", 0x02], ["2'00", 0x01], ["2'10", 0x00]], default: 0x04 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x60], ['Normal', 0x40], ['Hard', 0x20], ['Very hard', 0x00]], default: 0x40 },
];
