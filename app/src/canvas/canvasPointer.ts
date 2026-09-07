/**
 * Pointer → canvas pixels. `devicePixelRatio` is wrong when an ancestor uses
 * CSS `zoom` or `transform: scale()`: `getBoundingClientRect` is the painted
 * box, `canvas.width` is the backing store, and those two stop matching.
 */

export function canvasBitmapFromClient(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width > 0 ? canvas.width / rect.width : 1;
  const sy = rect.height > 0 ? canvas.height / rect.height : 1;
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  };
}

/** Layout CSS pixels on the canvas, for a 2d context that then scales by DPR. */
export function canvasCssFromClient(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const bit = canvasBitmapFromClient(canvas, clientX, clientY);
  const bw = Math.max(1, canvas.width);
  const bh = Math.max(1, canvas.height);
  const cw = Math.max(1, canvas.clientWidth || bw);
  const ch = Math.max(1, canvas.clientHeight || bh);
  return {
    x: bit.x * (cw / bw),
    y: bit.y * (ch / bh),
  };
}
