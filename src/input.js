// Keyboard, gamepad and touch -> the controls a board reads (left, right, up,
// down, fire, coin, start).
//
// Keys: arrows / WASD to move, Space / Z to fire, X / Shift for a second
// button (also fire in one-button games), Q / E (or the mouse wheel) to turn
// a dial, I / J / K / L to aim in twin-stick games (Robotron), H for
// hyperspace and V for inviso (Defender, Stargate), 5 or C for a
// coin, 1 or Return to start (2 for a two-player start).

const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const UP = new Set(['ArrowUp', 'KeyW']);
const DOWN = new Set(['ArrowDown', 'KeyS']);
const FIRE = new Set(['Space', 'KeyZ']);
const FIRE2 = new Set(['KeyX', 'ShiftLeft', 'ShiftRight']);
const SPIN_LEFT = new Set(['KeyQ']);
const SPIN_RIGHT = new Set(['KeyE']);
const KEY_SPIN = 3;           // dial counts per frame while Q / E is held
const HYPER = new Set(['KeyH']), INVISO = new Set(['KeyV']);   // Defender / Stargate extras
const AIM_UP = new Set(['KeyI']), AIM_DOWN = new Set(['KeyK']), AIM_LEFT = new Set(['KeyJ']), AIM_RIGHT = new Set(['KeyL']);
const COIN = new Set(['Digit5', 'KeyC', 'Tab']);
const START1 = new Set(['Digit1', 'Enter', 'NumpadEnter']);
const START2 = new Set(['Digit2']);
const GAME_KEYS = new Set([...LEFT, ...RIGHT, ...UP, ...DOWN, ...FIRE, ...FIRE2, ...SPIN_LEFT, ...SPIN_RIGHT, ...AIM_UP, ...AIM_DOWN, ...AIM_LEFT, ...AIM_RIGHT, ...HYPER, ...INVISO, ...COIN, ...START1, ...START2]);

export class Input {
  constructor() {
    this.keys = new Set();
    this.uiCoin = false;      // on-screen Coin / Start buttons
    this.uiStart = false;
    this.onActivity = null;   // called on keyboard or gamepad input
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
    let left = any(LEFT), right = any(RIGHT), up = any(UP), down = any(DOWN), fire = any(FIRE), fire2 = any(FIRE2);
    let spin = (any(SPIN_RIGHT) ? KEY_SPIN : 0) - (any(SPIN_LEFT) ? KEY_SPIN : 0) + this.wheel;
    this.wheel = 0;
    let coin = this.uiCoin || any(COIN), start1 = this.uiStart || any(START1), start2 = any(START2);
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
      const pf = b(0) || b(2), pf2 = b(1) || b(3);
      left ||= pl; right ||= pr; up ||= pu; down ||= pd; fire ||= pf; fire2 ||= pf2;
      if (!analog && Math.hypot(ax, ay) > 0.15) analog = { x: ax, y: ay };
      // The right stick aims in twin-stick games.
      const rx = pad.axes[2] || 0, ry = pad.axes[3] || 0;
      aim.left ||= rx < -0.5; aim.right ||= rx > 0.5; aim.up ||= ry < -0.5; aim.down ||= ry > 0.5;
      hyper ||= b(6); inviso ||= b(7);                 // the triggers
      if (b(4)) spin -= KEY_SPIN;  // shoulder buttons turn a dial
      if (b(5)) spin += KEY_SPIN;
      if (b(8)) coin = true;      // Back / Select
      if (b(9)) start1 = true;    // Start
      if (this.onActivity && (pl || pr || pu || pd || pf || pf2 || b(8) || b(9))) this.onActivity();
      break;                      // one player
    }

    return { left, right, up, down, fire, fire2, spin, coin, start1, start2, aim, hyper, inviso, analog };
  }
}
