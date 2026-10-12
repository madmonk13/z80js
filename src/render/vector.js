// Draws a vector board's display list: line segments in the board's own
// coordinates (0..width, 0..height, y down), each with an RGB color whose
// brightness is the beam intensity. The canvas runs at the screen's real
// resolution (unlike Screen2D's native pixels), and each frame is drawn twice
// with additive blending: a wide faint pass for the phosphor glow, then the
// sharp line.
//
// Board contract: board.vector = true, and board.vectors = { data, count },
// where data holds count runs of [x0, y0, x1, y1, r, g, b] (r/g/b 0..1).

export class ScreenVector {
  constructor(canvas, width, height) {
    this.canvas = canvas;
    this.width = width;            // board coordinate space
    this.height = height;
    this.ctx = canvas.getContext('2d');
    this.kind = 'vector';
    this.resize(canvas.clientWidth || width, canvas.clientHeight || height);
  }

  // Match the canvas to its on-screen size in device pixels.
  resize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  draw(_frame, board) {
    const { ctx, canvas } = this, v = board.vectors;
    const sx = canvas.width / this.width, sy = canvas.height / this.height;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!v || !v.count) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const base = Math.max(1, canvas.width / 800);
    for (const [width, alpha] of [[base * 3.5, 0.25], [base, 1]]) {
      ctx.lineWidth = width;
      const d = v.data;
      for (let i = 0; i < v.count; i++) {
        const o = i * 7;
        const r = Math.round(d[o + 4] * 255), g = Math.round(d[o + 5] * 255), b = Math.round(d[o + 6] * 255);
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.beginPath();
        const x0 = d[o] * sx, y0 = d[o + 1] * sy, x1 = d[o + 2] * sx, y1 = d[o + 3] * sy;
        ctx.moveTo(x0, y0);
        // A zero-length segment is a dot (shots, stars): nudge it so it shows.
        ctx.lineTo(x1 === x0 && y1 === y0 ? x1 + 0.01 : x1, y1);
        ctx.stroke();
      }
    }
  }
}
