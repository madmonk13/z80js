// Local game collection, kept in localStorage.
//
// Layout: one index entry list under `library`, and each ROM set's zip (base64)
// under `rom:<id>`. The id is a content hash, so adding the same set twice
// doesn't duplicate it.

import { store } from './shared.js';

const INDEX = 'library';
const ROM = 'rom:';
const LAST = 'lastRomId';

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

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

function readIndex() { return store.get(INDEX) || []; }
function writeIndex(list) { return store.trySet(INDEX, list); }

export const library = {
  // Entries, most recently played first.
  list() {
    return readIndex().sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  },

  entry(id) { return readIndex().find((e) => e.id === id) || null; },

  get(id) {
    const data = store.getRaw(ROM + id);
    if (!data) return null;
    try { return fromBase64(data); } catch { return null; }
  },

  // Add (or refresh) a game. Returns { id, stored, isNew }; stored is false
  // when the browser refused the write (storage full or blocked).
  add(name, bytes, mapper) {
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
    if (!store.trySet(ROM + id, toBase64(bytes))) return { id, stored: false, isNew: true };
    list.push({ id, name, size: bytes.length, mapper, added: now, lastPlayed: now });
    if (!writeIndex(list)) {
      store.remove(ROM + id);
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
    writeIndex(readIndex().filter((e) => e.id !== id));
    if (this.lastId() === id) store.remove(LAST);
  },

  lastId() { return store.get(LAST); },
  setLast(id) { store.set(LAST, id); },

  // Approximate bytes used by stored ROMs (base64 is ~4/3 of the raw size).
  usage() { return readIndex().reduce((n, e) => n + Math.ceil(e.size / 3) * 4, 0); },
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
export function renderLibrary(el, { titles, currentId, onPlay, onRemove, onAdd }) {
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
  for (const title of [...titles].sort(byTitle)) {
    const sets = entries.filter((e) => e.mapper === title);
    if (!sets.length) { row(title, 'Upload ROM to enable', { missing: true }); continue; }
    // Two sets for one game (a clone, say) are told apart by file name.
    for (const e of sets) row(title, sets.length > 1 ? `${e.name} · ${detail(e)}` : detail(e), { entry: e });
  }
  for (const e of entries.filter((x) => !titles.includes(x.mapper)).sort((a, b) => byTitle(a.name, b.name))) {
    row(e.name, detail(e), { entry: e });
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
