import { identify, SUPPORTED, ROM_FILES } from './emu/boards.js';
import { extractAll } from './unzip.js';
import { encode, decode } from './emu/state.js';
import { Screen2D } from './render/screen2d.js';
import { ScreenVector } from './render/vector.js';
import { Input, controlLegend } from './input.js';
import { InputMode } from './input-mode.js';
import { AudioOut } from './audio-out.js';
import { store, readRomFile, withLoading, toast } from './shared.js';
import { library, renderLibrary, server, romId } from './library.js';
import { TouchControls } from './touch.js';
import { registerServiceWorker } from './sw-update.js';

const $ = (id) => document.getElementById(id);
const SOUND_RATE = 48000;        // every board's sound source runs at this rate
const MIN_BUTTON_MS = 120;       // Coin / Start stay down at least this long

const DEFAULTS = {
  leftHanded: false,
  dpadSize: 140,
  haptics: true,
  hints: false,      // the touch hints (Move / Fire cards); off by default
  zones: true,       // outline each control's area
  zoneOpacity: 25,   // percent
  zoneOverlap: 25,   // percent: how far the control zones reach over the picture
  sound: true,
  volume: 70,        // percent
  switches: {},      // board id -> { switch id -> value }
  resume: true,      // pick games up where they were left
  showAll: true,     // list every supported game, not just the ones with a ROM set added
  perf: false,       // the performance readout
  hintsFor: 'auto',  // which controls' hints to show: 'auto' (the input last used), 'touch', 'keys' or 'pad'
};

const input = new Input();
const audio = new AudioOut(SOUND_RATE);
let screen2d = null;
const touch = new TouchControls({
  surface: $('surface'), dpad: $('dpad'), aimPad: $('aimpad'), ripples: $('ripples'),
  buttons: [$('menuBtn'), $('pauseBtn'), $('cartBtn'), $('coinBtn'), $('startBtn'), $('start2Btn'), $('start3Btn'), $('start4Btn')],
});
input.sources.push(touch);

const settings = { ...DEFAULTS, ...(store.get('settings') || {}) };
settings.switches = { ...settings.switches };
// Touch hints became off by default (the zone outlines now introduce the controls); turn
// them off once for settings saved before that.
if (!settings.hintsOffByDefault) { settings.hints = false; settings.hintsOffByDefault = true; store.set('settings', settings); }
// Touch, keyboard or gamepad: which hints to show (the zone outlines, or a list of the keys or buttons).
const inputMode = new InputMode({ storageKey: 'z80js.inputMode' });
inputMode.override = settings.hintsFor;
inputMode.onChange = () => renderControls();
const state = { romId: null, serverFile: null, menuOpen: false, paused: false };
const LAST_SERVER = 'lastServerFile';
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

// The game in progress is saved whenever play stops: on pause, when a menu opens, when
// another game loads, and when the page is hidden or closed (switching apps, locking the
// phone), so a refresh or relaunch picks up where it was. Nothing is saved mid-play, so
// the save never costs a frame.
const RESUME = 'resume:';
const RESUME_VERSION = 1;              // bump when saved state stops being compatible

// Battery-backed RAM (a board's `nvram`: settings and high scores) is kept
// per ROM set, whether or not resume is on.
const NVRAM = 'nvram:';

function saveNvram() {
  if (board?.nvram && state.romId) store.trySet(NVRAM + state.romId, encode(board.nvram));
}

function loadNvram(id) {
  const text = board.nvram && store.getRaw(NVRAM + id);
  if (!text) return;
  try {
    const v = decode(text);
    if (v.length === board.nvram.length) board.nvram.set(v);
  } catch { store.remove(NVRAM + id); }
}

function saveResume() {
  saveNvram();
  if (!board || !settings.resume || !state.romId) return;
  const key = RESUME + state.romId;
  const text = encode({ v: RESUME_VERSION, board: board.constructor.id, bv: board.constructor.stateVersion ?? 1, state: board.saveState() });
  if (store.trySet(key, text)) return;
  // Out of room (the later boards' states run to several hundred K): drop the
  // other games' resume points and try again.
  for (const k of store.keys()) if (k.startsWith(RESUME) && k !== key) store.remove(k);
  store.trySet(key, text);
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
// keep: store the set on the device (always, for uploads). Saves, high
// scores and resume points are keyed by the set's content either way.
async function loadSet(bytes, name, id, keep = true) {
  if (state.paused) setPaused(false);
  const { Board, roms } = identify(await extractAll(bytes));
  saveResume();                          // keep the game being left
  board = new Board(roms);
  board.applySwitches(switchValues(Board));
  board.reset();
  audio.setSource(board.sound);
  // Raster boards draw native pixels; vector boards a display list at screen resolution.
  if (board.vector) screen2d = new ScreenVector($('screen2d'), board.width, board.height);
  else if (!screen2d || screen2d.kind === 'vector' || screen2d.canvas.width !== board.width || screen2d.canvas.height !== board.height) {
    screen2d = new Screen2D($('screen2d'), board.width, board.height);
  }
  document.body.classList.toggle('vector', !!board.vector);
  // Two-way games (left/right only) get the narrow pad; the rest a 4- or 8-way d-pad.
  const twoWay = board.controls === 'two-way';
  touch.twoWay = twoWay;
  touch.eightWay = board.controls === 'eight-way';
  touch.twinStick = !!board.twinStick;
  touch.stickOnly = board.buttons === 0 && !touch.twinStick;
  touch.twoButtons = board.buttons >= 2;
  touch.threeButtons = board.buttons === 3;
  touch.dial = !!board.dialControl;
  touch.stickDial = !!board.spinner;
  touch.dialSpeed = board.dialSpeed ?? 4;     // dial counts a frame at full push
  document.body.classList.toggle('two-way', twoWay);
  document.body.classList.toggle('stick-only', touch.stickOnly);
  document.body.classList.toggle('two-buttons', touch.twoButtons);
  document.body.classList.toggle('three-buttons', touch.threeButtons);
  $('joyHintText').textContent = twoWay ? 'Drag left or right on this side'
    : touch.stickOnly ? 'Touch & drag anywhere' : 'Touch & drag on this side';
  const [dialTitle, dialText] = board.dialHint ?? ['Fire & aim', 'Hold to fire; push left or right to aim'];
  $('fireHintTitle').textContent = touch.dial ? dialTitle : touch.threeButtons ? `Fire · ${board.button2} · ${board.button3}`
    : touch.twoButtons ? `Fire · ${board.button2}` : 'Fire';
  $('fireHintText').textContent = touch.dial ? dialText
    : touch.threeButtons ? `Bottom fires, middle is ${board.button2.toLowerCase()}, top is ${board.button3.toLowerCase()}`
    : touch.twoButtons ? `Bottom half fires, top half is ${board.button2.toLowerCase()}` : 'Tap on this side';
  // The control-zone outlines' labels.
  $('stickZoneTitle').textContent = 'Move';
  $('stickZoneText').textContent = board.spinner ? 'Spinner · push' : board.analogStick ? 'Analog stick' : twoWay ? 'Left / right' : touch.eightWay ? '8-way' : '4-way';
  $('fireZoneTitle').textContent = touch.twinStick ? 'Fire' : touch.dial ? dialTitle : 'Fire';
  $('fireZoneText').textContent = touch.twinStick ? 'Drag to aim' : touch.dial ? 'Hold · push sideways' : 'Tap';
  if (touch.twinStick) {
    $('fireHintTitle').textContent = 'Fire';
    $('fireHintText').textContent = 'Drag on this side to shoot that way';
  }
  // One Start button for every game. Where each start picks a side (Silkworm's helicopter or
  // jeep, TMNT's turtles) it opens a choice of them; where each also drops that player's coin
  // (each character has a coin slot of their own), there's no Coin button.
  closeStartChooser();
  for (const id of ['start2Btn', 'start3Btn', 'start4Btn']) $(id).hidden = true;
  $('coinBtn').hidden = !!board.startsCoin;
  document.body.classList.toggle('coinless', !!board.startsCoin);
  $('fire2ZoneTitle').textContent = board.button2 || '';
  $('fire3ZoneTitle').textContent = board.button3 || '';
  renderSwitches();
  renderControls();
  layout2D();
  const res = keep ? await library.add(name, bytes, Board.title) : { id: romId(bytes), stored: false };
  if (keep && !res.stored) toast('Storage is full, so this ROM set won\'t be saved. Remove some to make room.');
  state.romId = id || res.id;
  state.serverFile = null;
  loadNvram(state.romId);
  state.resumed = restoreResume(state.romId);
  if (!state.resumed) showBooting(Board.title);
  introduceZones();
  if (res.stored) { library.setLast(state.romId); store.remove(LAST_SERVER); }
  refreshLibrary();
  return Board;
}

// Copy a set from the server's roms/ folder to the device (for offline play).
async function keepServer(file) {
  try {
    const bytes = await server.fetch(file);
    const { Board } = identify(await extractAll(bytes));
    server.learn(file, Board.title);
    const res = await library.add(file, bytes, Board.title);
    if (!res.stored) { toast('Storage is full, so this ROM set won\'t be saved. Remove some to make room.'); return; }
    if (state.serverFile === file) { state.serverFile = null; library.setLast(res.id); store.remove(LAST_SERVER); }
    toast(`${Board.title} saved to this device`, { success: true });
  } catch (err) {
    toast(`Couldn't save ${file}: ${err.message}`);
  }
  refreshLibrary();
}

// Play a set from the server's roms/ folder.
async function playServer(file) {
  try {
    await withLoading(file, async () => {
      const bytes = await server.fetch(file);
      const Board = await loadSet(bytes, file, null, false);
      server.learn(file, Board.title);
      state.serverFile = file;
      store.set(LAST_SERVER, file); store.remove('lastRomId');
      refreshLibrary();
    });
    closeMenu();
  } catch (err) {
    toast(`Couldn't load ${file}: ${err.message}`);
  }
}

function refreshLibrary() {
  renderLibrary($('library'), {
    titles: SUPPORTED,
    files: ROM_FILES,
    showAll: settings.showAll,
    currentId: state.serverFile ? null : state.romId,
    currentFile: state.serverFile,
    onAdd: () => $('romFile').click(),
    onServer: (file) => playServer(file),
    onKeep: (file) => keepServer(file),
    onPlay: (entry) => playEntry(entry),
    onRemove: (entry) => {
      library.remove(entry.id);
      // A set that's still on the server keeps its saves, and keeps running from there.
      const base = (n) => n.replace(/\.zip$/i, '').toLowerCase();
      const file = server.files.find((f) => base(f) === base(entry.name));
      if (file) {
        if (entry.id === state.romId) { state.serverFile = file; store.set(LAST_SERVER, file); }
      } else {
        store.remove(RESUME + entry.id);
        store.remove(NVRAM + entry.id);
        if (entry.id === state.romId) { board = null; state.romId = null; }
      }
      refreshLibrary();
    },
  });
  const n = library.list().length;
  const playable = server.files.filter((f) => SUPPORTED.includes(server.titleOf(f, ROM_FILES))).length;
  const served = playable ? ` · ${playable} on the server` : '';
  $('libraryInfo').textContent = n
    ? `${n} saved · ${(library.usage() / 1048576).toFixed(1)} MB on this device${served}`
    : playable ? `${playable} games on the server; add more with Add ROM set.`
      : 'Add a game\'s ROM set (the zip used by MAME) to enable it. Sets are kept on this device.';
}

async function playEntry(entry) {
  try {
    await withLoading(entry.name, async () => {
      const bytes = await library.get(entry.id);
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
  if (id === 'cartsMenu') server.refresh().then(refreshLibrary);   // pick up sets added to roms/
  if (!state.menuOpen) saveResume();
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
  padStartHeld = true;
  if (paused) { hideBooting(); closeStartChooser(); }
  // The control zones come back up to full strength while paused and fade down again on resume.
  document.body.classList.toggle('zones-intro', paused);
  $('pausedGame').textContent = board ? board.constructor.title : '';
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
  $('showAll').checked = settings.showAll;
  $('perf').checked = settings.perf;
  applySound();
  $('hapticsRow').hidden = !navigator.vibrate;
  applyControls();
  renderControls();
}

// The game's controls for a keyboard or gamepad: the card shown as a game starts and while paused,
// and the list in Settings. Touch players have the zone outlines instead.
const MODE_NAMES = { touch: 'touch', keys: 'keyboard', pad: 'gamepad' };
function renderControls() {
  const mode = inputMode.mode;
  const rows = board && mode !== 'touch' ? controlLegend(board, mode) : [];
  for (const id of ['keyHelpList', 'controlList']) {
    const dl = $(id);
    dl.textContent = '';
    for (const [keys, what] of rows) {
      dl.append(Object.assign(document.createElement('dt'), { textContent: keys }), Object.assign(document.createElement('dd'), { textContent: what }));
    }
  }
  for (const b of $('hintsFor').children) b.classList.toggle('active', b.dataset.mode === settings.hintsFor);
  $('hintsForInfo').textContent = settings.hintsFor === 'auto'
    ? `Showing ${MODE_NAMES[mode]} hints: Auto follows whichever you last used.`
    : `Always showing ${MODE_NAMES[mode]} hints.`;
  if (!board && mode !== 'touch') $('hintsForInfo').textContent += ' Load a game to see its controls.';
}
$('hintsFor').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.hintsFor = b.dataset.mode; save();
  inputMode.override = settings.hintsFor;
  renderControls();
});

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
$('showAll').addEventListener('change', (e) => { settings.showAll = e.target.checked; save(); refreshLibrary(); });
$('perf').addEventListener('change', (e) => { settings.perf = e.target.checked; save(); perf.reset(); });
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

// Booting: a card naming the game while it starts from power-on; it fades after 3 seconds, or on a tap.
let bootTimer = 0;
function showBooting(title) {
  $('bootingGame').textContent = title;
  const el = $('booting');
  el.hidden = true; void el.offsetWidth; el.hidden = false;      // restart the fade
  clearTimeout(bootTimer);
  bootTimer = setTimeout(hideBooting, 3000);
}
function hideBooting() { clearTimeout(bootTimer); $('booting').hidden = true; }
$('booting').addEventListener('pointerdown', hideBooting);

// The start chooser (games with a start per player or side): picking one presses that start.
function openStartChooser() {
  const labels = board.startLabels, list = $('startChoices');
  list.replaceChildren(...labels.map((label, i) => {
    const b = document.createElement('button');
    b.className = 'pill';
    b.textContent = label;
    b.addEventListener('pointerup', (e) => { e.preventDefault(); e.stopPropagation(); chooseStart(i); });
    b.addEventListener('click', (e) => { if (e.detail === 0) chooseStart(i); });   // keyboard
    return b;
  }));
  $('startChooserTitle').textContent = board.startsCoin ? 'Who\'s playing?' : 'Start as';
  $('startChooser').hidden = false;
  touch.releaseAll();
  touch.enabled = false;
  list.firstChild?.focus();
}
function closeStartChooser() {
  if ($('startChooser').hidden) return;
  $('startChooser').hidden = true;
  touch.enabled = !state.paused && !state.menuOpen;
}
function chooseStart(i) {
  const key = i ? `uiStart${i + 1}` : 'uiStart';
  closeStartChooser();
  input[key] = true;
  setTimeout(() => { input[key] = false; }, Math.max(MIN_BUTTON_MS, 200));
}
// A tap on the backdrop closes it (only one that starts there: the tap that opened it ends here too).
let chooserDown = false;
$('startChooser').addEventListener('pointerdown', (e) => { chooserDown = e.target === e.currentTarget; });
$('startChooser').addEventListener('pointerup', (e) => { if (chooserDown && e.target === e.currentTarget) closeStartChooser(); chooserDown = false; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeStartChooser(); });

// Coin and Start: held while pressed, but never shorter than a few frames.
function holdButton(el, key) {
  let downAt = 0, timer = 0;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (key === 'uiStart' && board?.startLabels) { openStartChooser(); return; }
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
holdButton($('start2Btn'), 'uiStart2');
holdButton($('start3Btn'), 'uiStart3');
holdButton($('start4Btn'), 'uiStart4');

// When a game loads, the control zones show at full strength over a dark backing; the
// first touch (or key / gamepad press) fades them to the chosen opacity and the backing away.
function introduceZones() { document.body.classList.add('zones-intro'); }

// The touch-zone hints and the zone introduction fade once the player starts playing,
// whether by touch, mouse, keyboard or gamepad.
function dismissHints() {
  document.body.classList.remove('zones-intro');
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
  const aspect = board ? board.aspect ?? board.width / board.height : 3 / 4;   // boards with non-square pixels set aspect
  const barH = $('bar').offsetHeight;
  const availW = W - sl - sr - pad * 2;
  const portrait = H > W;
  // Portrait sits below the bar and keeps the lower part of the screen free for
  // thumbs. Landscape uses the full height, running up behind the bar.
  // Two- and three-button games give the picture a little less room in
  // portrait, so the stacked buttons below it are each a comfortable size.
  const share = touch.threeButtons ? 0.6 : touch.twoButtons ? 0.65 : 0.7;
  const availH = portrait ? (H - barH - sb) * share : H - st - sb;
  const w = Math.max(80, Math.min(availW, availH * aspect));
  const h = w / aspect;
  const top = portrait ? barH + 4 : st + (availH - h) / 2;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  if (screen2d && screen2d.resize) screen2d.resize(w, h);
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
    if (touch.threeButtons) {
      // Thirds of the band: the third button on top, the second in the middle.
      const t1 = band + (sr.bottom - band) / 3, t2 = band + (sr.bottom - band) * 2 / 3;
      touch.fire3Area = { left: fireLeft, right: fireRight, top: band, bottom: t1 };
      touch.fire2Area = { left: fireLeft, right: fireRight, top: t1, bottom: t2 };
      style.setProperty('--split3', `${t1 - sr.top}px`);
      style.setProperty('--split', `${t2 - sr.top}px`);
    }
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
    if (touch.threeButtons) {
      const l = touch.fire2Area.left, r = touch.fire2Area.right, t1 = sr.top + sr.height / 3, t2 = sr.top + sr.height * 2 / 3;
      touch.fire3Area = { left: l, right: r, top: sr.top, bottom: t1 };
      touch.fire2Area = { left: l, right: r, top: t1, bottom: t2 };
      style.setProperty('--split3', `${sr.height / 3}px`);
      style.setProperty('--split', `${sr.height * 2 / 3}px`);
    }
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

// The performance readout: emulated frames a second against the game's own rate, the
// time each emulated frame takes, screen updates a second and the time to draw one, and
// frames dropped because the device fell more than 4 frames behind.
const perf = {
  frames: 0, emuMs: 0, worstMs: 0, draws: 0, drawMs: 0, dropped: 0, since: performance.now(),
  reset() { this.frames = this.emuMs = this.worstMs = this.draws = this.drawMs = this.dropped = 0; this.since = performance.now(); $('perfStats').hidden = !settings.perf; },
  show(now, running) {
    const el = $('perfStats');
    if (!settings.perf || !running) { el.hidden = true; this.frames = this.emuMs = this.worstMs = this.draws = this.drawMs = this.dropped = 0; this.since = now; return; }
    if (now - this.since < 1000) return;
    const secs = (now - this.since) / 1000, rate = this.frames / secs, target = board.refresh;
    const avg = this.frames ? this.emuMs / this.frames : 0;
    el.hidden = false;
    el.className = rate < target * 0.97 ? 'slow' : '';
    el.textContent = `speed ${Math.round((100 * rate) / target)}%  ${rate.toFixed(1)}/${target.toFixed(1)} fps\n`
      + `emu ${avg.toFixed(1)} ms/frame (worst ${this.worstMs.toFixed(1)}, budget ${(1000 / target).toFixed(1)})\n`
      + `screen ${(this.draws / secs).toFixed(0)} fps, draw ${(this.draws ? this.drawMs / this.draws : 0).toFixed(1)} ms${this.dropped ? `  dropped ${this.dropped}` : ''}`;
    this.frames = this.emuMs = this.worstMs = this.draws = this.drawMs = this.dropped = 0; this.since = now;
  },
};

// A gamepad's Start button resumes a paused game (once it's been let go of since the pause).
let padStartHeld = true;
function resumeFromPad() {
  const pad = navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null;
  const down = !!(pad && pad.buttons[9] && pad.buttons[9].pressed);
  if (down && !padStartHeld) { setPaused(false); input.padStartHeld = true; }
  padStartHeld = down;
}

let acc = 0, lastTime = performance.now();
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
      if (board.buttons < 3) s.fire2 ||= s.fire3;   // a third button is the second's job here
      if (board.buttons < 2) s.fire ||= s.fire2;    // a second button is just fire here
      board.setInputs(s);
      if (settings.perf) {
        const t0 = performance.now();
        board.runFrame();
        const ms = performance.now() - t0;
        perf.frames++; perf.emuMs += ms; if (ms > perf.worstMs) perf.worstMs = ms;
      } else board.runFrame();
      acc -= frameTime;
      ran++;
    }
    if (ran === 4) { if (settings.perf) perf.dropped += Math.floor(acc / frameTime); acc = 0; }
    audio.flush();
    if (ran) {
      if (settings.perf) { const t0 = performance.now(); screen2d.draw(board.frame, board); perf.drawMs += performance.now() - t0; perf.draws++; }
      else screen2d.draw(board.frame, board);
    }
  } else {
    acc = 0;
    if (state.paused && !state.menuOpen) resumeFromPad();
  }
  perf.show(now, running);

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- boot

(async () => {
  syncMenu();
  audio.setMuted(!settings.sound);
  refreshLibrary();
  await server.refresh();
  refreshLibrary();
  const lastId = library.lastId();
  const last = lastId ? library.entry(lastId) : null;
  const bytes = last && await library.get(last.id);
  const lastFile = !bytes && store.get(LAST_SERVER);
  if (bytes) {
    try {
      await withLoading(last.name, () => loadSet(bytes, last.name, last.id));
    } catch (err) {
      toast(`Couldn't load ${last.name}: ${err.message}`);
    }
  } else if (lastFile && server.files.includes(lastFile)) {
    await playServer(lastFile);
  } else {
    $('loading').classList.remove('show');
  }
  if (!board) openSheet('cartsMenu');   // first run: ask for a ROM set
  else if (state.resumed) {
    // A reload resumes paused, so play starts when the player is ready; one
    // frame shows where the game was left.
    setPaused(true);
    board.runFrame();
    screen2d.draw(board.frame, board);
  }
  layout2D();
  flashHints(0);
  requestAnimationFrame(tick);
})();

window.touch = touch;
window.input = input;
window.audio = audio;
Object.defineProperty(window, 'board', { get: () => board });

// Offline support: the service worker (sw.js, written by tools/build-sw.mjs)
// caches the app so it runs without a network once installed, and a new
// version shows an update screen while it installs. Browsers only allow it on
// https or localhost.
registerServiceWorker('z80js');
