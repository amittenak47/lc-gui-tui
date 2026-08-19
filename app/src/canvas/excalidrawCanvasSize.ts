/**
 * Force Excalidraw's canvases to a CSS box.
 *
 * `api.refresh()` only copies offsets. `updateDOMRect` is private and, in
 * view mode, Excalidraw never even listens to `window.resize`. WebView2
 * often leaves the bitmap at the old size until a pointer. Writing style +
 * backing store here is the same thing a draw eventually does, without the tap.
 */

export function canvasBufferSize(cssW: number, cssH: number, dpr: number): {
  width: number;
  height: number;
} {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return {
    width: Math.max(1, Math.round(cssW * scale)),
    height: Math.max(1, Math.round(cssH * scale)),
  };
}

export function applyExcalidrawCanvasBox(
  canvas: {
    style: { width: string; height: string };
    width: number;
    height: number;
  },
  cssW: number,
  cssH: number,
  dpr: number,
): void {
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const next = canvasBufferSize(cssW, cssH, dpr);
  if (canvas.width !== next.width) canvas.width = next.width;
  if (canvas.height !== next.height) canvas.height = next.height;
}

/** Paint every Excalidraw canvas in the board to the live hole. */
export function paintExcalidrawCanvases(
  board: HTMLElement,
  cssW: number,
  cssH: number,
): void {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  for (const node of board.querySelectorAll("canvas.excalidraw__canvas")) {
    if (!(node instanceof HTMLCanvasElement)) continue;
    applyExcalidrawCanvasBox(node, cssW, cssH, dpr);
  }
}
