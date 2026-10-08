// Bally Midway MCR boards (1981-84): a Z80 whose interrupts come from a Z80
// CTC, a 32x30 background of 16x16 tiles (8x8 graphics shown at double size)
// with a 64-color palette in RAM, 32x32 sprites, and the Super Sound I/O
// board, which carries the game's inputs as well as a second Z80 driving two
// AY-3-8910s.
//
// Two CPU board generations are covered:
//   90010 (Satan's Hollow, Tron): 2.5 MHz, palette in the top of tile RAM,
//          sprites ORed together (the tile underneath picks their palette).
//   91490 (Tapper): 5 MHz, separate palette RAM, sprites drawn front to back
//          with their own palette.
//
// The picture is 512x480, 30 Hz interlaced; the CTC sees vertical blank once
// per field (60 Hz), so a "frame" here is one field.

import { Z80 } from './z80.js';
import { Z80CTC } from './z80ctc.js';
import { AY8910 } from './ay8910.js';
import { SoundMix } from './mixer.js';
import { decodeTiles, rgba, rotate90, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 512, H = 480;
const SLICES = 256;                                  // CPU/CTC slices per field
const SOUND_CLOCK = 2000000;                         // 16 MHz / 8
const SOUND_TICK = 40;                               // sound CPU clocks per 50 kHz interrupt-counter tick
const SAMPLES_PER_SLICE = 48000 / 60 / SLICES;

const STATE = ['ram', 'vram', 'spriteRam', 'paletteRam', 'soundRam', 'latches', 'status', 'irqCount', 'irqTick',
  'duty', 'mute', 'field', 'cycleCarry', 'soundCarry', 'sampleCarry', 'ip', 'dial', 'cpu', 'sndCpu', 'ctc', 'sound'];

const level3 = (v) => ((v & 7) << 5) | ((v & 7) << 2) | ((v & 7) >> 1);

export class MCR {
  saveState() { return capture(this, STATE); }
  loadState(s) {
    apply(this, STATE, s);
    for (let i = 0; i < 64; i++) this.setColor(i, this.paletteRam[i]);
    this.updateVolumes();
  }

  // roms: { main, sound, bg (tiles), fg (sprites), prom (32 bytes: the sound board's duty-cycle timing) }
  constructor(roms) {
    const cfg = this.constructor.config;
    this.cfg = cfg;
    this.rotated = cfg.rotate;
    this.width = cfg.rotate ? H : W;
    this.height = cfg.rotate ? W : H;
    this.refresh = 60;
    this.roms = roms;
    this.ram = new Uint8Array(0x800);
    this.vram = new Uint8Array(0x800);
    this.spriteRam = new Uint8Array(0x200);
    this.paletteRam = new Uint16Array(64);          // 9-bit colors
    this.soundRam = new Uint8Array(0x400);
    this.palette = new Uint32Array(64);

    this.ctc = new Z80CTC((ch) => { if (ch === 0) { this.ctc.trigger(1, 1); this.ctc.trigger(1, 0); } });
    this.cpu = new Z80({
      read: (a) => this.read(a), write: (a, v) => this.write(a, v),
      input: (p) => this.input(p & 0xFF), output: (p, v) => this.output(p & 0xFF, v),
    });
    this.cpu.onIrqAck = () => { this.cpu.irqVector = this.ctc.ack(); this.cpu.irq = this.ctc.irq(); };
    this.cpu.onReti = () => { this.ctc.reti(); this.cpu.irq = this.ctc.irq(); };

    this.sndCpu = new Z80({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.ay = [new AY8910(SOUND_CLOCK, () => 0xFF, 2), new AY8910(SOUND_CLOCK, () => 0xFF, 2)];
    this.ay.forEach((ay, n) => { ay.portOut = (port, v) => this.ayPort(n, port, v); });
    this.sound = new SoundMix(this.ay);
    this.dutyVolume = dutyVolumes(roms.prom);

    this.bgPix = decodeTiles(roms.bg, {
      count: roms.bg.length / 32, width: 8, height: 8,
      planes: [roms.bg.length * 4, roms.bg.length * 4 + 1, 0, 1], xs: run(0, 8, 2), ys: run(0, 8, 16), size: 128,
    });
    const q = roms.fg.length * 2;                    // bits per quarter
    const xs = [];
    for (let byte = 0; byte < 4; byte++) for (let k = 0; k < 4; k++) xs.push(k * q + byte * 8, k * q + byte * 8 + 4);
    this.spriteCount = roms.fg.length / 512;
    this.spritePix = decodeTiles(roms.fg, {
      count: this.spriteCount, width: 32, height: 32, planes: [0, 1, 2, 3], xs, ys: run(0, 32, 32), size: 1024,
    });

    this.native = new Uint32Array(W * H);
    this.pri = new Uint8Array(W * H);
    this.frame = cfg.rotate ? new Uint32Array(W * H) : this.native;
    this.ip = new Uint8Array(5).fill(0xFF);
    this.dial = 0;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    this.ram.fill(0xFF);                            // battery-backed RAM starts out blank
    this.vram.fill(0); this.spriteRam.fill(0); this.paletteRam.fill(0); this.palette.fill(0xFF000000);
    this.soundRam.fill(0);
    this.cpu.reset(); this.sndCpu.reset(); this.ctc.reset(); this.sound.reset();
    this.latches = new Uint8Array(4);
    this.status = 0;
    this.irqCount = 0; this.irqTick = 0;
    this.duty = new Uint8Array(6);
    this.mute = 0;
    this.updateVolumes();
    this.field = 0;
    this.cycleCarry = this.soundCarry = this.sampleCarry = 0;
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a < this.cfg.romEnd) return this.roms.main[a] ?? 0xFF;
    if (this.cfg.board === 90010) {
      if (a < 0xE000) return a >= 0xC000 ? this.ram[a & 0x7FF] : 0xFF;
      return a & 0x800 ? this.vram[a & 0x7FF] : this.spriteRam[a & 0x1FF];
    }
    if (a < 0xE800) return this.ram[a & 0x7FF];
    if (a < 0xF000) return this.spriteRam[a & 0x1FF];
    if (a < 0xF800) return this.vram[a & 0x7FF];
    return 0xFF;
  }

  write(a, v) {
    if (a < this.cfg.romEnd) return;
    if (this.cfg.board === 90010) {
      if (a < 0xE000) { if (a >= 0xC000) this.ram[a & 0x7FF] = v; return; }
      if (!(a & 0x800)) { this.spriteRam[a & 0x1FF] = v; return; }
      const o = a & 0x7FF;
      this.vram[o] = v;
      if ((o & 0x780) === 0x780) this.setColor((o >> 1) & 0x3F, v | ((o & 1) << 8));   // palette in the top of tile RAM
      return;
    }
    if (a < 0xE800) this.ram[a & 0x7FF] = v;
    else if (a < 0xF000) this.spriteRam[a & 0x1FF] = v;
    else if (a < 0xF800) this.vram[a & 0x7FF] = v;
    else this.setColor((a >> 1) & 0x3F, v | ((a & 1) << 8));
  }

  // 9-bit color: red in bits 6-8, blue 3-5, green 0-2.
  setColor(i, v) {
    this.paletteRam[i] = v;
    this.palette[i] = rgba(level3(v >> 6), level3(v), level3(v >> 3));
  }

  // I/O: the sound board's input ports (00-04, status at 07, mirrored at 08-1F),
  // its four command latches (1C-1F), the watchdog (E0) and the CTC (F0-F3).
  input(p) {
    if (p >= 0xF0 && p <= 0xF3) return this.ctc.read(p & 3);
    if (p < 0x20) {
      const n = p & 7;
      if (n <= 4) return this.inputPort(n);
      if (n === 7) return this.status;
    }
    return 0xFF;
  }

  inputPort(n) { return this.ip[n]; }

  output(p, v) {
    if (p >= 0x1C && p <= 0x1F) this.latches[p & 3] = v;
    else if (p >= 0xF0 && p <= 0xF3) { this.ctc.write(p & 3, v); this.cpu.irq = this.ctc.irq(); }
    // 00-07 lamps, coin meters and cocktail flip; E0 watchdog; E8 unknown.
  }

  // ---------------------------------------------------------------- sound board

  soundRead(a) {
    if (a < 0x4000) return this.roms.sound[a] ?? 0xFF;
    switch (a & 0xF000) {
      case 0x8000: return this.soundRam[a & 0x3FF];
      case 0x9000: return this.latches[a & 3];
      case 0xA000: return (a & 3) === 1 ? this.ay[0].read() : 0xFF;
      case 0xB000: return (a & 3) === 1 ? this.ay[1].read() : 0xFF;
      case 0xE000: this.irqCount = 0; this.sndCpu.irq = false; return 0xFF;   // clears the interrupt
      case 0xF000: return 0xFF;                       // the board's own switches
    }
    return 0xFF;
  }

  soundWrite(a, v) {
    switch (a & 0xF000) {
      case 0x8000: this.soundRam[a & 0x3FF] = v; return;
      case 0xA000: if ((a & 3) === 0) this.ay[0].select(v); else if ((a & 3) === 2) this.ay[0].write(v); return;
      case 0xB000: if ((a & 3) === 0) this.ay[1].select(v); else if ((a & 3) === 2) this.ay[1].write(v); return;
      case 0xC000: this.status = v; return;
    }
  }

  // Each AY channel is gated by a down counter loaded from the AYs' own I/O
  // ports, which works out as a volume per channel; the second AY's port B
  // top bit mutes the board.
  ayPort(n, port, v) {
    if (port === 0) { this.duty[n * 3] = v & 15; this.duty[n * 3 + 1] = v >> 4; }
    else {
      this.duty[n * 3 + 2] = v & 15;
      if (n === 1) this.mute = v & 0x80;
    }
    this.updateVolumes();
  }

  updateVolumes() {
    for (let k = 0; k < 6; k++) this.ay[k / 3 | 0].volume[k % 3] = this.mute ? 0 : this.dutyVolume[this.duty[k]];
  }

  // The sound CPU's interrupt: a 7-bit counter clocked at 50 kHz; its bit 6
  // drives the line, and reading E000 resets it.
  soundTicks(cycles) {
    this.irqTick += cycles;
    while (this.irqTick >= SOUND_TICK) {
      this.irqTick -= SOUND_TICK;
      this.irqCount = (this.irqCount + 1) & 0x7F;
      if ((this.irqCount & 0x3F) === 0) this.sndCpu.irq = !!(this.irqCount & 0x40);
    }
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    // Vertical blank: CTC trigger 2 every field, trigger 3 every frame.
    this.ctc.trigger(2, 1); this.ctc.trigger(2, 0);
    if (!this.field) { this.ctc.trigger(3, 1); this.ctc.trigger(3, 0); }
    this.field ^= 1;
    this.cpu.irq = this.ctc.irq();

    const perSlice = this.cfg.clock / 60 / SLICES, soundPerSlice = SOUND_CLOCK / 60 / SLICES;
    for (let s = 0; s < SLICES; s++) {
      this.cycleCarry += perSlice;
      const n = Math.floor(this.cycleCarry);
      const ran = this.cpu.run(n);
      this.cycleCarry -= ran;
      this.ctc.clock(ran);
      this.cpu.irq = this.ctc.irq();

      this.soundCarry += soundPerSlice;
      const m = Math.floor(this.soundCarry);
      const sran = this.sndCpu.run(m);
      this.soundCarry -= sran;
      this.soundTicks(sran);
      this.sampleCarry += SAMPLES_PER_SLICE;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
    this.render();
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.native, pri = this.pri, vram = this.vram, pal = this.palette, bg = this.bgPix;
    const tapper = this.cfg.board !== 90010;
    for (let row = 0; row < 30; row++) {
      for (let col = 0; col < 32; col++) {
        const i = row * 32 + col, data = vram[i * 2] | (vram[i * 2 + 1] << 8);
        let code, color, flip;
        if (tapper) { code = data & 0x3FF; color = (data >> 12) & 3; flip = (data >> 10) & 3; }
        else { code = data & 0x1FF; color = (data >> 11) & 3; flip = (data >> 9) & 3; }
        const bank = ((data >> 14) & 3) << 4, base = color * 16;
        for (let y = 0; y < 16; y++) {
          const src = code * 64 + ((flip & 2 ? 15 - y : y) >> 1) * 8;
          let o = (row * 16 + y) * W + col * 16;
          for (let x = 0; x < 16; x++, o++) {
            out[o] = pal[base + bg[src + ((flip & 1 ? 15 - x : x) >> 1)]];
            pri[o] = bank;
          }
        }
      }
    }
    if (tapper) this.spritesFrontToBack(); else this.spritesOred();
    if (this.cfg.rotate) rotate90(out, W, H, this.frame);
  }

  // 90010: sprites ORed into a line buffer that starts out holding each
  // tile's sprite palette bank; drawn where the low 3 bits are set.
  spritesOred() {
    const out = this.native, pri = this.pri, spr = this.spriteRam, pal = this.palette, pix = this.spritePix;
    for (let offs = 0; offs < 0x200; offs += 4) {
      const code = spr[offs + 1] & 0x3F, hflip = spr[offs + 1] & 0x40 ? 31 : 0, vflip = spr[offs + 1] & 0x80 ? 31 : 0;
      const sx = ((spr[offs + 2] - 4) * 2) & 0x1FF;
      let sy = ((240 - spr[offs]) * 2) & 0x1FF;
      for (let y = 0; y < 32; y++, sy = (sy + 1) & 0x1FF) {
        if (sy >= H) continue;
        const src = code * 1024 + (y ^ vflip) * 32, row = sy * W;
        for (let x = 0; x < 32; x++) {
          const tx = (sx + x) & 0x1FF;
          if (tx >= W) continue;
          const v = pri[row + tx] | pix[src + (x ^ hflip)];
          pri[row + tx] = v;
          if (v & 7) out[row + tx] = pal[v & 0x3F];
        }
      }
    }
  }

  // 91490: sprites carry their own palette bank and are drawn front (last)
  // to back; the first one to cover a pixel claims it.
  spritesFrontToBack() {
    const out = this.native, pri = this.pri, spr = this.spriteRam, pal = this.palette, pix = this.spritePix;
    pri.fill(0);
    for (let offs = 0x1FC; offs >= 0; offs -= 4) {
      const code = (spr[offs + 2] + 256 * ((spr[offs + 1] >> 3) & 1)) % this.spriteCount;
      const color = (~spr[offs + 1] & 3) << 4;
      const hflip = spr[offs + 1] & 0x10 ? 31 : 0, vflip = spr[offs + 1] & 0x20 ? 31 : 0;
      const sx = ((spr[offs + 3] - 3) * 2) & 0x1FF;
      let sy = ((241 - spr[offs]) * 2) & 0x1FF;
      for (let y = 0; y < 32; y++, sy = (sy + 1) & 0x1FF) {
        if (sy < 2 || sy >= H) continue;
        const src = code * 1024 + (y ^ vflip) * 32, row = sy * W;
        for (let x = 0; x < 32; x++) {
          const tx = (sx + x) & 0x1FF;
          if (tx >= W || pri[row + tx]) continue;
          const v = color | pix[src + (x ^ hflip)];
          if (v & 0x0F) {
            pri[row + tx] = 1;
            if (v & 7) out[row + tx] = pal[v];
          }
        }
      }
    }
  }
}

// The duty-cycle counters count high-to-low transitions in a 160-step timing
// PROM pattern; the fraction of the 160 steps a channel is let through is its
// volume.
function dutyVolumes(prom) {
  const vol = new Float32Array(16);
  for (let n = 0; n < 16; n++) {
    let left = n, clock = 0, prev = 1;
    for (; clock < 160 && left; clock++) {
      const cur = prom[clock >> 3] & (0x80 >> (clock & 7));
      if (!cur && prev) left--;
      prev = cur;
    }
    vol[15 - n] = clock / 160;
  }
  return vol;
}

// ---------------------------------------------------------------- games

export class SatansHollow extends MCR {
  constructor(roms) {
    super(roms);
    this.controls = 'two-way';
    this.buttons = 2;
    this.button2 = 'Shield';
  }
  // IP0: coin, starts. IP1: left, right, shield (button 2), fire.
  setInputs(s) {
    this.ip[0] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0));
    this.ip[1] = 0xFF & ~((s.left ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.fire2 ? 0x04 : 0) | (s.fire ? 0x08 : 0));
  }
  applySwitches() { this.ip[3] = 0xFD; }            // one coin meter, upright
}
SatansHollow.config = { board: 90010, clock: 19968000 / 8, romEnd: 0xC000, rotate: true };
SatansHollow.id = 'shollow';
SatansHollow.title = "Satan's Hollow";
SatansHollow.switches = [];

export class Tron extends MCR {
  constructor(roms) {
    super(roms);
    this.controls = 'eight-way';
    this.buttons = 1;
    this.dialControl = true;
  }
  // IP0: coin, starts, trigger. IP1: the aiming dial's position. IP2: stick.
  setInputs(s) {
    this.ip[0] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0) | (s.fire ? 0x10 : 0));
    if (s.spin) this.dial = (this.dial - Math.round(s.spin)) & 0xFF;
    this.ip[1] = this.dial;
    this.ip[2] = 0xFF & ~((s.left ? 0x01 : 0) | (s.right ? 0x02 : 0) | (s.up ? 0x04 : 0) | (s.down ? 0x08 : 0));
  }
  applySwitches(v) { this.ip[3] = v.continues; this.ip[4] = 0; }
}
Tron.config = { board: 90010, clock: 19968000 / 8, romEnd: 0xC000, rotate: true };
Tron.id = 'tron';
Tron.title = 'Tron';
Tron.switches = [
  { id: 'continues', label: 'Continue', options: [['Yes', 0x00], ['No', 0x04]], default: 0x00 },
];

export class Tapper extends MCR {
  constructor(roms) {
    super(roms);
    this.controls = 'four-way';
    this.buttons = 1;
  }
  // IP0: coin, starts. IP1: right, left, down, up, pour.
  setInputs(s) {
    this.ip[0] = 0xFF & ~((s.coin ? 0x01 : 0) | (s.start1 ? 0x04 : 0) | (s.start2 ? 0x08 : 0));
    this.ip[1] = 0xFF & ~((s.right ? 0x01 : 0) | (s.left ? 0x02 : 0) | (s.down ? 0x04 : 0) | (s.up ? 0x08 : 0) | (s.fire ? 0x10 : 0));
  }
  applySwitches(v) { this.ip[3] = 0xC3 | 0x38 | v.demoSounds; }   // upright, one coin meter
}
Tapper.config = { board: 91490, clock: 5000000, romEnd: 0xE000, rotate: false };
Tapper.id = 'tapper';
Tapper.title = 'Tapper';
Tapper.switches = [
  { id: 'demoSounds', label: 'Demo sounds', options: [['On', 0x00], ['Off', 0x04]], default: 0x00 },
];
