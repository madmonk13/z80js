// Technos Double Dragon (1987): an HD6309 at 3.58 MHz runs the game (in 6809
// mode, so a 6809 core serves), with 16K banks of program at 4000. An HD63701
// microcontroller builds the sprite list: the main CPU wakes it with an NMI
// through the bank register and it answers with an IRQ when done. A second
// 6809 plays music on a YM2151 and voices and hits on two MSM5205 ADPCM
// decoders, which stream 4-bit samples from their own ROMs.
//
// Video: a 32x32 map of 16x16 background tiles (512x512) that scrolls, 8x8
// text tiles above it, and 64 sprites of 16x16 up to 32x32. 444 colors of
// 4 bits per gun in RAM. 240x224 visible of 256x272 lines at 57.44 Hz; FIRQ
// every 16 lines, NMI at vertical blank.

import { M6809 } from './m6809.js';
import { M6803 } from './m6803.js';
import { YM2151 } from './ym2151.js';
import { MSM5205 } from './msm5205.js';
import { SoundMix, RATE } from './mixer.js';
import { decodeTiles, rgba, run } from './video.js';
import { defaultSwitches } from './pacman.js';
import { capture, apply } from './state.js';

const W = 240, H = 224, LEFT = 8, TOP = 16, LINES = 272;
const REFRESH = 12000000 / 256 / 3 / LINES;
const CPU_CLOCK = 3579545, SUB_CLOCK = 3579545 / 3, ADPCM_RATE = 384000 / 48;
const STATE = ['ram', 'palRam', 'fgRam', 'spriteRam', 'bgRam', 'subRam', 'soundRam', 'bank', 'scrollX', 'scrollY', 'busy', 'vblank',
  'latch', 'adpcmPos', 'adpcmEnd', 'adpcmIdle', 'adpcmNibble', 'in0', 'in1', 'in2',
  'cycleCarry', 'subCarry', 'soundCarry', 'adpcmCarry', 'sampleCarry', 'cpu', 'sub', 'snd', 'ym', 'msm'];

export class DoubleDragon {
  saveState() { return capture(this, STATE); }
  loadState(s) { apply(this, STATE, s); for (let i = 0; i < 384; i++) this.setColor(i); }

  // roms: { main (0x28000: 8000-FFFF at 8000, banks from 10000), sub 16K (C000), sound 32K (8000),
  //         chars 32K, sprites 512K, tiles 256K, adpcm 128K (64K a chip) }
  constructor(roms) {
    this.width = W;
    this.height = H;
    this.refresh = REFRESH;
    this.controls = 'eight-way';
    this.buttons = 3;
    this.button2 = 'Kick'; this.button3 = 'Jump';
    this.roms = roms;
    this.ram = new Uint8Array(0x1000);               // 0000-0FFF
    this.palRam = new Uint8Array(0x400);             // 1000-13FF: low bytes (green, red) then high (blue)
    this.fgRam = new Uint8Array(0xC00);              // 1400-1FFF (the text layer from 1800)
    this.spriteRam = new Uint8Array(0x1000);         // 2000-2FFF, shared with the MCU (the list at 800)
    this.bgRam = new Uint8Array(0x800);              // 3000-37FF
    this.subRam = new Uint8Array(0x1000);
    this.soundRam = new Uint8Array(0x1000);
    this.palette = new Uint32Array(384).fill(0xFF000000);

    this.cpu = new M6809({ read: (a) => this.read(a), write: (a, v) => this.write(a, v) });
    this.sub = new M6803({ read: (a) => this.subRead(a), write: (a, v) => this.subWrite(a, v), internal: false, hd63701: true });
    this.snd = new M6809({ read: (a) => this.soundRead(a), write: (a, v) => this.soundWrite(a, v) });
    this.snd.onTaken = (line) => { if (line === 'irq') this.snd.irq = false; };   // the sound command is a held IRQ
    this.ym = new YM2151(3579545, 1);
    this.msm = [new MSM5205(0.6), new MSM5205(0.6)];
    this.sound = new SoundMix([this.ym, ...this.msm], 1.8);
    this.frame = new Uint32Array(W * H);

    this.charPix = decodeTiles(roms.chars, {
      count: roms.chars.length / 32, width: 8, height: 8, planes: [0, 2, 4, 6],
      xs: [1, 0, 65, 64, 129, 128, 193, 192], ys: run(0, 8, 8), size: 256,
    });
    const tiles = (rom) => {
      const half = rom.length * 4;
      return decodeTiles(rom, {
        count: rom.length / 128, width: 16, height: 16, planes: [half, half + 4, 0, 4],
        xs: [3, 2, 1, 0, 131, 130, 129, 128, 259, 258, 257, 256, 387, 386, 385, 384], ys: run(0, 16, 8), size: 512,
      });
    };
    this.spritePix = tiles(roms.sprites);
    this.tilePix = tiles(roms.tiles);
    this.spriteCount = roms.sprites.length / 128;
    this.tileCount = roms.tiles.length / 128;
    this.in0 = this.in1 = this.in2 = 0xFF;
    this.applySwitches(defaultSwitches(this.constructor.switches));
    this.reset();
  }

  reset() {
    for (const a of [this.ram, this.palRam, this.fgRam, this.spriteRam, this.bgRam, this.subRam, this.soundRam]) a.fill(0);
    this.palette.fill(0xFF000000);
    this.bank = 0; this.scrollX = 0; this.scrollY = 0; this.busy = 0x10; this.vblank = 0;
    this.latch = 0; this.adpcmPos = [0, 0]; this.adpcmEnd = [0, 0]; this.adpcmIdle = [1, 1]; this.adpcmNibble = [-1, -1];
    this.cycleCarry = this.subCarry = this.soundCarry = this.adpcmCarry = this.sampleCarry = 0;
    this.cpu.reset(); this.sub.reset(); this.snd.reset(); this.sound.reset();
  }

  setColor(i) {
    const lo = this.palRam[i], hi = this.palRam[0x200 + i];
    this.palette[i] = rgba((lo & 15) * 17, (lo >> 4) * 17, (hi & 15) * 17);
  }

  // ---------------------------------------------------------------- main CPU

  read(a) {
    if (a >= 0x8000) return this.roms.main[a];
    if (a >= 0x4000) return this.roms.main[0x10000 + ((this.bank >> 5) * 0x4000) + (a - 0x4000)] ?? 0xFF;
    if (a < 0x1000) return this.ram[a];
    if (a < 0x1400) return this.palRam[a - 0x1000];
    if (a < 0x2000) return this.fgRam[a - 0x1400];
    if (a < 0x3000) return this.spriteRam[a - 0x2000];
    if (a < 0x3800) return this.bgRam[a - 0x3000];
    switch (a) {
      case 0x3800: return this.in0;
      case 0x3801: return this.in1;
      case 0x3802: return (this.in2 & ~0x18) | this.busy | this.vblank;
      case 0x3803: return this.dsw0;
      case 0x3804: return this.dsw1;
    }
    return 0xFF;
  }

  write(a, v) {
    if (a >= 0x4000) return;
    if (a < 0x1000) { this.ram[a] = v; return; }
    if (a < 0x1400) { const i = a - 0x1000; this.palRam[i] = v; if ((i & 0x1FF) < 384) this.setColor(i & 0x1FF); return; }
    if (a < 0x2000) { this.fgRam[a - 0x1400] = v; return; }
    if (a < 0x3000) { this.spriteRam[a - 0x2000] = v; return; }
    if (a < 0x3800) { this.bgRam[a - 0x3000] = v; return; }
    switch (a) {
      case 0x3808:                                   // scroll high bits, flip, MCU handshake, bank
        this.scrollX = (this.scrollX & 0xFF) | ((v & 1) << 8);
        this.scrollY = (this.scrollY & 0xFF) | ((v & 2) << 7);
        if (v & 0x10) this.busy = 0;
        else if (this.busy === 0) this.sub.nmi();
        this.bank = v;
        break;
      case 0x3809: this.scrollX = (this.scrollX & 0x100) | v; break;
      case 0x380A: this.scrollY = (this.scrollY & 0x100) | v; break;
      case 0x380B: break;                            // NMI acknowledge
      case 0x380C: this.cpu.firq = false; break;
      case 0x380D: this.cpu.irq = false; break;
      case 0x380E: this.latch = v; this.snd.irq = true; break;
    }
  }

  // ---------------------------------------------------------------- sprite MCU

  // Its internal registers (0-1F) are left out, as MAME does; writing register 17 signals the main CPU.
  subRead(a) {
    if (a < 0x20) return 0;
    if (a < 0x1000) return this.subRam[a];
    if (a >= 0x8000 && a < 0x9000) return this.spriteRam[a - 0x8000];
    if (a >= 0xC000) return this.roms.sub[a - 0xC000];
    return 0xFF;
  }
  subWrite(a, v) {
    if (a < 0x20) { if (a === 0x17 && (v & 3)) this.cpu.irq = true; return; }
    if (a < 0x1000) this.subRam[a] = v;
    else if (a >= 0x8000 && a < 0x9000) { if (a === 0x8000) this.busy = 0x10; this.spriteRam[a - 0x8000] = v; }
  }

  // ---------------------------------------------------------------- sound CPU

  soundRead(a) {
    if (a < 0x1000) return this.soundRam[a];
    if (a >= 0x8000) return this.roms.sound[a - 0x8000];
    if (a === 0x1000) return this.latch;
    if (a === 0x1800) return this.adpcmIdle[0] | (this.adpcmIdle[1] << 1);
    if (a === 0x2800 || a === 0x2801) return this.ym.read();
    return 0xFF;
  }
  soundWrite(a, v) {
    if (a < 0x1000) { this.soundRam[a] = v; return; }
    if (a === 0x2800) this.ym.select(v);
    else if (a === 0x2801) this.ym.write(v);
    else if (a >= 0x3800 && a < 0x3808) {
      const k = a & 1;
      switch ((a & 7) >> 1) {
        case 0: this.adpcmIdle[k] = 0; this.msm[k].hold(false); break;
        case 1: this.adpcmEnd[k] = (v & 0x7F) * 0x200; break;
        case 2: this.adpcmPos[k] = (v & 0x7F) * 0x200; break;
        case 3: this.adpcmIdle[k] = 1; this.msm[k].hold(true); break;
      }
    }
  }

  // Each decoder at 8 kHz: the next nibble of its sample (high first), until the end address.
  adpcmTick() {
    for (let k = 0; k < 2; k++) {
      const m = this.msm[k];
      if (this.adpcmIdle[k]) { m.clock(); continue; }
      if (this.adpcmPos[k] >= this.adpcmEnd[k] || this.adpcmPos[k] >= 0x10000) { this.adpcmIdle[k] = 1; m.hold(true); }
      else if (this.adpcmNibble[k] >= 0) { m.data(this.adpcmNibble[k] & 15); this.adpcmNibble[k] = -1; }
      else { const b = this.roms.adpcm[k * 0x10000 + this.adpcmPos[k]++]; this.adpcmNibble[k] = b; m.data(b >> 4); }
      m.clock();
    }
  }

  // ---------------------------------------------------------------- inputs

  // Active low. IN0: right, left, up, down, punch, kick, start 1, start 2. IN1: coin on bit 6. IN2: jump on bit 1.
  setInputs(s) {
    this.in0 = 0xFF & ~((s.right ? 1 : 0) | (s.left ? 2 : 0) | (s.up ? 4 : 0) | (s.down ? 8 : 0) | (s.fire ? 0x10 : 0)
      | (s.fire2 ? 0x20 : 0) | (s.start1 ? 0x40 : 0) | (s.start2 ? 0x80 : 0));
    this.in1 = 0xFF & ~(s.coin ? 0x40 : 0);
    this.in2 = 0xFF & ~(s.fire3 ? 0x02 : 0);
  }

  // DSW0: 1 coin 1 credit, upright, no flip. DSW1: difficulty, demo sounds on, bonus, lives.
  applySwitches(v) {
    this.dsw0 = 0xFF;
    this.dsw1 = v.difficulty | 0x04 | 0x08 | v.bonus | v.lives;
  }

  // ---------------------------------------------------------------- frame

  runFrame() {
    const mainLine = CPU_CLOCK / REFRESH / LINES, subLine = SUB_CLOCK / REFRESH / LINES;
    const dt = 1 / REFRESH / LINES, samples = RATE / REFRESH / LINES, ticks = ADPCM_RATE / REFRESH / LINES;
    for (let line = 0; line < LINES; line++) {
      if (line === 0) this.vblank = 0;
      if (line === 240) { this.render(); this.cpu.nmi(); this.vblank = 0x08; }
      if (line % 16 === 7) this.cpu.firq = true;
      // The MCU and the main CPU trade the sprite list, so they run in small steps together.
      for (let s = 0; s < 4; s++) {
        this.cycleCarry += mainLine / 4;
        this.cycleCarry -= this.cpu.run(Math.floor(this.cycleCarry));
        this.subCarry += subLine / 4;
        const c0 = this.sub.cycles;
        this.sub.run(Math.floor(this.subCarry));
        this.subCarry -= this.sub.cycles - c0;
      }
      this.ym.timers(dt);
      this.snd.firq = this.ym.irq;
      this.soundCarry += mainLine;
      this.soundCarry -= this.snd.run(Math.floor(this.soundCarry));
      this.adpcmCarry += ticks;
      while (this.adpcmCarry >= 1) { this.adpcmCarry -= 1; this.adpcmTick(); }
      this.sampleCarry += samples;
      while (this.sampleCarry >= 1) { this.sampleCarry -= 1; this.sound.sample(); }
    }
  }

  // ---------------------------------------------------------------- video

  render() {
    const out = this.frame, pal = this.palette, bg = this.bgRam;
    // Background: 16x16 tiles, 2 bytes each (attributes: flip y, flip x, color, code high; code low),
    // stored as four 16x16-tile quarters.
    for (let y = 0; y < H; y++) {
      const ty = (y + TOP + this.scrollY) & 0x1FF, row = ty >> 4;
      for (let x = 0; x < W; x++) {
        const tx = (x + LEFT + this.scrollX) & 0x1FF, col = tx >> 4;
        const i = ((col & 15) + ((row & 15) << 4) + ((col & 16) << 4) + ((row & 16) << 5)) * 2, attr = bg[i];
        const code = (bg[i + 1] | ((attr & 7) << 8)) % this.tileCount;
        const px = attr & 0x40 ? 15 - (tx & 15) : tx & 15, py = attr & 0x80 ? 15 - (ty & 15) : ty & 15;
        out[y * W + x] = pal[256 + ((attr >> 3) & 7) * 16 + this.tilePix[code * 256 + py * 16 + px]];
      }
    }

    // Sprites: 5 bytes each (y, attributes, color and code high, code low, x); bigger ones use 2 or 4 codes.
    const spr = this.spriteRam;
    for (let i = 0x800; i < 0x800 + 64 * 5; i += 5) {
      const attr = spr[i + 1];
      if (!(attr & 0x80)) continue;
      const sx = 240 - spr[i + 4] + ((attr & 2) << 7) - LEFT, sy = 240 - spr[i] + ((attr & 1) << 8) - TOP;
      const size = (attr >> 4) & 3, fx = attr & 8, fy = attr & 4;
      const color = 128 + ((spr[i + 2] >> 4) & 7) * 16, which = (spr[i + 3] | ((spr[i + 2] & 15) << 8)) & ~size;
      if (size === 0) this.sprite(which, color, fx, fy, sx, sy);
      else if (size === 1) { this.sprite(which, color, fx, fy, sx, sy - 16); this.sprite(which + 1, color, fx, fy, sx, sy); }
      else if (size === 2) { this.sprite(which, color, fx, fy, sx - 16, sy); this.sprite(which + 2, color, fx, fy, sx, sy); }
      else {
        this.sprite(which, color, fx, fy, sx - 16, sy - 16); this.sprite(which + 1, color, fx, fy, sx - 16, sy);
        this.sprite(which + 2, color, fx, fy, sx, sy - 16); this.sprite(which + 3, color, fx, fy, sx, sy);
      }
    }

    // Text: 8x8 tiles over everything, pen 0 see-through.
    const fg = this.fgRam;
    for (let row = 2; row < 30; row++) for (let col = 1; col < 31; col++) {
      const o = 0x400 + (row * 32 + col) * 2, attr = fg[o];
      const code = fg[o + 1] | ((attr & 7) << 8), color = (attr >> 5) * 16;
      for (let y = 0; y < 8; y++) {
        const dst = ((row - 2) * 8 + y) * W + (col - 1) * 8, src = code * 64 + y * 8;
        for (let x = 0; x < 8; x++) { const p = this.charPix[src + x]; if (p) out[dst + x] = pal[color + p]; }
      }
    }
  }

  sprite(code, color, fx, fy, sx, sy) {
    const out = this.frame, pal = this.palette, pix = this.spritePix, base = (code % this.spriteCount) * 256;
    for (let y = 0; y < 16; y++) {
      const py = sy + y;
      if (py < 0 || py >= H) continue;
      const src = base + (fy ? 15 - y : y) * 16;
      for (let x = 0; x < 16; x++) {
        const px = sx + x;
        if (px < 0 || px >= W) continue;
        const p = pix[src + (fx ? 15 - x : x)];
        if (p) out[py * W + px] = pal[color + p];
      }
    }
  }
}

DoubleDragon.id = 'ddragon';
DoubleDragon.title = 'Double Dragon';
DoubleDragon.switches = [
  { id: 'lives', label: 'Lives', options: [['2', 0xC0], ['3', 0x80], ['4', 0x40]], default: 0x80 },
  { id: 'difficulty', label: 'Difficulty', options: [['Easy', 0x01], ['Medium', 0x03], ['Hard', 0x02], ['Hardest', 0x00]], default: 0x03 },
  { id: 'bonus', label: 'Bonus', options: [['20K', 0x10], ['40K', 0x00], ['30K+60K', 0x30], ['40K+80K', 0x20]], default: 0x30 },
];
