// Namco 3-voice waveform sound generator (Pac-Man, Galaga), plus a noise
// source standing in for Galaga's 54xx explosions.
//
// Registers (4 bits each, at 0x00-0x1F):
//   voice 0: 05 waveform, 10-14 frequency (20 bits, 10 is the lowest nibble), 15 volume
//   voice 1: 0A waveform, 16-19 frequency (bits 4-19),                         1A volume
//   voice 2: 0F waveform, 1B-1E frequency (bits 4-19),                         1F volume
// Each voice adds its frequency to a 20-bit counter at 96 kHz; the top 5 bits
// pick one of 32 4-bit samples of the selected waveform from the sound PROM.
//
// Output goes into a ring buffer at RATE, read by the browser audio output.

export const RATE = 48000;
const CLOCK = 96000;                       // 18.432 MHz / 6 / 32
const LINE_RATE = 264 * 60.606;            // scanlines per second
const SAMPLES_PER_LINE = RATE / LINE_RATE; // about 3

export class WSG {
  constructor(wavePROM) {
    this.wave = Uint8Array.from(wavePROM, (v) => v & 0x0F);
    this.buffer = new Float32Array(1 << 15);
    this.rate = RATE;
    this.reset();
  }

  reset() {
    this.regs = new Uint8Array(32);
    this.enabled = true;          // Pac-Man can switch the whole chip off
    this.counter = new Uint32Array(3);
    this.writePos = this.readPos = 0;
    this.carry = 0;
    this.noise = 1;
    this.noiseLevel = 0;
    this.dc = 0;
  }

  write(reg, v) { this.regs[reg] = v & 0x0F; }

  voice(n) {
    const r = this.regs, base = 0x11 + n * 5;
    const freq = (n === 0 ? r[0x10] : 0) | (r[base] << 4) | (r[base + 1] << 8) | (r[base + 2] << 12) | (r[base + 3] << 16);
    return { wave: r[0x05 + n * 5] & 7, freq, vol: r[0x15 + n * 5] };
  }

  // Produce this scanline's share of samples. `boom` adds explosion noise.
  line(boom) {
    this.carry += SAMPLES_PER_LINE;
    let n = this.carry | 0;
    this.carry -= n;
    if (boom) this.noiseLevel = 1;
    const voices = [this.voice(0), this.voice(1), this.voice(2)];
    const buf = this.buffer, mask = buf.length - 1;
    while (n-- > 0) {
      let s = 0;
      // Two 96 kHz steps per 48 kHz output sample, averaged.
      for (let sub = 0; sub < 2; sub++) {
        for (let v = 0; v < 3; v++) {
          const { wave, freq, vol } = voices[v];
          this.counter[v] = (this.counter[v] + freq) & 0xFFFFF;
          if (vol && this.enabled) s += (this.wave[wave * 32 + (this.counter[v] >>> 15)] - 8) * vol;
        }
      }
      let out = s / (2 * 3 * 8 * 15);
      if (this.noiseLevel > 0.001) {
        // 17-bit LFSR noise, decaying: a rough stand-in for the 54xx.
        const bit = (this.noise ^ (this.noise >> 3)) & 1;
        this.noise = (this.noise >> 1) | (bit << 16);
        out += ((this.noise & 1) ? 0.35 : -0.35) * this.noiseLevel;
        this.noiseLevel *= 0.99985;
      }
      buf[this.writePos] = out * 0.8;
      this.writePos = (this.writePos + 1) & mask;
      if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & mask;
    }
  }

  available() { return (this.writePos - this.readPos) & (this.buffer.length - 1); }

  // Fallback path (ScriptProcessor): resample into `out` at `outRate`.
  pull(out, outRate) {
    const buf = this.buffer, mask = buf.length - 1, step = RATE / outRate;
    if (this.available() > RATE * 0.075) this.readPos = (this.writePos - Math.floor(RATE * 0.035)) & mask;
    let pos = this.frac || 0, last = this.last || 0;
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) { out[i] = last *= 0.995; continue; }
      const s0 = buf[this.readPos], s1 = buf[(this.readPos + 1) & mask];
      last = out[i] = s0 + (s1 - s0) * pos;
      pos += step;
      while (pos >= 1 && this.available() > 1) { pos -= 1; this.readPos = (this.readPos + 1) & mask; }
    }
    this.frac = pos; this.last = last;
  }
}
