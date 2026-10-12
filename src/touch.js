// Gesture controls: the screen is split into a joystick half and a fire half.
//
// Joystick half: a d-pad appears wherever the finger lands. Direction comes
// from the finger's angle around that origin, even past the d-pad's rim, so
// direction changes register without returning to center.
//
// Fire half: every touch presses fire. Each press is held for at least
// MIN_PRESS so a quick tap is never shorter than a frame the game polls.
// Two-button games split it: the upper half of the fire side's zone is the
// second button (the zones keep mostly clear of the picture; see main.js layoutZones).
// Dial games turn their dial with a left/right pad, like 6502js's paddles: how
// far the finger is pushed sets how fast it turns. Tron's and Kick's pad is
// on the fire half (holding it also fires); Tempest's spinner is the stick half.
// Twin-stick games (Robotron) make the fire half a second stick that aims.

const UP = 0x10, DOWN = 0x20, LEFT = 0x40, RIGHT = 0x80;
const MIN_PRESS = 70;     // ms
const DEADZONE = 0.22;    // fraction of the d-pad radius

// Sector index (0 = right, counting clockwise in screen space) → SWCHA bits.
const DIR8 = [RIGHT, RIGHT | DOWN, DOWN, DOWN | LEFT, LEFT, LEFT | UP, UP, UP | RIGHT];

export class TouchControls {
  constructor({ surface, dpad, aimPad = null, ripples, buttons = [] }) {
    this.surface = surface;
    this.buttons = buttons;   // on-screen buttons the stick and fire must never steal from
    this.dpad = dpad;
    this.knob = dpad.querySelector('.knob');
    this.aimPad = aimPad;     // the second stick, for twin-stick games
    this.aimKnob = aimPad && aimPad.querySelector('.knob');
    this.twinStick = false;   // the fire half is a second stick that aims (Robotron)
    this.aimJoy = null;       // { id, ox, oy, dir }
    this.ripples = ripples;
    this.leftHanded = false;
    this.eightWay = true;
    this.twoWay = false;      // left/right only (e.g. Galaga's fighter)
    this.stickOnly = false;   // no fire button (e.g. Pac-Man): the whole surface is the stick
    this.twoButtons = false;  // top of the fire half is a second button (e.g. Satan's Hollow's shield)
    this.dial = false;        // the fire half is also a dial pad (Tron, Kick)
    this.stickDial = false;   // the stick half is a dial pad (Tempest's spinner)
    this.dialSpeed = 4;       // dial counts per frame with the pad pushed to its rim
    this.fire2Area = null;    // { left, right, top, bottom } in client px, set by the page layout
    this.size = 140;
    this.haptics = true;
    this.onTouch = null;      // called on every touch start (audio unlock, hints)
    this.enabled = true;      // false while the settings screen is open

    this.joy = null;          // { id, ox, oy, dir }
    this.fireIds = new Set();
    this.fireUntil = 0;
    this.fire2Ids = new Set();
    this.fire2Until = 0;
    this.spinAcc = 0;         // fractional dial counts carried between frames
    this.forwarded = new Map(); // pointerId → button it was handed to

    surface.addEventListener('pointerdown', (e) => this.down(e));
    surface.addEventListener('pointermove', (e) => this.move(e));
    surface.addEventListener('pointerup', (e) => this.up(e));
    surface.addEventListener('pointercancel', (e) => this.up(e));
    surface.addEventListener('lostpointercapture', (e) => this.up(e));
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Input source interface (see Input.sources).
  dir() { return this.joy && !this.joy.dial ? this.joy.dir : 0; }
  aim() { return this.aimJoy && !this.aimJoy.dial ? this.aimJoy.dir : 0; }
  // The stick's offset as a position (-1..1 at the rim), for analog games.
  analog() { return this.joy ? { x: this.joy.ax || 0, y: this.joy.ay || 0 } : null; }
  fire() { return this.fireIds.size > 0 || performance.now() < this.fireUntil; }
  fire2() { return this.fire2Ids.size > 0 || performance.now() < this.fire2Until; }
  // Dial counts this frame (called once a frame): the dial pads' push, at
  // dialSpeed counts a frame for a pad pushed to its rim.
  spin() {
    const rate = (this.joy && this.joy.dial ? this.joy.vel : 0) + (this.aimJoy && this.aimJoy.dial ? this.aimJoy.vel : 0);
    this.spinAcc += rate * this.dialSpeed;
    const n = Math.trunc(this.spinAcc);
    this.spinAcc -= n;
    return n;
  }

  setSize(px) {
    this.size = px;
    this.dpad.style.setProperty('--size', `${px}px`);
    if (this.aimPad) this.aimPad.style.setProperty('--size', `${px}px`);
  }

  // The second button's area: given by the layout, else the fire side's top half.
  inFire2(x, y) {
    const a = this.fire2Area;
    if (a) return x >= a.left && x < a.right && y >= a.top && y < a.bottom;
    const r = this.surface.getBoundingClientRect();
    return y < r.top + r.height / 2;
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
      this.joy = this.grab(e, this.dpad, this.knob, this.stickDial);
    } else if (this.twinStick && this.aimPad) {
      if (!this.aimJoy) this.aimJoy = this.grab(e, this.aimPad, this.aimKnob);
    } else if (this.twoButtons && this.inFire2(e.clientX, e.clientY)) {
      this.fire2Ids.add(e.pointerId);
      this.fire2Until = performance.now() + MIN_PRESS;
      this.ripple(e.clientX, e.clientY);
      if (this.haptics && navigator.vibrate) navigator.vibrate(8);
    } else {
      this.fireIds.add(e.pointerId);
      this.fireUntil = performance.now() + MIN_PRESS;
      if (this.dial && this.aimPad && !this.aimJoy) this.aimJoy = this.grab(e, this.aimPad, this.aimKnob, true);
      this.ripple(e.clientX, e.clientY);
      if (this.haptics && navigator.vibrate) navigator.vibrate(8);
    }
  }

  move(e) {
    if (this.aimJoy && e.pointerId === this.aimJoy.id) {
      e.preventDefault();
      if (this.aimJoy.dial) this.steerDial(this.aimJoy, e, this.aimPad, this.aimKnob);
      else this.steer(this.aimJoy, e, this.aimPad, this.aimKnob, false, true);   // aiming is always 8-way
      return;
    }
    const j = this.joy;
    if (!j || e.pointerId !== j.id) return;
    e.preventDefault();
    if (j.dial) this.steerDial(j, e, this.dpad, this.knob);
    else this.steer(j, e, this.dpad, this.knob, this.twoWay, this.eightWay);
  }

  // A dial pad: only the horizontal offset counts, scaled from the edge of the
  // dead zone (0) to the rim (full speed).
  steerDial(j, e, pad, knob) {
    const r = this.size / 2, dz = r * DEADZONE;
    const x = Math.max(-r, Math.min(r, e.clientX - j.ox));
    j.vel = Math.abs(x) < dz ? 0 : (Math.sign(x) * (Math.abs(x) - dz)) / (r - dz);
    knob.style.transform = `translate(calc(-50% + ${x}px), -50%)`;
    this.showDir(j.vel < 0 ? LEFT : j.vel > 0 ? RIGHT : 0, pad, true);
  }

  // A stick appears where the finger lands.
  // dial: a left/right dial pad (see steerDial) rather than a stick.
  grab(e, pad, knob, dial = false) {
    pad.style.left = `${e.clientX}px`;
    pad.style.top = `${e.clientY}px`;
    knob.style.transform = 'translate(-50%, -50%)';
    pad.className = dial ? 'dpad show dial' : 'dpad show';
    return { id: e.pointerId, ox: e.clientX, oy: e.clientY, dir: 0, dial, vel: 0 };
  }

  steer(j, e, pad, knob, twoWay, eightWay) {
    const dx = e.clientX - j.ox, dy = e.clientY - j.oy;
    const r = this.size / 2;
    if (twoWay) {
      // Two-way pad: only the horizontal offset counts, past the dead zone.
      const x = Math.max(-r, Math.min(r, dx));
      j.dir = Math.abs(dx) < r * DEADZONE ? 0 : dx < 0 ? LEFT : RIGHT;
      knob.style.transform = `translate(calc(-50% + ${x}px), -50%)`;
      this.showDir(j.dir, pad);
      return;
    }
    const dist = Math.hypot(dx, dy);
    j.dir = dist < r * DEADZONE ? 0 : this.direction(dx, dy, eightWay);
    const m = Math.min(1, r / Math.max(dist, 1e-6));
    j.ax = (dx * m) / r; j.ay = (dy * m) / r;
    // Past the rim the direction still follows the finger's angle; the knob pins to the edge.
    const k = Math.min(1, r / dist);
    knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
    this.showDir(j.dir, pad);
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
      this.dpad.className = 'dpad';
    }
    if (this.aimJoy && e.pointerId === this.aimJoy.id) {
      this.aimJoy = null;
      this.aimPad.className = 'dpad';
    }
    this.fireIds.delete(e.pointerId);
    this.fire2Ids.delete(e.pointerId);
  }

  direction(dx, dy, eightWay = this.eightWay) {
    const a = Math.atan2(dy, dx);
    if (eightWay) return DIR8[(Math.round(a / (Math.PI / 4)) + 8) % 8];
    return DIR8[((Math.round(a / (Math.PI / 2)) + 4) % 4) * 2];
  }

  showDir(d, pad = this.dpad, dial = false) {
    let c = dial ? 'dpad show dial' : 'dpad show';
    if (d & UP) c += ' up';
    if (d & DOWN) c += ' down';
    if (d & LEFT) c += ' left';
    if (d & RIGHT) c += ' right';
    if (pad.className !== c) pad.className = c;
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
    this.spinAcc = 0;
    this.aimJoy = null;
    this.dpad.className = 'dpad';
    if (this.aimPad) this.aimPad.className = 'dpad';
  }
}
