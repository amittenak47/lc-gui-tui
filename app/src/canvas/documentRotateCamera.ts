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
  alignX: "start" | "center" = "center",
): { zoom: number; scrollX: number; scrollY: number } {
  const availW = Math.max(1, input.viewWidth - input.inset.left - input.inset.right);
  const boxW = Math.max(1, input.box.maxX - input.box.minX);
  const prevZoom =
    Number.isFinite(input.prevZoom) && input.prevZoom > 0 ? input.prevZoom : 1;
  const zoom = clampFitZoom(nextZoom, input.zoomMin, input.zoomMax);
  const slackX = Math.max(0, availW - boxW * zoom);
  const padX = alignX === "start" ? 0 : slackX / 2;
  const scrollX = (input.inset.left + padX) / zoom - input.box.minX;
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
 * Optional fit cap, in CSS px. Board no longer passes one — a desktop window
 * width-fits the sheet so writing and rules fill the hole instead of sitting
 * in a tablet-sized column with a gap. Kept so a caller can still clamp.
 */
export const DRAW_PAGE_REF_VIEW_W = 844;

/**
 * Width-fit the sheet *and* the writing to this hole.
 *
 * A shifted `pageW` window used to keep zoom at the paper while ink that
 * started left of the frame pushed the right of the page off-screen — split
 * panes clipped both edges. Union the page and the ink, then zoom that box
 * to the pane so a split zooms out and a full window zooms in.
 */
export function drawPageFitBox(
  frame: SceneBox,
  ink: { minX: number; maxX?: number } | null | undefined,
  pageW: number,
): SceneBox {
  const pageMaxX = frame.minX + Math.max(1, pageW);
  const inkMin =
    ink && typeof ink.minX === "number" && Number.isFinite(ink.minX)
      ? ink.minX
      : frame.minX;
  const inkMax =
    ink && typeof ink.maxX === "number" && Number.isFinite(ink.maxX)
      ? ink.maxX
      : pageMaxX;
  return {
    minX: Math.min(frame.minX, inkMin),
    minY: frame.minY,
    maxX: Math.max(frame.maxX, pageMaxX, inkMax),
    maxY: frame.maxY,
  };
}

/**
 * Notebook / draw page: width-fit the sheet to this hole, keep the scene line.
 *
 * Slack (if any) stays on the right. A larger window zooms in with the page;
 * a narrower one zooms out. `capViewWidth` is optional.
 */
export function drawPageCameraAfterViewportChange(input: {
  box: SceneBox;
  inset: ViewportInset;
  viewWidth: number;
  prevZoom: number;
  prevScrollY: number;
  zoomMin: number;
  zoomMax: number;
  capViewWidth?: number;
}): { zoom: number; scrollX: number; scrollY: number } {
  const availW = Math.max(1, input.viewWidth - input.inset.left - input.inset.right);
  const boxW = Math.max(1, input.box.maxX - input.box.minX);
  const cap =
    Number.isFinite(input.capViewWidth) && (input.capViewWidth as number) > 0
      ? (input.capViewWidth as number)
      : availW;
  const fitW = Math.min(availW, cap);
  return cameraAfterViewportChange(input, fitW / boxW, "start");
}

/**
 * Recentre a notebook: width-fit like a resize, but hold the scene point that
 * was under the hole's centre.
 *
 * Left-aligning that fit slammed writing to the page's left edge — the Recentre
 * control looked offset, and ink jumped left. Resize still left-anchors so the
 * rules stay pinned; Recentre is the one that must not walk the page sideways.
 */
export function drawPageRecentreCamera(input: {
  box: SceneBox;
  inset: ViewportInset;
  viewWidth: number;
  prevZoom: number;
  prevScrollX: number;
  prevScrollY: number;
  zoomMin: number;
  zoomMax: number;
}): { zoom: number; scrollX: number; scrollY: number } {
  const availW = Math.max(1, input.viewWidth - input.inset.left - input.inset.right);
  const boxW = Math.max(1, input.box.maxX - input.box.minX);
  const prevZoom =
    Number.isFinite(input.prevZoom) && input.prevZoom > 0 ? input.prevZoom : 1;
  const zoom = clampFitZoom(availW / boxW, input.zoomMin, input.zoomMax);
  const holeCenter = input.inset.left + availW / 2;
  const sceneXCenter = holeCenter / prevZoom - input.prevScrollX;
  const sceneYTop = input.inset.top / prevZoom - input.prevScrollY;
  return {
    zoom,
    scrollX: holeCenter / zoom - sceneXCenter,
    scrollY: input.inset.top / zoom - sceneYTop,
  };
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

/**
 * Notebook / draw page: keep zoom and the scene point under the hole.
 *
 * Centering leftover slack (or left-aligning when zoomed in) threw away the
 * saved pan, so handwriting written in the middle of a 3920-wide pad landed
 * off-screen after restore / Recentre / the reveal ladder.
 */
export function keepZoomKeepPanCameraAfterViewportChange(input: {
  box: SceneBox;
  inset: ViewportInset;
  viewWidth: number;
  prevZoom: number;
  prevScrollX: number;
  prevScrollY: number;
  zoomMin: number;
  zoomMax: number;
}): { zoom: number; scrollX: number; scrollY: number } {
  const availW = Math.max(1, input.viewWidth - input.inset.left - input.inset.right);
  const boxW = Math.max(1, input.box.maxX - input.box.minX);
  const prevZoom =
    Number.isFinite(input.prevZoom) && input.prevZoom > 0 ? input.prevZoom : 1;
  const zoom = clampFitZoom(Math.min(prevZoom, availW / boxW), input.zoomMin, input.zoomMax);
  const sceneXLeft = input.inset.left / prevZoom - input.prevScrollX;
  const sceneYTop = input.inset.top / prevZoom - input.prevScrollY;
  return {
    zoom,
    scrollX: input.inset.left / zoom - sceneXLeft,
    scrollY: input.inset.top / zoom - sceneYTop,
  };
}
