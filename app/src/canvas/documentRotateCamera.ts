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
  const prevZoom =
    Number.isFinite(input.prevZoom) && input.prevZoom > 0 ? input.prevZoom : 1;
  const zoom = Math.min(
    input.zoomMax,
    Math.max(input.zoomMin, availW / boxW),
  );
  const slackX = Math.max(0, availW - boxW * zoom);
  const scrollX = (input.inset.left + slackX / 2) / zoom - input.box.minX;
  const sceneYTop = input.inset.top / prevZoom - input.prevScrollY;
  const scrollY = input.inset.top / zoom - sceneYTop;
  return { zoom, scrollX, scrollY };
}
