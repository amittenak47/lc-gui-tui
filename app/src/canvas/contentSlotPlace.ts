/**
 * Where `.lc-page-content-slot` sits on screen for a camera.
 *
 * The file HTML is `position:absolute; left:0; top:0` and is not on the ink
 * pan-ride list (it needs scale). Every live-scroll sample therefore has to
 * write `translate(left, top) scale(zoom)` from the same scroll the writing
 * layer is riding. Skip that write and ink pans while the file stays; then
 * commit clears the ink translate and the page jumps back to the start.
 *
 * Formula: `left = (minX + scrollX) * zoom` (same for top). Live place equals
 * committed place plus `panDelta`. When the page box is missing for a frame,
 * ride the last placement by the scroll delta so the slot still moves.
 */

export type ContentSlotBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type ContentSlotPlace = {
  left: number;
  top: number;
  sceneWidth: number;
  zoom: number;
  scrollX: number;
  scrollY: number;
};

export function contentSlotCssTransform(place: ContentSlotPlace): string {
  return `translate(${place.left}px, ${place.top}px) scale(${place.zoom})`;
}

/** Screen delta from a committed place to a live one — same as ink `panDelta`. */
export function panDeltaBetweenPlaces(
  committed: ContentSlotPlace,
  live: ContentSlotPlace,
): { dx: number; dy: number } {
  return {
    dx: (live.scrollX - committed.scrollX) * live.zoom,
    dy: (live.scrollY - committed.scrollY) * live.zoom,
  };
}

/**
 * Screen placement for a camera sample.
 *
 * `bounds` is the tight page box (same as `pageBoundsRef`). Missing bounds
 * still move the slot if a previous sample left a place to ride from.
 */
export function contentSlotPlaceAt(
  scrollX: number,
  scrollY: number,
  zoom: number,
  bounds: ContentSlotBounds | null,
  last: ContentSlotPlace | null,
): ContentSlotPlace | null {
  if (bounds) {
    return {
      left: (bounds.minX + scrollX) * zoom,
      top: (bounds.minY + scrollY) * zoom,
      sceneWidth: Math.max(1, bounds.maxX - bounds.minX),
      zoom,
      scrollX,
      scrollY,
    };
  }
  if (!last) return null;
  return {
    left: last.left + (scrollX - last.scrollX) * zoom,
    top: last.top + (scrollY - last.scrollY) * zoom,
    sceneWidth: last.sceneWidth,
    zoom,
    scrollX,
    scrollY,
  };
}

/**
 * A slot report off frozen Excalidraw `appState` while canvases still carry a
 * pan translate would rewind the file to the gesture start. Skip that write.
 */
export function shouldSkipFrozenContentSlotReport(live: boolean, panX: number, panY: number): boolean {
  return !live && (panX !== 0 || panY !== 0);
}
