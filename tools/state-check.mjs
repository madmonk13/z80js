#!/usr/bin/env node
// Save-state check: run each set, save at frame 2000, restore into a fresh
// board, and compare the picture and RAM for the next 600 frames.
//
//   node tools/state-check.mjs [set ...]      (default: every zip in roms/)

import fs from 'node:fs';
import path from 'node:path';
import { extractAll } from '../src/unzip.js';
import { identify } from '../src/emu/boards.js';
import { encode, decode } from '../src/emu/state.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const sets = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(path.join(root, 'roms')).filter((f) => f.endsWith('.zip')).map((f) => f.slice(0, -4));
const inputs = (f) => ({ coin: f >= 1500 && f < 1506, start1: f >= 1700 && f < 1706,
  left: f > 1000 && !!((f >> 5) & 1), right: f > 1000 && !((f >> 5) & 1), up: f > 1000 && (f % 97) < 20, fire: f > 1000 && (f % 23) < 4 });
const picOf = (b) => (b.vector ? b.vectors.data.subarray(0, b.vectors.count * 7) : b.frame);
const ramOf = (b) => [b.ram, b.vram, b.obj, b.spritePos, b.spriteRam, b.bitmap, b.fgRam, b.bgRam, b.sprites].filter(Boolean);

for (const z of sets) {
  let Board, roms;
  try { ({ Board, roms } = identify(await extractAll(new Uint8Array(fs.readFileSync(path.join(root, 'roms', z + '.zip')))))); }
  catch { console.log(`${z.padEnd(12)} (not a supported set)`); continue; }
  const a = new Board(roms);
  const SAVE_AT = 2000, MORE = 600;
  for (let f = 0; f < SAVE_AT; f++) { a.setInputs(inputs(f)); a.runFrame(); }
  const text = encode(a.saveState());
  const b = new Board(roms);
  b.loadState(decode(text));
  let firstDiff = -1;
  for (let f = SAVE_AT; f < SAVE_AT + MORE; f++) {
    a.setInputs(inputs(f)); b.setInputs(inputs(f));
    a.runFrame(); b.runFrame();
    const pa = picOf(a), pb = picOf(b);
    const same = pa.length === pb.length && pa.every((p, i) => p === pb[i]) && ramOf(a).every((r, k) => r.every((v, i) => v === ramOf(b)[k][i]));
    if (!same) { firstDiff = f; break; }
  }
  console.log(`${Board.title.padEnd(16)} save ${(text.length / 1024).toFixed(1)} KB  ${firstDiff < 0 ? `identical for ${MORE} frames after restore` : `DIVERGED at frame ${firstDiff}`}`);
}
