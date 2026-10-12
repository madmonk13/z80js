#!/usr/bin/env node
// Sound level check: run a set (dropping a coin and starting a game) and
// print the peak and RMS of the last 800 samples every 100 frames.
//
//   node tools/sound-check.mjs path/to/set.zip [frames=1500]
//   Optional env: COIN=frame, START=frame (default 700 / 800).

import fs from 'node:fs';
import { extractAll } from '../src/unzip.js';
import { identify } from '../src/emu/boards.js';

const [zip, framesArg = '1500'] = process.argv.slice(2);
const { Board, roms } = identify(await extractAll(new Uint8Array(fs.readFileSync(zip))));
const b = new Board(roms), C = +(process.env.COIN || 700), S = +(process.env.START || 800);
let peak = 0;
for (let f = 0; f < +framesArg; f++) {
  b.setInputs({ coin: f >= C && f < C + 6, start1: f >= S && f < S + 6, left: f > S + 200 && !!((f >> 6) & 1), right: f > S + 200 && !((f >> 6) & 1), fire: f > S + 200 && f % 20 < 3 });
  b.runFrame();
  if (f % 100 === 0) {
    let m = 0, r = 0; const s = b.sound, buf = s.buffer;
    for (let i = 0; i < 800; i++) { const v = buf[(s.writePos - 1 - i) & (buf.length - 1)]; m = Math.max(m, Math.abs(v)); r += v * v; }
    peak = Math.max(peak, m);
    console.log(f, m.toFixed(3), Math.sqrt(r / 800).toFixed(3));
  }
}
console.log(`${Board.title}: peak ${peak.toFixed(3)}`);
