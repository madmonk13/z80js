// Draws the board's frame (32-bit RGBA pixels) to a canvas at native size;
// CSS scales it up with crisp pixels.

export class Screen2D {
  constructor(canvas, width, height) {
    this.canvas = canvas;
    canvas.width = width;
    canvas.height = height;
    this.ctx = canvas.getContext('2d');
    this.image = this.ctx.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.width = width; this.height = height;
    this.source = null; this.direct = null;
  }

  draw(frame) {
    // When the frame is exactly the picture's pixels, hand its memory to the canvas as is
    // (no copy each frame); otherwise copy it into our own image.
    if (frame !== this.source) {
      this.source = frame; this.direct = null;
      if (frame.length === this.width * this.height) {
        try { this.direct = new ImageData(new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.length * 4), this.width, this.height); }
        catch { this.direct = null; }
      }
    }
    if (this.direct) this.ctx.putImageData(this.direct, 0, 0);
    else { this.pixels.set(frame); this.ctx.putImageData(this.image, 0, 0); }
  }
}
