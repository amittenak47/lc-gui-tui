/**
 * Camera after a document viewport change (device rotate, window resize).
 *
 * Annotate frames keep their scene width so ink and region marks stay on the
 * words. Width-fit zoom and scrollX must still follow the new chrome hole —
 * otherwise a portrait-open column sits against one landscape edge. ScrollY
 * keeps the same scene line at the top of the hole so a rotate does not jump
 * back to page 1.
 */

export interface ViewportInset {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface SceneBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Board hole for a fit. Prefer the live DOM box — `appState` width/height can
 * still be the previous orientation, and `Math.max(state, box)` kept the stale
 * *larger* side (landscape width after a rotate to portrait).
 */
export function liveBoardViewSize(
  boardBox: { width: number; height: number } | null | undefined,
  state: { width?: number; height?: number },
): { viewWidth: number; viewHeight: number } {
  const liveW = boardBox && boardBox.width > 8 ? Math.round(boardBox.width) : 0;
  const liveH = boardBox && boardBox.height > 8 ? Math.round(boardBox.height) : 0;
  const stateW = Number.isFinite(state.width) ? Math.round(state.width as number) : 0;
  const stateH = Number.isFinite(state.height) ? Math.round(state.height as number) : 0;
  return {
    viewWidth: liveW > 8 ? liveW : Math.max(0, stateW),
    viewHeight: liveH > 8 ? liveH : Math.max(0, stateH),
  };
}

/**
 * Size to write onto Excalidraw `appState`.
 *
 * `api.refresh()` only copies canvas offsets. Canvas CSS width/height stay
 * `window.innerWidth` until `updateDOMRect` — which on Android WebView often
 * waits for a pointer. Split/rotate then look full-width until a tap.
 */
export function liveExcalidrawViewport(
  boardBox: { width: number; height: number } | null | undefined,
): { width: number; height: number } | null {
  if (!boardBox || boardBox.width < 8 || boardBox.height < 8) return null;
  return {
    width: Math.round(boardBox.width),
    height: Math.round(boardBox.height),
  };
}

export function excalidrawViewportNeedsSync(
  live: { width: number; height: number },
  state: { width?: number; height?: number },
): boolean {
  return (
    Math.round(state.width ?? 0) !== live.width ||
    Math.round(state.height ?? 0) !== live.height
  );
}

function clampFitZoom(zoom: number, zoomMin: number, zoomMax: number): number {
  return Math.min(zoomMax, Math.max(zoomMin, zoom));
}

function cameraAfterViewportChange(
  input: {
    box: SceneBox;
    inset: ViewportInset;
    viewWidth: number;
    prevZoom: number;
    prevScrollY: number;
    zoomMin: number;
    zoomMax: number;
  },
  nextZoom: number,
): { zoom: number; scrollX: number; scrollY: number } {
  const availW = Math.max(1, input.viewWidth - input.inset.left - input.inset.right);
  const boxW = Math.max(1, input.box.maxX - input.box.minX);
  const prevZoom =
    Number.isFinite(input.prevZoom) && input.prevZoom > 0 ? input.prevZoom : 1;
  const zoom = clampFitZoom(nextZoom, input.zoomMin, input.zoomMax);
  const slackX = Math.max(0, availW - boxW * zoom);
  const scrollX = (input.inset.left + slackX / 2) / zoom - input.box.minX;
  const sceneYTop = input.inset.top / prevZoom - input.prevScrollY;
  const scrollY = input.inset.top / zoom - sceneYTop;
  return { zoom, scrollX, scrollY };
}

export function documentCameraAfterViewportChange(input: {
  box: SceneBox;
  inset: ViewportInset;
  viewWidth: number;
  prevZoom: number;
  prevScrollY: number;
  zoomMin: number;
  zoomMax: number;
}): { zoom: number; scrollX: number; scrollY: number } {
  const availW = Math.max(1, input.viewWidth - input.inset.left - input.inset.right);
  const boxW = Math.max(1, input.box.maxX - input.box.minX);
  return cameraAfterViewportChange(input, availW / boxW);
}

/**
 * Split sash / pane resize for a draw page: do not zoom in to fill a wider hole.
 *
 * Width-fit on every keepY made the sheet expand with the sash. Keep the
 * previous zoom, zoom out only when the page no longer fits, and center leftover
 * slack. ScrollY still holds the same scene line at the top of the hole.
 */
export function keepZoomCenterCameraAfterViewportChange(input: {
  box: SceneBox;
  inset: ViewportInset;
  viewWidth: number;
  prevZoom: number;
  prevScrollY: number;
  zoomMin: number;
  zoomMax: number;
}): { zoom: number; scrollX: number; scrollY: number } {
  const availW = Math.max(1, input.viewWidth - input.inset.left - input.inset.right);
  const boxW = Math.max(1, input.box.maxX - input.box.minX);
  const prevZoom =
    Number.isFinite(input.prevZoom) && input.prevZoom > 0 ? input.prevZoom : 1;
  return cameraAfterViewportChange(input, Math.min(prevZoom, availW / boxW));
}
