import { identify, SUPPORTED, ROM_FILES } from './emu/boards.js';
import { extractAll } from './unzip.js';
import { encode, decode } from './emu/state.js';
import { Screen2D } from './render/screen2d.js';
import { Input } from './input.js';
import { AudioOut } from './audio-out.js';
import { store, readRomFile, withLoading, toast } from './shared.js';
import { library, renderLibrary } from './library.js';
import { TouchControls } from './touch.js';

const $ = (id) => document.getElementById(id);
const SOUND_RATE = 48000;        // every board's sound source runs at this rate
const MIN_BUTTON_MS = 120;       // Coin / Start stay down at least this long

const DEFAULTS = {
  leftHanded: false,
  dpadSize: 140,
  haptics: true,
  hints: true,
  zones: true,       // outline each control's area
  zoneOpacity: 25,   // percent
  zoneOverlap: 25,   // percent: how far the control zones reach over the picture
  sound: true,
  volume: 70,        // percent
  switches: {},      // board id -> { switch id -> value }
  resume: true,      // pick games up where they were left
};

const input = new Input();
const audio = new AudioOut(SOUND_RATE);
let screen2d = null;
const touch = new TouchControls({
  surface: $('surface'), dpad: $('dpad'), ripples: $('ripples'),
  buttons: [$('menuBtn'), $('pauseBtn'), $('cartBtn'), $('coinBtn'), $('startBtn')],
});
input.sources.push(touch);

const settings = { ...DEFAULTS, ...(store.get('settings') || {}) };
settings.switches = { ...settings.switches };
const state = { romId: null, menuOpen: false, paused: false };
let board = null;

// Block page-level zoom/scroll gestures; this is a full-screen app.
for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (!e.target.closest('.sheet')) e.preventDefault();
}, { passive: false });

// ---------------------------------------------------------------- audio

// iOS only (re)starts audio inside a user gesture, and only some events count
// (touchend and click, not always pointer events whose default was prevented),
// so try on all of them. Capture phase so nothing can stop them first.
const unlockAudio = () => { if (settings.sound) audio.start(); };
for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
  window.addEventListener(ev, unlockAudio, { capture: true, passive: true });
}
// Coming back from the background often leaves audio suspended or interrupted.
document.addEventListener('visibilitychange', () => { if (!document.hidden && settings.sound) audio.resume(); });

// ---------------------------------------------------------------- DIP switches

// Each board lists its switches (Board.switches); the chosen values are kept
// per game and, as on the real boards, read when the game starts.
function switchValues(Board) {
  const saved = settings.switches[Board.id] || {};
  return Object.fromEntries(Board.switches.map((sw) =>
    [sw.id, sw.options.some(([, v]) => v === saved[sw.id]) ? saved[sw.id] : sw.default]));
}

function renderSwitches() {
  const el = $('switches');
  el.textContent = '';
  if (!board) { el.innerHTML = '<p class="hint">Load a game to see its switches.</p>'; return; }
  const Board = board.constructor, values = switchValues(Board);
  for (const sw of Board.switches) {
    const row = document.createElement('div');
    row.className = 'field inline';
    const label = document.createElement('span');
    label.textContent = sw.label;
    const seg = document.createElement('div');
    seg.className = 'seg';
    for (const [text, value] of sw.options) {
      const b = document.createElement('button');
      b.textContent = text;
      b.classList.toggle('active', values[sw.id] === value);
      b.addEventListener('click', () => {
        settings.switches[Board.id] = { ...values, [sw.id]: value };
        save();
        renderSwitches();
      });
      seg.append(b);
    }
    row.append(label, seg);
    el.append(row);
  }
}

// ---------------------------------------------------------------- resume

// The game in progress is saved when the page is hidden or closed, and every
// few seconds while playing, so a refresh or relaunch picks up where it was.
const RESUME = 'resume:';
const RESUME_VERSION = 1;              // bump when saved state stops being compatible
const RESUME_EVERY_MS = 5000;

function saveResume() {
  if (!board || !settings.resume || !state.romId) return;
  store.trySet(RESUME + state.romId, encode({ v: RESUME_VERSION, board: board.constructor.id, bv: board.constructor.stateVersion ?? 1, state: board.saveState() }));
}

function restoreResume(id) {
  if (!settings.resume) return false;
  const text = store.getRaw(RESUME + id);
  if (!text) return false;
  try {
    const saved = decode(text);
    // A board bumps its own stateVersion when an emulation fix makes older saves wrong.
    if (saved.v !== RESUME_VERSION || saved.board !== board.constructor.id || (saved.bv ?? 1) !== (board.constructor.stateVersion ?? 1)) throw new Error('stale');
    board.loadState(saved.state);
    return true;
  } catch {
    store.remove(RESUME + id);           // unreadable or from an older version: start fresh
    board.reset();
    return false;
  }
}

document.addEventListener('visibilitychange', () => { if (document.hidden) saveResume(); });
window.addEventListener('pagehide', saveResume);

// ---------------------------------------------------------------- ROM sets

// Start a board from a ROM set (the zip as added) and record it.
async function loadSet(bytes, name, id) {
  if (state.paused) setPaused(false);
  const { Board, roms } = identify(await extractAll(bytes));
  saveResume();                          // keep the game being left
  board = new Board(roms);
  board.applySwitches(switchValues(Board));
  board.reset();
  audio.setSource(board.sound);
  if (!screen2d || screen2d.canvas.width !== board.width || screen2d.canvas.height !== board.height) {
    screen2d = new Screen2D($('screen2d'), board.width, board.height);
  }
  // Two-way games (left/right only) get the narrow pad; the rest a 4- or 8-way d-pad.
  const twoWay = board.controls === 'two-way';
  touch.twoWay = twoWay;
  touch.eightWay = board.controls === 'eight-way';
  touch.stickOnly = board.buttons === 0;
  touch.twoButtons = board.buttons === 2;
  touch.dial = !!board.dialControl;
  document.body.classList.toggle('two-way', twoWay);
  document.body.classList.toggle('stick-only', touch.stickOnly);
  document.body.classList.toggle('two-buttons', touch.twoButtons);
  $('joyHintText').textContent = twoWay ? 'Drag left or right on this side'
    : touch.stickOnly ? 'Touch & drag anywhere' : 'Touch & drag on this side';
  const [dialTitle, dialText] = board.dialHint ?? ['Fire & aim', 'Hold to fire, drag sideways to aim'];
  $('fireHintTitle').textContent = touch.dial ? dialTitle : touch.twoButtons ? `Fire · ${board.button2}` : 'Fire';
  $('fireHintText').textContent = touch.dial ? dialText
    : touch.twoButtons ? `Bottom half fires, top half is ${board.button2.toLowerCase()}` : 'Tap on this side';
  // The control-zone outlines' labels.
  $('stickZoneTitle').textContent = 'Move';
  $('stickZoneText').textContent = twoWay ? 'Left / right' : touch.eightWay ? '8-way' : '4-way';
  $('fireZoneTitle').textContent = touch.dial ? dialTitle : 'Fire';
  $('fireZoneText').textContent = touch.dial ? 'Hold · drag sideways' : 'Tap';
  $('fire2ZoneTitle').textContent = board.button2 || '';
  renderSwitches();
  layout2D();
  const res = library.add(name, bytes, Board.title);
  if (!res.stored) toast('Storage is full, so this ROM set won\'t be saved. Remove some to make room.');
  state.romId = id || res.id;
  restoreResume(state.romId);
  if (res.stored) library.setLast(state.romId);
  refreshLibrary();
}

function refreshLibrary() {
  renderLibrary($('library'), {
    titles: SUPPORTED,
    files: ROM_FILES,
    currentId: state.romId,
    onAdd: () => $('romFile').click(),
    onPlay: (entry) => playEntry(entry),
    onRemove: (entry) => {
      library.remove(entry.id);
      store.remove(RESUME + entry.id);
      if (entry.id === state.romId) { board = null; state.romId = null; }
      refreshLibrary();
    },
  });
  const n = library.list().length;
  $('libraryInfo').textContent = n
    ? `${n} saved · ${Math.ceil(library.usage() / 1024)} KB on this device`
    : 'Add a game\'s ROM set (the zip used by MAME) to enable it. Sets are kept on this device.';
}

async function playEntry(entry) {
  try {
    await withLoading(entry.name, async () => {
      const bytes = library.get(entry.id);
      if (!bytes) throw new Error('its saved data is missing');
      await loadSet(bytes, entry.name, entry.id);
    });
    closeMenu();
  } catch (err) {
    toast(`Couldn't load ${entry.name}: ${err.message}`);
  }
}

async function loadFile(file) {
  try {
    await withLoading(file.name, async () => {
      const { bytes, name } = await readRomFile(file);
      await loadSet(bytes, name);
    });
    closeMenu();
  } catch (err) {
    toast(`Couldn't load ${file.name}: ${err.message}`);
  }
}

$('loadBtn').addEventListener('click', () => $('romFile').click());
$('romFile').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });

// ---------------------------------------------------------------- menu

// Settings and the game list are full-screen takeovers. The game pauses and
// the touch controls go inert while either is open.
const SHEETS = { menu: 'closeMenu', cartsMenu: 'closeCarts' }; // backdrop id → close button id

function openSheet(id) {
  for (const other of Object.keys(SHEETS)) $(other).hidden = other !== id;
  state.menuOpen = true;
  touch.releaseAll();
  touch.enabled = false;
  audio.setMuted(true);
}
function closeMenu() {
  if (!board) return;                // nothing to go back to until a game is loaded
  state.menuOpen = false;
  touch.enabled = !state.paused;
  audio.setMuted(!settings.sound || state.paused);
  for (const id of Object.keys(SHEETS)) $(id).hidden = true;
}
// Open on release rather than 'click': mobile browsers can drop the click when
// the finger shifts slightly or another finger is already on the screen.
// Pause: stops the game (and its sound) until resumed from the bar button,
// the veil over the game, or P on a keyboard. The game is saved for resume.
function setPaused(paused) {
  state.paused = paused;
  store.set('paused', paused);           // kept across reloads
  document.body.classList.toggle('paused', paused);
  $('paused').hidden = !paused;
  $('pauseBtn').setAttribute('aria-pressed', String(paused));
  $('pauseBtn').setAttribute('aria-label', paused ? 'Resume' : 'Pause');
  if (paused) { touch.releaseAll(); saveResume(); }
  touch.enabled = !paused && !state.menuOpen;
  audio.setMuted(paused || state.menuOpen || !settings.sound);
}
$('pauseBtn').addEventListener('pointerup', (e) => { e.preventDefault(); setPaused(!state.paused); });
$('pauseBtn').addEventListener('click', (e) => { if (e.detail === 0) setPaused(!state.paused); }); // keyboard
$('paused').addEventListener('pointerup', (e) => { e.preventDefault(); setPaused(false); });
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyP' || e.metaKey || e.ctrlKey || e.altKey || state.menuOpen) return;
  e.preventDefault();
  setPaused(!state.paused);
});

for (const [btn, sheet] of [['menuBtn', 'menu'], ['cartBtn', 'cartsMenu']]) {
  $(btn).addEventListener('pointerup', (e) => { e.preventDefault(); openSheet(sheet); });
  $(btn).addEventListener('click', (e) => { if (e.detail === 0) openSheet(sheet); }); // keyboard
}
for (const [sheet, close] of Object.entries(SHEETS)) {
  $(close).addEventListener('click', closeMenu);
  // After rotating, iOS can hit-test a full-screen sheet against its old layout,
  // so the close button (which moves) stops getting taps. Judge by position instead.
  $(sheet).addEventListener('pointerup', (e) => {
    const r = $(close).getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) closeMenu();
  });
}

function save() { store.set('settings', settings); }

function applyControls() {
  document.body.classList.toggle('lefty', settings.leftHanded);
  touch.leftHanded = settings.leftHanded;
  touch.haptics = settings.haptics;
  touch.setSize(settings.dpadSize);
  $('dpadSizeVal').textContent = `${settings.dpadSize}px`;
  document.body.classList.toggle('show-zones', settings.zones);
  document.documentElement.style.setProperty('--zone-opacity', settings.zoneOpacity / 100);
  $('zoneOpacityVal').textContent = `${settings.zoneOpacity}%`;
  $('zoneOpacity').disabled = !settings.zones;
  $('zoneOverlapVal').textContent = `${settings.zoneOverlap}%`;
}

function syncMenu() {
  $('leftHanded').checked = settings.leftHanded;
  $('dpadSize').value = settings.dpadSize;
  $('haptics').checked = settings.haptics;
  $('hints').checked = settings.hints;
  $('zones').checked = settings.zones;
  $('zoneOpacity').value = settings.zoneOpacity;
  $('zoneOverlap').value = settings.zoneOverlap;
  $('sound').checked = settings.sound;
  $('volume').value = settings.volume;
  $('resume').checked = settings.resume;
  applySound();
  $('hapticsRow').hidden = !navigator.vibrate;
  applyControls();
}

let hintTimer = 0;
function flashHints(ms) {
  if (!settings.hints) return;
  document.body.classList.add('show-hints');
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(() => document.body.classList.remove('show-hints'), ms);
}

$('leftHanded').addEventListener('change', (e) => {
  settings.leftHanded = e.target.checked; applyControls(); layout2D(); save(); flashHints(2500);
});
$('dpadSize').addEventListener('input', (e) => { settings.dpadSize = +e.target.value; applyControls(); save(); });
$('haptics').addEventListener('change', (e) => {
  settings.haptics = e.target.checked; applyControls(); save();
  if (settings.haptics && navigator.vibrate) navigator.vibrate(15);
});
$('zones').addEventListener('change', (e) => { settings.zones = e.target.checked; applyControls(); save(); });
$('zoneOpacity').addEventListener('input', (e) => { settings.zoneOpacity = +e.target.value; applyControls(); save(); });
$('zoneOverlap').addEventListener('input', (e) => { settings.zoneOverlap = +e.target.value; applyControls(); layout2D(); save(); });
$('hints').addEventListener('change', (e) => {
  settings.hints = e.target.checked; save();
  if (settings.hints) flashHints(2500); else document.body.classList.remove('show-hints');
});
function applySound() {
  audio.setVolume(settings.volume / 100);
  $('volumeVal').textContent = `${settings.volume}%`;
  $('volume').disabled = !settings.sound;
}
$('sound').addEventListener('change', (e) => {
  settings.sound = e.target.checked; save();
  if (settings.sound) audio.start();
  audio.setMuted(!settings.sound || state.menuOpen);
  applySound();
});
$('volume').addEventListener('input', (e) => { settings.volume = +e.target.value; applySound(); save(); });
$('volume').addEventListener('change', () => audio.preview());

$('resume').addEventListener('change', (e) => {
  settings.resume = e.target.checked; save();
  if (settings.resume) saveResume(); else if (state.romId) store.remove(RESUME + state.romId);
});

// Game switches take effect when the game restarts, as on the real boards.
$('powerBtn').addEventListener('click', () => {
  if (!board) return;
  store.remove(RESUME + state.romId);
  board.applySwitches(switchValues(board.constructor));
  board.reset();
  closeMenu();
});

// Coin and Start: held while pressed, but never shorter than a few frames.
function holdButton(el, key) {
  let downAt = 0, timer = 0;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    downAt = performance.now();
    input[key] = true;
    el.classList.add('held');
  });
  const release = () => {
    if (!input[key]) return;
    const left = MIN_BUTTON_MS - (performance.now() - downAt);
    const off = () => { input[key] = false; el.classList.remove('held'); };
    if (left > 0) timer = setTimeout(off, left); else off();
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
}
holdButton($('coinBtn'), 'uiCoin');
holdButton($('startBtn'), 'uiStart');

// The touch-zone hints fade once the player starts playing, whether by touch,
// mouse, keyboard or gamepad.
function dismissHints() {
  if (document.body.classList.contains('show-hints')) {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => document.body.classList.remove('show-hints'), 600);
  }
}
touch.onTouch = dismissHints;
input.onActivity = dismissHints;

// ---------------------------------------------------------------- display

// Safe-area insets in px, measured from a probe that uses env().
const probe = document.createElement('div');
probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
  'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
document.body.appendChild(probe);

function layout2D() {
  const c = $('screen2d');
  const ps = getComputedStyle(probe);
  const sl = parseFloat(ps.paddingLeft) || 0, sr = parseFloat(ps.paddingRight) || 0;
  const st = parseFloat(ps.paddingTop) || 0, sb = parseFloat(ps.paddingBottom) || 0;
  const W = window.innerWidth, H = window.innerHeight;
  const pad = 10;
  const aspect = board ? board.width / board.height : 3 / 4;
  const barH = $('bar').offsetHeight;
  const availW = W - sl - sr - pad * 2;
  const portrait = H > W;
  // Portrait sits below the bar and keeps the lower part of the screen free for
  // thumbs. Landscape uses the full height, running up behind the bar.
  // Two-button games give the picture a little less room in portrait, so the
  // two stacked buttons below it are each a comfortable size.
  const share = touch.twoButtons ? 0.65 : 0.7;
  const availH = portrait ? (H - barH - sb) * share : H - st - sb;
  const w = Math.max(80, Math.min(availW, availH * aspect));
  const h = w / aspect;
  const top = portrait ? barH + 4 : st + (availH - h) / 2;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  c.style.left = `${sl + pad + (availW - w) / 2}px`;
  c.style.top = `${top}px`;
  const left = sl + pad + (availW - w) / 2;
  layoutZones(portrait, { left, top, right: left + w, bottom: top + h, w, h });
}

// The control zones keep mostly clear of the picture: they reach over its
// edge by the "zone overlap" setting (a share of its height in portrait, of
// the way to its middle in landscape; 100% is the whole surface). In portrait they sit in the band below the
// picture; in landscape, in the margins beside it. The zone outlines are drawn
// there, and a two-button game's second button is the upper half of the fire
// side's zone. Other touches still count by side: stick on one, fire on the other.
const MIN_ZONE = 80;   // px: a landscape zone never gets narrower than this
function layoutZones(portrait, pic) {
  const sr = $('surface').getBoundingClientRect(), style = $('surface').style;
  const k = settings.zoneOverlap / 100, mid = sr.left + sr.width / 2;
  document.body.classList.toggle('portrait', portrait);
  if (portrait) {
    const band = Math.max(sr.top, pic.bottom - pic.h * k), split = (band + sr.bottom) / 2;
    const fireLeft = settings.leftHanded ? sr.left : mid, fireRight = settings.leftHanded ? mid : sr.right;
    touch.fire2Area = { left: fireLeft, right: fireRight, top: band, bottom: split };
    style.setProperty('--band-top', `${band - sr.top}px`);
    style.setProperty('--split', `${split - sr.top}px`);
    style.setProperty('--left-inner', '0px');
    style.setProperty('--right-inner', '0px');
  } else {
    // How far each side's zone stops short of the middle line.
    const room = sr.width / 2 - MIN_ZONE, reach = (pic.w / 2) * k;
    const leftInner = Math.min(room, Math.max(0, mid - (pic.left + reach)));
    const rightInner = Math.min(room, Math.max(0, (pic.right - reach) - mid));
    touch.fire2Area = settings.leftHanded
      ? { left: sr.left, right: mid - leftInner, top: sr.top, bottom: sr.top + sr.height / 2 }
      : { left: mid + rightInner, right: sr.right, top: sr.top, bottom: sr.top + sr.height / 2 };
    style.setProperty('--left-inner', `${leftInner}px`);
    style.setProperty('--right-inner', `${rightInner}px`);
  }
}
// Rotating can leave iOS with the page scrolled or zoomed a little, which shifts
// where taps land relative to what's drawn. Snap back after every resize, and
// again once the rotation animation has settled.
function onViewportChange() {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  if (state.menuOpen && innerWidth > innerHeight) document.querySelector('.settings-sheet').scrollTop = 0;
  layout2D();
}
let settleTimer = 0;
function onRotate() {
  onViewportChange();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(onViewportChange, 350);
}
window.addEventListener('resize', onRotate);
window.addEventListener('orientationchange', onRotate);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onRotate);

// ---------------------------------------------------------------- loop

let acc = 0, lastTime = performance.now(), lastSave = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  const running = board && !state.menuOpen && !state.paused && !document.hidden;
  // The pause button only means something with a game loaded.
  const pauseBtn = $('pauseBtn');
  if (pauseBtn.disabled === !!board) pauseBtn.disabled = !board;

  if (running) {
    acc += dt;
    let ran = 0;
    const frameTime = 1 / board.refresh;
    while (acc >= frameTime && ran < 4) {
      const s = input.read();
      if (board.buttons < 2) s.fire ||= s.fire2;    // a second button is just fire here
      board.setInputs(s);
      board.runFrame();
      acc -= frameTime;
      ran++;
    }
    if (ran === 4) acc = 0;
    audio.flush();
    if (ran) screen2d.draw(board.frame);
    if (now - lastSave > RESUME_EVERY_MS) { lastSave = now; saveResume(); }
  } else {
    acc = 0;
  }

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- boot

(async () => {
  syncMenu();
  audio.setMuted(!settings.sound);
  refreshLibrary();
  const lastId = library.lastId();
  const last = lastId ? library.entry(lastId) : null;
  const bytes = last && library.get(last.id);
  if (bytes) {
    try {
      await withLoading(last.name, () => loadSet(bytes, last.name, last.id));
    } catch (err) {
      toast(`Couldn't load ${last.name}: ${err.message}`);
    }
  } else {
    $('loading').classList.remove('show');
  }
  if (!board) openSheet('cartsMenu');   // first run: ask for a ROM set
  else if (store.get('paused')) setPaused(true);   // it was paused when the page closed
  layout2D();
  flashHints(0);
  requestAnimationFrame(tick);
})();

window.touch = touch;
window.input = input;
window.audio = audio;
Object.defineProperty(window, 'board', { get: () => board });
