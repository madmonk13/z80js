// Keyboard, gamepad and touch -> the controls a board reads (left, right, up,
// down, fire, coin, start).
//
// Keys: arrows / WASD to move, Space / Z to fire, X / Shift for a second
// button (also fire in one-button games), F for a third (or the second's job in
// two-button games), Q / E (or the mouse wheel) to turn
// a dial, I / J / K / L to aim in twin-stick games (Robotron), H for
// hyperspace and V for inviso (Defender, Stargate), 5 or C for a
// coin, 1 or Return to start (2-4 for the other starts, in games that name them).

const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const UP = new Set(['ArrowUp', 'KeyW']);
const DOWN = new Set(['ArrowDown', 'KeyS']);
const FIRE = new Set(['Space', 'KeyZ']);
const FIRE2 = new Set(['KeyX', 'ShiftLeft', 'ShiftRight']);
const FIRE3 = new Set(['KeyF']);                     // a third button, where a game has one
const SPIN_LEFT = new Set(['KeyQ']);
const SPIN_RIGHT = new Set(['KeyE']);
const KEY_SPIN = 3;           // dial counts per frame while Q / E is held
const HYPER = new Set(['KeyH']), INVISO = new Set(['KeyV']);   // Defender / Stargate extras
const AIM_UP = new Set(['KeyI']), AIM_DOWN = new Set(['KeyK']), AIM_LEFT = new Set(['KeyJ']), AIM_RIGHT = new Set(['KeyL']);
const COIN = new Set(['Digit5', 'KeyC', 'Tab']);
const START1 = new Set(['Digit1', 'Enter', 'NumpadEnter']);
const START2 = new Set(['Digit2']);
const START3 = new Set(['Digit3']);
const START4 = new Set(['Digit4']);
const GAME_KEYS = new Set([...LEFT, ...RIGHT, ...UP, ...DOWN, ...FIRE, ...FIRE2, ...FIRE3, ...SPIN_LEFT, ...SPIN_RIGHT, ...AIM_UP, ...AIM_DOWN, ...AIM_LEFT, ...AIM_RIGHT, ...HYPER, ...INVISO, ...COIN, ...START1, ...START2, ...START3, ...START4]);

export class Input {
  constructor() {
    this.keys = new Set();
    this.uiCoin = false;      // on-screen Coin / Start buttons
    this.uiStart = false;
    this.uiStart2 = false;
    this.uiStart3 = false;
    this.uiStart4 = false;
    this.onActivity = null;   // called on keyboard or gamepad input
    this.padStartHeld = false; // the gamepad's Start resumed the game: not a Start for it until let go
    // Extra sources (touch controls): objects with dir() -> 0x10 up / 0x20 down
    // / 0x40 left / 0x80 right bits, fire() and fire2() -> bool, spin() ->
    // dial counts turned since the last call, and optionally aim() -> the
    // second stick's direction bits and analog() -> { x, y } (-1..1) or null.
    this.sources = [];
    window.addEventListener('keydown', (e) => {
      if (!GAME_KEYS.has(e.code) || e.metaKey || e.ctrlKey || e.altKey) return;
      // While a full-screen sheet is open, keys belong to its controls.
      if (document.querySelector('.sheet-backdrop:not([hidden])')) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'BUTTON')) t.blur();
      e.preventDefault();
      this.keys.add(e.code);
      if (this.onActivity) this.onActivity();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    this.wheel = 0;
    window.addEventListener('wheel', (e) => {
      if (!document.querySelector('.sheet-backdrop:not([hidden])')) this.wheel += e.deltaY / 8;
    }, { passive: true });
    window.addEventListener('blur', () => this.keys.clear());
  }

  // Read everything into one control state for the board.
  read() {
    const k = this.keys, any = (set) => [...set].some((c) => k.has(c));
    let left = any(LEFT), right = any(RIGHT), up = any(UP), down = any(DOWN), fire = any(FIRE), fire2 = any(FIRE2), fire3 = any(FIRE3);
    let spin = (any(SPIN_RIGHT) ? KEY_SPIN : 0) - (any(SPIN_LEFT) ? KEY_SPIN : 0) + this.wheel;
    this.wheel = 0;
    let coin = this.uiCoin || any(COIN), start1 = this.uiStart || any(START1), start2 = this.uiStart2 || any(START2);
    const start3 = this.uiStart3 || any(START3), start4 = this.uiStart4 || any(START4);
    const aim = { up: any(AIM_UP), down: any(AIM_DOWN), left: any(AIM_LEFT), right: any(AIM_RIGHT) };
    let hyper = any(HYPER), inviso = any(INVISO);
    let analog = null;          // { x, y } in -1..1 when a source has a real stick position

    for (const src of this.sources) {
      const d = src.dir();
      up ||= !!(d & 0x10);
      down ||= !!(d & 0x20);
      left ||= !!(d & 0x40);
      right ||= !!(d & 0x80);
      fire ||= src.fire();
      fire2 ||= src.fire2();
      fire3 ||= src.fire3 ? src.fire3() : false;
      spin += src.spin();
      const a = src.aim ? src.aim() : 0;
      aim.up ||= !!(a & 0x10); aim.down ||= !!(a & 0x20); aim.left ||= !!(a & 0x40); aim.right ||= !!(a & 0x80);
      const an = src.analog ? src.analog() : null;
      if (an) analog = an;
    }

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const b = (i) => pad.buttons[i] && pad.buttons[i].pressed;
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      const pl = ax < -0.5 || b(14), pr = ax > 0.5 || b(15), pu = ay < -0.5 || b(12), pd = ay > 0.5 || b(13);
      const pf = b(0) || b(2), pf2 = b(1), pf3 = b(3);
      left ||= pl; right ||= pr; up ||= pu; down ||= pd; fire ||= pf; fire2 ||= pf2; fire3 ||= pf3;
      if (!analog && Math.hypot(ax, ay) > 0.15) analog = { x: ax, y: ay };
      // The right stick aims in twin-stick games.
      const rx = pad.axes[2] || 0, ry = pad.axes[3] || 0;
      aim.left ||= rx < -0.5; aim.right ||= rx > 0.5; aim.up ||= ry < -0.5; aim.down ||= ry > 0.5;
      hyper ||= b(6); inviso ||= b(7);                 // the triggers
      if (b(4)) spin -= KEY_SPIN;  // shoulder buttons turn a dial
      if (b(5)) spin += KEY_SPIN;
      if (b(8)) coin = true;      // Back / Select
      if (b(9) && !this.padStartHeld) start1 = true;    // Start (not the press that just resumed from a pause)
      if (!b(9)) this.padStartHeld = false;
      if (this.onActivity && (pl || pr || pu || pd || pf || pf2 || pf3 || b(8) || b(9))) this.onActivity();
      break;                      // one player
    }

    return { left, right, up, down, fire, fire2, fire3, spin, coin, start1, start2, start3, start4, aim, hyper, inviso, analog };
  }
}

// The controls a board uses, as [keys, what they do] rows for the keyboard or
// gamepad hints (mode 'keys' or 'pad'). Built from the board's control layout,
// the same one the touch zones use, so each game gets its own list.
export function controlLegend(board, mode) {
  const keys = mode === 'keys', rows = [];
  const twoWay = board.controls === 'two-way';
  const moveName = board.moveName ?? 'Move';
  const dialMoves = board.dialControl && board.dialName === moveName;   // the dial moves too (Kick): one row
  if (board.spinner) rows.push([keys ? '← →  ·  Q E  ·  wheel' : 'LB RB  ·  left stick', 'Spinner']);
  else rows.push([keys ? (twoWay ? '← →  or  A D' : 'Arrows  or  W A S D') : (twoWay ? 'D-pad  ·  left stick (left / right)' : 'D-pad  ·  left stick'), moveName]);
  if (dialMoves) rows[0][0] += keys ? '  ·  Q E  ·  wheel' : '  ·  LB RB';
  if (board.twinStick) rows.push([keys ? 'I J K L' : 'Right stick', board.aimName ?? 'Fire (aim)']);
  if (board.buttons >= 1) rows.push([keys ? 'Space  or  Z' : 'A', board.fireName ?? 'Fire']);
  if (board.dialControl && !dialMoves) rows.push([keys ? 'Q E  ·  wheel' : 'LB RB', board.dialName ?? 'Aim']);
  if (board.buttons >= 2) rows.push([keys ? 'X  or  Shift' : 'B', board.button2]);
  if (board.buttons >= 3) rows.push([keys ? 'F' : 'Y', board.button3]);
  for (const extra of board.extraControls || []) {
    if (extra === 'hyper') rows.push([keys ? 'H' : 'LT', board.hyperName ?? 'Hyperspace']);
    if (extra === 'inviso') rows.push([keys ? 'V' : 'RT', 'Inviso']);
  }
  if (!board.startsCoin) rows.push([keys ? '5  or  C' : 'Select', 'Coin']);
  const start = board.startsCoin ? 'Coin & start' : 'Start';    // each start drops that player's coin too
  if (board.startLabels && keys) rows.push([board.startLabels.map((_, i) => i + 1).join(' '), `${start}: ${board.startLabels.join(' · ')}`]);
  else rows.push([keys ? '1  or  Return' : 'Start', start]);
  if (keys) rows.push(['P', 'Pause']);
  return rows;
}
