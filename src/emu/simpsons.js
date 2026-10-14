// Konami's The Simpsons (1991, 4 players): the Konami CPU at 3 MHz, K052109
// tilemaps, K053246/K053247 sprites, the K053251 mixer, a Z80 with a YM2151
// and a K053260, and a serial EEPROM for settings and scores.
//
// The main CPU's 0000-0FFF shows the tilemap chip or the palette, and
// 2000-3FFF the tilemap chip or the sprite list plus extra RAM, by two bank
// bits written with the EEPROM lines. Each vblank (when enabled) the sprite
// chip copies the active entries of the list into its own RAM and raises an
// FIRQ when done; the tilemap chip raises the IRQ.
//
// Each player slot is a family member: Marge, Homer, Bart, Lisa.

import { KonamiCPU } from './konami.js';
import { Z80 } from './z80.js';
import { YM2151 } from './ym2151.js';
import { K053260 } from './k053260.js';
import { K052109, K053247, K053251, deinterleave2 } from './konamiic.js';
import { SerialEEPROM } from './eeprom.js';
import { SoundMix, RATE } from './mixer.js';
import { rgba } from './video.js';
import { capture, apply } from './state.js';

const WIN = { x: 112, y: 16, w: 288, h: 224 };
const LINES = 256, VBLANK = 240, REFRESH = 60;
const CPU_CLOCK = 3000000, SOUND_CLOCK = 3579545;
const NMI_DELAY = Math.round(SOUND_CLOCK * 25e-6);
const STATE = ['ram', 'palRam', 'spriteList', 'extraRam', 'soundRam', 'bank', 'soundBank', 'videoBank', 'firqEnabled', 'objcha',
  'firqAt', 'nmiAt', 'initReads', 'in', 'slot', 'joinTimer', 'cycleCarry', 'soundCarry', 'sampleCarry', 'cpu', 'snd', 'tiles', 'sprites', 'mixer',
  'ym', 'k053260', 'eeprom'];

export class Simpsons {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 2048; i++) this.setColor(i); }

  // roms: { main (0x88000 region: fixed 8000-FFFF, banks from 10000), sound (0x28000 region), tiles, sprites, samples }
  constructor(roms) {
    this.width = WIN.w;
    this.height = WIN.h;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 2;
    this.button2 = 'Jump';
    this.startLabels = ['Marge', 'Homer', 'Bart', 'Lisa'];
    this.startsCoin = true;
    this.roms = roms;
    this.ram = new Uint8Array(0x2000);         // 4000-5FFF
    this.palRam = new Uint8Array(0x1000);
    this.spriteList = new Uint16Array(0x800);   // 2000-2FFF when banked in
    this.extraRam = new Uint8Array(0x1000);     // 3000-3FFF when banked in
    this.soundRam = new Uint8Array(0x800);
    this.palette = new Uint32Array(2048).fill(0xFF000000);
    this.eeprom = new SerialEEPROM({ addressBits: 7, dataBits: 8, read: '011000', write: '011100', lock: '0100000000000', unlock: '0100110000000' });
    this.nvram = this.eeprom.data;
    this.tiles = new K052109(deinterleave2(roms.tiles), (l, b, c, col) => this.tileCallback(l, b, c, col));
    this.sprites = new K053247(deinterleave2(deinterleave2(roms.sprites)), (c, col) => this.spriteCallback(c, col), 53, 23);
    this.mixer = new K053251();
    this.cpu = new KonamiCPU({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.cpu.onTaken = (kind) => { if (kind === 'irq') this.cpu.irq = false; else this.cpu.firq = false; };
    this.cpu.onSetLines = (v) => { this.bank = 0x10000 + (v & 0x3F) * 0x2000; };
    this.snd = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onIrqAck = () => { this.snd.irq = false; };
    this.ym = new YM2151(SOUND_CLOCK, 0.6);
    this.k053260 = new K053260(SOUND_CLOCK, roms.samples, 0.75);
    this.sound = new SoundMix([this.ym, this.k053260], 1);
    this.frame = new Uint32Array(WIN.w * WIN.h);
    this.pri = new Uint8Array(WIN.w * WIN.h);
    this.in = new Uint8Array(5).fill(0xFF);
    this.slot = 0;
    this.layerPri = [0, 0, 0];
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.palRam, this.spriteList, this.extraRam, this.soundRam]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.bank = 0x10000; this.soundBank = 0; this.videoBank = 0; this.firqEnabled = 0; this.objcha = 0;
    this.firqAt = -1; this.nmiAt = -1; this.joinTimer = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
    this.tiles.reset(); this.sprites.reset(); this.mixer.reset();
    this.cpu.reset(); this.snd.reset(); this.ym.reset(); this.k053260.reset();
    this.eeprom.reset();
    // With a blank EEPROM the game needs its test switch held at power-on to set itself up.
    this.initReads = this.nvram.every((b) => b === 0xFF) ? 10 : 0;
  }

  setColor(i) {
    const c = (this.palRam[i * 2] << 8) | this.palRam[i * 2 + 1], l = (v) => (v << 3) | (v >> 2);
    this.palette[i] = rgba(l(c & 31), l((c >> 5) & 31), l((c >> 10) & 31));
  }

  read(a) {
    if (a < 0x1000 && (this.videoBank & 1)) return this.palRam[a];
    if (a >= 0x2000 && a < 0x4000 && (this.videoBank & 2)) {
      if (a < 0x3000) { const w = this.spriteList[(a - 0x2000) >> 1]; return a & 1 ? w & 0xFF : w >> 8; }
      return this.extraRam[a - 0x3000];
    }
    if (a >= 0x1F80 && a < 0x2000) {
      switch (a) {
        case 0x1F80: return this.in[4];
        case 0x1F81: {
          let v = (this.eeprom.readBit() << 4) | 0x20 | 1;     // test switch off (1)
          if (this.initReads) { this.initReads--; v &= 0xFE; }
          return v;
        }
        case 0x1F90: case 0x1F91: case 0x1F92: case 0x1F93: return this.in[a - 0x1F90];
        case 0x1FC4: this.snd.irqVector = 0xFF; this.snd.irq = true; return 0;
        case 0x1FC6: case 0x1FC7: return this.k053260.read(2 + (a & 1));
        case 0x1FC8: case 0x1FC9: return this.objcha ? this.sprites.readRom(a & 1) : 0;
        case 0x1FCA: return 0;                                   // watchdog
      }
      return this.tiles.read(a);
    }
    if (a < 0x4000) return this.tiles.read(a);
    if (a < 0x6000) return this.ram[a - 0x4000];
    if (a < 0x8000) return this.roms.main[this.bank + a - 0x6000] ?? 0xFF;
    return this.roms.main[a];
  }
  write(a, v) {
    if (a < 0x1000 && (this.videoBank & 1)) { this.palRam[a] = v; this.setColor(a >> 1); return; }
    if (a >= 0x2000 && a < 0x4000 && (this.videoBank & 2)) {
      if (a < 0x3000) {
        const i = (a - 0x2000) >> 1, w = this.spriteList[i];
        this.spriteList[i] = a & 1 ? (w & 0xFF00) | v : (w & 0xFF) | (v << 8);
      } else this.extraRam[a - 0x3000] = v;
      return;
    }
    if (a >= 0x1F80 && a < 0x2000) {
      if (a >= 0x1FA0 && a < 0x1FA8) { this.sprites.writeReg(a - 0x1FA0, v); return; }
      if (a >= 0x1FB0 && a < 0x1FC0) { this.mixer.write(a - 0x1FB0, v); return; }
      switch (a) {
        case 0x1FC0: this.tiles.rmrd = v & 0x08; this.objcha = !(v & 0x20); return;   // coin counters, ROM reading
        case 0x1FC2:                                             // EEPROM lines, video banks, FIRQ enable
          if (v === 0xFF) return;
          this.eeprom.writeBit(v & 0x80);
          this.eeprom.setReset(!(v & 0x08));
          this.eeprom.setClock(v & 0x10);
          this.videoBank = v & 3;
          this.firqEnabled = v & 0x04;
          return;
        case 0x1FC6: case 0x1FC7: this.k053260.write(a & 1, v); return;
      }
      this.tiles.write(a, v);
      return;
    }
    if (a < 0x4000) { this.tiles.write(a, v); return; }
    if (a < 0x6000) this.ram[a - 0x4000] = v;
  }

  soundRead(a) {
    if (a < 0x8000) return this.roms.sound[a];
    if (a < 0xC000) return this.roms.sound[(this.soundBank < 2 ? 0x10000 : 0x10000 + (this.soundBank - 2) * 0x4000) + a - 0x8000] ?? 0xFF;
    if (a >= 0xF000 && a < 0xF800) return this.soundRam[a - 0xF000];
    if (a === 0xF801) return this.ym.read();
    if (a >= 0xFC00 && a < 0xFC30) return this.k053260.read(a - 0xFC00);
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a >= 0xF000 && a < 0xF800) this.soundRam[a - 0xF000] = v;
    else if (a === 0xF800) this.ym.select(v);
    else if (a === 0xF801) this.ym.write(v);
    else if (a === 0xFA00) this.nmiAt = this.snd.cycles + NMI_DELAY;   // an NMI follows 25 us later (after the HALT that waits for it)
    else if (a >= 0xFC00 && a < 0xFC30) this.k053260.write(a - 0xFC00, v);
    else if (a === 0xFE00) this.soundBank = v & 7;
  }

  tileCallback(layer, bank, code, color) {
    const base = this.mixer.paletteIndex(2 + layer);
    return { code: code | ((color & 0x3F) << 8) | (bank << 14), color: base + ((color & 0xC0) >> 6) };
  }
  spriteCallback(code, color) {
    const p = (color & 0x0F80) >> 6, [l0, l1, l2] = this.layerPri;
    const mask = p <= l2 ? 0 : p <= l1 ? 0xF0 : p <= l0 ? 0xFC : 0xFE;
    return { code, color: this.mixer.paletteIndex(1) + (color & 0x1F), priority: mask };
  }

  // The sprite DMA: active entries (with a nonzero z code) are packed into the chip's RAM.
  objDma() {
    const src = this.spriteList, dst = this.sprites.ram;
    let d = 0;
    for (let s = 0; s < 0x800; s += 8) {
      if ((src[s] & 0x8000) && (src[s] & 0xFF)) { dst.set(src.subarray(s, s + 8), d); d += 8; }
    }
    for (; d < 0x800; d += 8) dst[d] = 0;
  }

  render() {
    const p = this.palette, m = this.mixer;
    const layers = [[0, m.priority(2)], [1, m.priority(3)], [2, m.priority(4)]].sort((a, b) => b[1] - a[1]);
    this.layerPri = layers.map((l) => l[1]);
    this.frame.fill(p[16 * m.paletteIndex(0)]); this.pri.fill(0);
    this.tiles.draw(layers[0][0], this.frame, this.pri, p, WIN, { priority: 1 });
    this.tiles.draw(layers[1][0], this.frame, this.pri, p, WIN, { priority: 2 });
    this.tiles.draw(layers[2][0], this.frame, this.pri, p, WIN, { priority: 4 });
    this.sprites.draw(this.frame, this.pri, p, WIN);
  }

  runFrame() {
    const mainLine = CPU_CLOCK / REFRESH / LINES, soundLine = SOUND_CLOCK / REFRESH / LINES;
    const samples = RATE / REFRESH / LINES, dt = 1 / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === VBLANK) {
        this.render();
        if (this.sprites.dmaEnabled) { this.objDma(); this.firqAt = line + 1; }   // done about 30 us later
        if (this.tiles.irqEnabled) this.cpu.irq = true;
      }
      if (line === this.firqAt) { this.firqAt = -1; if (this.firqEnabled) this.cpu.firq = true; }
      this.cycleCarry += mainLine;
      this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
      this.ym.timers(dt);
      this.soundCarry += soundLine;
      // Run the sound CPU in pieces so an armed NMI lands on its cycle.
      const budget = Math.floor(this.soundCarry);
      let done = 0;
      while (done < budget) {
        const step = this.nmiAt >= 0 ? Math.min(budget - done, Math.max(1, this.nmiAt - this.snd.cycles)) : budget - done;
        done += this.snd.run(step);
        if (this.nmiAt >= 0 && this.snd.cycles >= this.nmiAt) { this.nmiAt = -1; this.snd.nmi(); }
      }
      this.soundCarry -= done;
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // Each player's stick, attack, jump and start (active low); coins 1-4 in IN4.
  // Pressing a character's button runs a little sequence for that slot: its
  // coin for 4 frames, then its start for 6 frames about 1.2 seconds later
  // (the game ignores start until the "press start" panel has slid in); the
  // controls go to that slot.
  setInputs(s) {
    const picked = [s.start1, s.start2, s.start3, s.start4].findIndex(Boolean);
    if (picked >= 0 && !this.wasPicked) { this.slot = picked; this.joinTimer = 1; }
    this.wasPicked = picked >= 0;
    const t = this.joinTimer || 0;
    if (t) this.joinTimer = t < 76 ? t + 1 : 0;
    const coin = t >= 1 && t <= 4, start = t >= 70 && t <= 75;
    const p = (s.left ? 1 : 0) | (s.right ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0) | (s.fire ? 0x10 : 0) | (s.fire2 ? 0x20 : 0)
      | (start ? 0x80 : 0);
    for (let i = 0; i < 4; i++) this.in[i] = i === this.slot ? 0xFF & ~p : 0xFF;
    this.in[4] = 0xFF & ~(s.coin || coin ? 1 << this.slot : 0);
  }
  applySwitches() {}
}
Simpsons.id = 'simpsons';
Simpsons.title = 'The Simpsons';
Simpsons.switches = [];
