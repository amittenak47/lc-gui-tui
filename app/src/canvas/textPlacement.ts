/**
 * Geometry for the Text tool's placement gesture.
 *
 * A tap drops an auto-growing box; a drag draws a fixed-width one that wraps.
 * Kept apart from the DOM plumbing in `Board` so the "is this a tap?" slop and
 * the minimum readable box can be pinned down in tests.
 */

/** Screen px a press may wander and still count as a tap, not a drag. */
export const TEXT_TAP_SLOP_PX = 10;

export interface TextPlaceRect {
  /** Scene-space top-left of the box. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * True for a tap: Excalidraw grows the box with the text. A dragged box keeps
   * the width you drew and wraps inside it.
   */
  autoResize: boolean;
}

export interface TextPlaceViewport {
  zoom: number;
  scrollX: number;
  scrollY: number;
  offsetLeft: number;
  offsetTop: number;
}

export function textSceneFromClient(
  clientX: number,
  clientY: number,
  viewport: TextPlaceViewport,
): { x: number; y: number } {
  const zoom = viewport.zoom || 1;
  return {
    x: (clientX - viewport.offsetLeft) / zoom - viewport.scrollX,
    y: (clientY - viewport.offsetTop) / zoom - viewport.scrollY,
  };
}

export function textClientFromScene(
  sceneX: number,
  sceneY: number,
  viewport: TextPlaceViewport,
): { x: number; y: number } {
  const zoom = viewport.zoom || 1;
  return {
    x: (sceneX + viewport.scrollX) * zoom + viewport.offsetLeft,
    y: (sceneY + viewport.scrollY) * zoom + viewport.offsetTop,
  };
}

/**
 * Smallest box worth opening an editor in, in scene units.
 *
 * Sized off the font rather than a constant so a 12px note and a 48px heading
 * both get a caret you can see. The screen-px floors keep it tappable when the
 * board is zoomed way out.
 */
export function minTextBox(
  fontSize: number,
  zoom: number,
): { width: number; height: number } {
  const z = Math.max(zoom, 0.05);
  const screenFont = Math.max(12, fontSize * z);
  return {
    width: Math.max(screenFont * 8, 96) / z,
    height: Math.max(screenFont * 1.35, 28) / z,
  };
}

/**
 * The box a press-drag-release asks for.
 *
 * `origin`/`current` are client px; the result is scene units, ready to hand to
 * `convertToExcalidrawElements`.
 */
export function textPlaceRect(
  origin: { x: number; y: number },
  current: { x: number; y: number },
  viewport: TextPlaceViewport,
  fontSize: number,
): TextPlaceRect {
  const zoom = viewport.zoom || 1;
  const dragged =
    Math.abs(current.x - origin.x) > TEXT_TAP_SLOP_PX ||
    Math.abs(current.y - origin.y) > TEXT_TAP_SLOP_PX;

  const a = textSceneFromClient(origin.x, origin.y, viewport);
  const b = textSceneFromClient(current.x, current.y, viewport);
  const min = minTextBox(fontSize, zoom);

  if (!dragged) {
    return { x: a.x, y: a.y, width: min.width, height: min.height, autoResize: true };
  }
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    // A deliberate drag may be narrower than the tap default, but not so narrow
    // that a single word cannot fit — that wraps into a column of letters.
    width: Math.max(Math.abs(b.x - a.x), min.width * 0.35),
    height: Math.max(Math.abs(b.y - a.y), min.height),
    autoResize: false,
  };
}

/**
 * Where to aim the hand-off double-click.
 *
 * Excalidraw hit-tests the point, so it has to land inside the box. The first
 * line's left edge is the safest spot: a dragged box can be tall and empty, and
 * its centre may sit below anything Excalidraw considers part of the element.
 */
export function textEditorAnchor(rect: TextPlaceRect): { x: number; y: number } {
  return {
    x: rect.x + Math.min(rect.width, Math.max(4, rect.width * 0.1)),
    y: rect.y + Math.min(rect.height / 2, Math.max(4, rect.height * 0.25)),
  };
}
