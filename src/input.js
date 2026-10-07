// Keyboard, gamepad and touch -> the controls a board reads (left, right, up,
// down, fire, coin, start).
//
// Keys: arrows / WASD to move, Space / Z / X to fire, 5 or C for a coin,
// 1 or Return to start (2 for a two-player start).

const LEFT = new Set(['ArrowLeft', 'KeyA']);
const RIGHT = new Set(['ArrowRight', 'KeyD']);
const UP = new Set(['ArrowUp', 'KeyW']);
const DOWN = new Set(['ArrowDown', 'KeyS']);
const FIRE = new Set(['Space', 'KeyZ', 'KeyX']);
const COIN = new Set(['Digit5', 'KeyC', 'Tab']);
const START1 = new Set(['Digit1', 'Enter', 'NumpadEnter']);
const START2 = new Set(['Digit2']);
const GAME_KEYS = new Set([...LEFT, ...RIGHT, ...UP, ...DOWN, ...FIRE, ...COIN, ...START1, ...START2]);

export class Input {
  constructor() {
    this.keys = new Set();
    this.uiCoin = false;      // on-screen Coin / Start buttons
    this.uiStart = false;
    this.onActivity = null;   // called on keyboard or gamepad input
    // Extra sources (touch controls): objects with dir() -> 0x10 up / 0x20 down
    // / 0x40 left / 0x80 right bits and fire() -> bool.
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
    window.addEventListener('blur', () => this.keys.clear());
  }

  // Read everything into one control state for the board.
  read() {
    const k = this.keys, any = (set) => [...set].some((c) => k.has(c));
    let left = any(LEFT), right = any(RIGHT), up = any(UP), down = any(DOWN), fire = any(FIRE);
    let coin = this.uiCoin || any(COIN), start1 = this.uiStart || any(START1), start2 = any(START2);

    for (const src of this.sources) {
      const d = src.dir();
      up ||= !!(d & 0x10);
      down ||= !!(d & 0x20);
      left ||= !!(d & 0x40);
      right ||= !!(d & 0x80);
      fire ||= src.fire();
    }

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const b = (i) => pad.buttons[i] && pad.buttons[i].pressed;
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      const pl = ax < -0.5 || b(14), pr = ax > 0.5 || b(15), pu = ay < -0.5 || b(12), pd = ay > 0.5 || b(13);
      const pf = b(0) || b(1) || b(2) || b(3);
      left ||= pl; right ||= pr; up ||= pu; down ||= pd; fire ||= pf;
      if (b(8)) coin = true;      // Back / Select
      if (b(9)) start1 = true;    // Start
      if (this.onActivity && (pl || pr || pu || pd || pf || b(8) || b(9))) this.onActivity();
      break;                      // one player
    }

    return { left, right, up, down, fire, coin, start1, start2 };
  }
}
