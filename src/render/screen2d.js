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
  }

  draw(frame) {
    this.pixels.set(frame);
    this.ctx.putImageData(this.image, 0, 0);
  }
}
