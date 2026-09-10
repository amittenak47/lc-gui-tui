/**
 * Separate clocks for scene-tile raster vs the SDF upload inside it.
 *
 * Loading used to report one undifferentiated hitch. Exam 1 cares which half
 * is expensive: walking ops into a tile (`renderTile`) or the WebGL capsule
 * blit (`paintSdfSpines`). Live pen metrics stay on {@link inkMetrics}.
 */

export type InkTileMetrics = {
  renderMs: number;
  sdfMs: number;
  maxRenderMs: number;
  maxSdfMs: number;
  tiles: number;
};

const zero: InkTileMetrics = {
  renderMs: 0,
  sdfMs: 0,
  maxRenderMs: 0,
  maxSdfMs: 0,
  tiles: 0,
};

let state: InkTileMetrics = { ...zero };

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

export function noteInkTileRaster(renderMs: number, sdfMs: number): void {
  if (!Number.isFinite(renderMs) || renderMs < 0) return;
  const sdf = Number.isFinite(sdfMs) && sdfMs > 0 ? sdfMs : 0;
  state = {
    renderMs: round(renderMs),
    sdfMs: round(sdf),
    maxRenderMs: Math.max(state.maxRenderMs, round(renderMs)),
    maxSdfMs: Math.max(state.maxSdfMs, round(sdf)),
    tiles: state.tiles + 1,
  };
  if (typeof window !== "undefined") {
    (window as Window & { __lcInkTileMetrics?: InkTileMetrics }).__lcInkTileMetrics =
      peekInkTileMetrics();
  }
}

export function peekInkTileMetrics(): InkTileMetrics {
  return { ...state };
}

export function resetInkTileMetrics(): void {
  state = { ...zero };
}
