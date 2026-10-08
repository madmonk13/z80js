// Gesture controls: the screen is split into a joystick half and a fire half.
//
// Joystick half: a d-pad appears wherever the finger lands. Direction comes
// from the finger's angle around that origin, even past the d-pad's rim, so
// direction changes register without returning to center.
//
// Fire half: every touch presses fire. Each press is held for at least
// MIN_PRESS so a quick tap is never shorter than a frame the game polls.
// Two-button games split it: the top half is the second button. Dial games
// (Tron) also turn the dial by the finger's sideways movement while it's down.

const UP = 0x10, DOWN = 0x20, LEFT = 0x40, RIGHT = 0x80;
const MIN_PRESS = 70;     // ms
const DEADZONE = 0.22;    // fraction of the d-pad radius
const DIAL_PX = 4;        // finger movement (px) per dial count

// Sector index (0 = right, counting clockwise in screen space) → SWCHA bits.
const DIR8 = [RIGHT, RIGHT | DOWN, DOWN, DOWN | LEFT, LEFT, LEFT | UP, UP, UP | RIGHT];

export class TouchControls {
  constructor({ surface, dpad, ripples, buttons = [] }) {
    this.surface = surface;
    this.buttons = buttons;   // on-screen buttons the stick and fire must never steal from
    this.dpad = dpad;
    this.knob = dpad.querySelector('.knob');
    this.ripples = ripples;
    this.leftHanded = false;
    this.eightWay = true;
    this.twoWay = false;      // left/right only (e.g. Galaga's fighter)
    this.stickOnly = false;   // no fire button (e.g. Pac-Man): the whole surface is the stick
    this.twoButtons = false;  // top of the fire half is a second button (e.g. Satan's Hollow's shield)
    this.dial = false;        // dragging on the fire half turns a dial (Tron)
    this.size = 140;
    this.haptics = true;
    this.onTouch = null;      // called on every touch start (audio unlock, hints)
    this.enabled = true;      // false while the settings screen is open

    this.joy = null;          // { id, ox, oy, dir }
    this.fireIds = new Set();
    this.fireUntil = 0;
    this.fire2Ids = new Set();
    this.fire2Until = 0;
    this.dialX = new Map();   // pointerId → last x, for dial touches
    this.spinAcc = 0;
    this.forwarded = new Map(); // pointerId → button it was handed to

    surface.addEventListener('pointerdown', (e) => this.down(e));
    surface.addEventListener('pointermove', (e) => this.move(e));
    surface.addEventListener('pointerup', (e) => this.up(e));
    surface.addEventListener('pointercancel', (e) => this.up(e));
    surface.addEventListener('lostpointercapture', (e) => this.up(e));
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Input source interface (see Input.sources).
  dir() { return this.joy ? this.joy.dir : 0; }
  fire() { return this.fireIds.size > 0 || performance.now() < this.fireUntil; }
  fire2() { return this.fire2Ids.size > 0 || performance.now() < this.fire2Until; }
  spin() {
    const n = Math.trunc(this.spinAcc / DIAL_PX);
    this.spinAcc -= n * DIAL_PX;
    return n;
  }

  setSize(px) {
    this.size = px;
    this.dpad.style.setProperty('--size', `${px}px`);
  }

  isJoystickSide(x) {
    if (this.stickOnly) return true;
    const leftHalf = x < this.surface.clientWidth / 2;
    return this.leftHanded ? !leftHalf : leftHalf;
  }

  // The button under a point, judged by where the buttons are laid out now.
  // iOS can hit-test against a stale layout after rotating, so a touch on a
  // button may arrive here instead; it gets handed back to that button.
  buttonAt(x, y) {
    return this.buttons.find((b) => {
      const r = b.getBoundingClientRect();
      return r.width && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    });
  }

  down(e) {
    e.preventDefault();
    if (!this.enabled) return;
    const button = this.buttonAt(e.clientX, e.clientY);
    if (button) {
      this.forwarded.set(e.pointerId, button);
      try { this.surface.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      button.dispatchEvent(new PointerEvent('pointerdown', e));
      return;
    }
    if (this.onTouch) this.onTouch(e);
    try { this.surface.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    if (this.isJoystickSide(e.clientX)) {
      if (this.joy) return; // one finger drives the stick; extra fingers are ignored
      this.joy = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dir: 0 };
      this.dpad.style.left = `${e.clientX}px`;
      this.dpad.style.top = `${e.clientY}px`;
      this.knob.style.transform = 'translate(-50%, -50%)';
      this.dpad.className = 'show';
    } else if (this.twoButtons && e.clientY < this.surface.getBoundingClientRect().top + this.surface.clientHeight / 2) {
      this.fire2Ids.add(e.pointerId);
      this.fire2Until = performance.now() + MIN_PRESS;
      this.ripple(e.clientX, e.clientY);
      if (this.haptics && navigator.vibrate) navigator.vibrate(8);
    } else {
      this.fireIds.add(e.pointerId);
      this.fireUntil = performance.now() + MIN_PRESS;
      if (this.dial) this.dialX.set(e.pointerId, e.clientX);
      this.ripple(e.clientX, e.clientY);
      if (this.haptics && navigator.vibrate) navigator.vibrate(8);
    }
  }

  move(e) {
    if (this.dialX.has(e.pointerId)) {
      e.preventDefault();
      this.spinAcc += e.clientX - this.dialX.get(e.pointerId);
      this.dialX.set(e.pointerId, e.clientX);
      return;
    }
    const j = this.joy;
    if (!j || e.pointerId !== j.id) return;
    e.preventDefault();
    const dx = e.clientX - j.ox, dy = e.clientY - j.oy;
    const r = this.size / 2;
    if (this.twoWay) {
      // Two-way pad: only the horizontal offset counts, past the dead zone.
      const x = Math.max(-r, Math.min(r, dx));
      j.dir = Math.abs(dx) < r * DEADZONE ? 0 : dx < 0 ? LEFT : RIGHT;
      this.knob.style.transform = `translate(calc(-50% + ${x}px), -50%)`;
      this.showDir(j.dir);
      return;
    }
    const dist = Math.hypot(dx, dy);
    j.dir = dist < r * DEADZONE ? 0 : this.direction(dx, dy);
    // Past the rim the direction still follows the finger's angle; the knob pins to the edge.
    const k = Math.min(1, r / dist);
    this.knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
    this.showDir(j.dir);
  }

  up(e) {
    const button = this.forwarded.get(e.pointerId);
    if (button) {
      this.forwarded.delete(e.pointerId);
      // Only a real release counts as a tap; a cancel still lets go of the button.
      button.dispatchEvent(new PointerEvent(e.type === 'pointerup' ? 'pointerup' : 'pointercancel', e));
      return;
    }
    if (this.joy && e.pointerId === this.joy.id) {
      this.joy = null;
      this.dpad.className = '';
    }
    this.fireIds.delete(e.pointerId);
    this.fire2Ids.delete(e.pointerId);
    this.dialX.delete(e.pointerId);
  }

  direction(dx, dy) {
    const a = Math.atan2(dy, dx);
    if (this.eightWay) return DIR8[(Math.round(a / (Math.PI / 4)) + 8) % 8];
    return DIR8[((Math.round(a / (Math.PI / 2)) + 4) % 4) * 2];
  }

  showDir(d) {
    let c = 'show';
    if (d & UP) c += ' up';
    if (d & DOWN) c += ' down';
    if (d & LEFT) c += ' left';
    if (d & RIGHT) c += ' right';
    if (this.dpad.className !== c) this.dpad.className = c;
  }

  ripple(x, y) {
    const el = document.createElement('div');
    el.className = 'ripple';
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.addEventListener('animationend', () => el.remove());
    this.ripples.appendChild(el);
  }

  // Release everything (e.g. when a menu opens over the controls).
  releaseAll() {
    this.joy = null;
    this.forwarded.clear();
    this.fireIds.clear();
    this.fireUntil = 0;
    this.fire2Ids.clear();
    this.fire2Until = 0;
    this.dialX.clear();
    this.spinAcc = 0;
    this.dpad.className = '';
  }
}
