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
