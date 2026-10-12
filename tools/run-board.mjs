#!/usr/bin/env node
// Headless check: boot a ROM set for N frames and save the screen as a PNG.
//
//   node tools/run-board.mjs <set.zip> [frames=600] [out.png]
//   Optional env: COIN=frame, START=frame to drop a coin / press start;
//   HOLD=left|right|up|down|fire to hold a control from START+300 on.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { extractAll } from '../src/unzip.js';
import { identify } from '../src/emu/boards.js';

const [zipPath, framesArg = '600', outPath = 'out/frame.png'] = process.argv.slice(2);
if (!zipPath) { console.error('usage: run-board.mjs <set.zip> [frames] [out.png]'); process.exit(1); }

const { Board, roms } = identify(await extractAll(new Uint8Array(fs.readFileSync(zipPath))));
const board = new Board(roms);
const frames = parseInt(framesArg, 10);
const coinAt = +(process.env.COIN ?? -100), startAt = +(process.env.START ?? -100);
const hold = process.env.HOLD || '';

const t0 = performance.now();
for (let i = 0; i < frames; i++) {
  const s = { coin: i >= coinAt && i < coinAt + 6, start1: i >= startAt && i < startAt + 6 };
  if (hold && startAt >= 0 && i >= startAt + 300) for (const h of hold.split(',')) s[h] = true;
  board.setInputs(s);
  board.runFrame();
}
const ms = performance.now() - t0;
console.log(`${Board.title}: ${frames} frames, ${(ms / frames).toFixed(2)} ms/frame, sound buffered ${board.sound.available()} samples`);

// Vector boards: rasterize the display list into a frame buffer.
if (board.vector) {
  board.frame = new Uint32Array(board.width * board.height);
  const d = board.vectors.data;
  for (let i = 0; i < board.vectors.count; i++) {
    const o = i * 7, [x0, y0, x1, y1] = [d[o], d[o + 1], d[o + 2], d[o + 3]];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    const c = 0xFF000000 | (Math.round(d[o + 6] * 255) << 16) | (Math.round(d[o + 5] * 255) << 8) | Math.round(d[o + 4] * 255);
    for (let k = 0; k <= n; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / n), y = Math.round(y0 + ((y1 - y0) * k) / n);
      if (x >= 0 && y >= 0 && x < board.width && y < board.height) board.frame[y * board.width + x] = c;
    }
    if (n === 1 && x0 === x1 && y0 === y1) { const x = Math.round(x0), y = Math.round(y0); if (x >= 0 && y >= 0 && x < board.width && y < board.height) board.frame[y * board.width + x] = c; }
  }
}
const S = board.vector ? 1 : 2, W = board.width * S, H = board.height * S;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const p = board.frame[((y / S) | 0) * board.width + ((x / S) | 0)], o = y * (W * 3 + 1) + 1 + x * 3;
  raw[o] = p & 0xFF; raw[o + 1] = (p >> 8) & 0xFF; raw[o + 2] = (p >> 16) & 0xFF;
}
const chunk = (t, d) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t), d]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.mkdirSync(outPath.replace(/[^/]*$/, '') || '.', { recursive: true });
fs.writeFileSync(outPath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${outPath}`);
