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

const S = 2, W = board.width * S, H = board.height * S;
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
