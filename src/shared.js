// ROM set reading, storage, loading modal and toast.

import { isZip } from './unzip.js';

const STORE = 'z80js:';

export const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(STORE + key)); } catch { return null; } },
  set(key, v) { try { localStorage.setItem(STORE + key, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  remove(key) { try { localStorage.removeItem(STORE + key); } catch { /* storage unavailable */ } },
  // Like set, but reports whether the write landed (false when full or blocked).
  trySet(key, v) {
    try { localStorage.setItem(STORE + key, typeof v === 'string' ? v : JSON.stringify(v)); return true; } catch { return false; }
  },
  getRaw(key) { try { return localStorage.getItem(STORE + key); } catch { return null; } },
};

// Read a user-picked ROM set. Arcade sets are zips of the board's chips and are
// kept whole; returns { bytes, name } with the .zip extension dropped.
export async function readRomFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isZip(bytes)) throw new Error('pick the game\'s ROM set (a .zip file)');
  return { bytes, name: file.name.replace(/\.zip$/i, '') };
}

// Show the loading modal (#loading / #loadingName) for the duration of
// `work`, and at least briefly so fast loads don't flicker.
export async function withLoading(label, work) {
  const el = document.getElementById('loading');
  document.getElementById('loadingName').textContent = label;
  el.classList.add('show');
  const started = performance.now();
  try {
    return await work();
  } finally {
    const wait = 450 - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    el.classList.remove('show');
  }
}

let toastTimer = 0;
// Short message at the bottom of the screen; errors unless `info` is set.
export function toast(msg, { info = false } = {}) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('info', info);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}
