// Local game collection. The index (a small list of entries) lives in
// localStorage under `library`; the ROM sets themselves, which run to tens of
// megabytes for the later boards, live in IndexedDB, keyed by a content hash
// (so adding the same set twice doesn't duplicate it). Sets saved by earlier
// versions as base64 in localStorage (`rom:<id>`) move over when next loaded.

import { store } from './shared.js';

const INDEX = 'library';
const ROM = 'rom:';
const LAST = 'lastRomId';

function fromBase64(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// FNV-1a over the bytes, plus the length; plenty to tell sets apart.
export function romId(bytes) {
  let h = 0x811C9DC5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0') + bytes.length.toString(16);
}

// ---------------------------------------------------------------- IndexedDB

const DB_NAME = 'z80js', DB_STORE = 'roms';
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return dbPromise;
}
async function dbDo(mode, fn) {
  const d = await db();
  if (!d) throw new Error('storage unavailable');
  return new Promise((resolve, reject) => {
    const tx = d.transaction(DB_STORE, mode);
    const req = fn(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('storage error'));
  });
}
const dbGet = (id) => dbDo('readonly', (s) => s.get(id));
const dbPut = (id, bytes) => dbDo('readwrite', (s) => s.put(bytes, id));
const dbDelete = (id) => dbDo('readwrite', (s) => s.delete(id));

// Ask once for storage the browser won't clear under pressure.
let persistAsked = false;
function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try { navigator.storage?.persist?.(); } catch { /* not supported */ }
}

function readIndex() { return store.get(INDEX) || []; }
function writeIndex(list) { return store.trySet(INDEX, list); }

export const library = {
  // Entries, most recently played first.
  list() {
    return readIndex().sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  },

  entry(id) { return readIndex().find((e) => e.id === id) || null; },

  async get(id) {
    try {
      const v = await dbGet(id);
      if (v) return new Uint8Array(v);
    } catch { /* fall through to an older copy */ }
    // Saved by an earlier version: move it into IndexedDB.
    const data = store.getRaw(ROM + id);
    if (!data) return null;
    let bytes;
    try { bytes = fromBase64(data); } catch { return null; }
    try { await dbPut(id, bytes); store.remove(ROM + id); } catch { /* keep the old copy */ }
    return bytes;
  },

  // Add (or refresh) a game. Returns { id, stored, isNew }; stored is false
  // when the browser refused the write (storage full or blocked).
  async add(name, bytes, mapper) {
    const id = romId(bytes);
    const list = readIndex();
    const now = Date.now();
    const existing = list.find((e) => e.id === id);
    if (existing) {
      existing.lastPlayed = now;
      existing.mapper = mapper;
      writeIndex(list);
      return { id, stored: true, isNew: false };
    }
    askPersist();
    try { await dbPut(id, bytes); } catch { return { id, stored: false, isNew: true }; }
    list.push({ id, name, size: bytes.length, mapper, added: now, lastPlayed: now });
    if (!writeIndex(list)) {
      dbDelete(id).catch(() => {});
      return { id, stored: false, isNew: true };
    }
    return { id, stored: true, isNew: true };
  },

  markPlayed(id) {
    const list = readIndex();
    const e = list.find((x) => x.id === id);
    if (e) { e.lastPlayed = Date.now(); writeIndex(list); }
  },

  remove(id) {
    store.remove(ROM + id);
    dbDelete(id).catch(() => {});
    writeIndex(readIndex().filter((e) => e.id !== id));
    if (this.lastId() === id) store.remove(LAST);
  },

  lastId() { return store.get(LAST); },
  setLast(id) { store.set(LAST, id); },

  // Bytes used by stored ROM sets.
  usage() { return readIndex().reduce((n, e) => n + (e.size || 0), 0); },
};

function ago(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function sizeLabel(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)}K`;
}

// Render the games list into `el` (a <ul>): every supported game in
// alphabetical order, each ROM set added for it as a playable row and games
// without one greyed out (tapping those calls onAdd). Sets for games no longer
// recognized are listed after them. Removing takes two taps.
export function renderLibrary(el, { titles, files = {}, currentId, onPlay, onRemove, onAdd }) {
  el.textContent = '';
  const row = (label, detail, { entry, missing } = {}) => {
    const li = document.createElement('li');
    li.className = 'cart-item' + (entry && entry.id === currentId ? ' playing' : '') + (missing ? ' missing' : '');
    const play = document.createElement('button');
    play.className = 'cart-play';
    const name = document.createElement('b');
    name.textContent = label;
    const meta = document.createElement('small');
    meta.textContent = detail;
    play.append(name, meta);
    play.addEventListener('click', () => (entry ? onPlay(entry) : onAdd()));
    li.append(play);
    if (entry) li.append(removeButton(entry, label, onRemove));
    el.append(li);
  };
  const detail = (e) => (e.id === currentId ? 'Playing'
    : [e.size ? sizeLabel(e.size) : '', ago(e.lastPlayed)].filter(Boolean).join(' · '));

  const entries = library.list();
  const byTitle = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  // Games you have first, then the ones still waiting for a ROM set; each
  // group alphabetical.
  const sorted = [...titles].sort(byTitle);
  const have = sorted.filter((t) => entries.some((e) => e.mapper === t));
  // Sets that aren't a known game (shouldn't happen, but keep them reachable) go with the uploaded ones.
  const others = entries.filter((x) => !titles.includes(x.mapper));
  const uploaded = [...have.map((t) => ({ title: t })), ...others.map((e) => ({ title: e.name, entry: e }))].sort((a, b) => byTitle(a.title, b.title));
  for (const { title, entry } of uploaded) {
    if (entry) { row(entry.name, detail(entry), { entry }); continue; }
    const sets = entries.filter((e) => e.mapper === title);
    // Two sets for one game (a clone, say) are told apart by file name.
    for (const e of sets) row(title, sets.length > 1 ? `${e.name} · ${detail(e)}` : detail(e), { entry: e });
  }
  for (const title of sorted.filter((t) => !have.includes(t))) {
    row(title, `Upload ${files[title] || 'ROM'} to enable`, { missing: true });
  }
}

function removeButton(entry, label, onRemove) {
  const rm = document.createElement('button');
  rm.className = 'cart-remove';
  rm.setAttribute('aria-label', `Remove ${label}`);
  rm.textContent = '✕';
  let timer = 0;
  rm.addEventListener('click', () => {
    if (!rm.classList.contains('confirm')) {
      rm.classList.add('confirm');
      rm.textContent = 'Remove';
      timer = setTimeout(() => { rm.classList.remove('confirm'); rm.textContent = '✕'; }, 3000);
      return;
    }
    clearTimeout(timer);
    onRemove(entry);
  });
  return rm;
}
