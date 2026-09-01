/**
 * Map-style tile cache for the raster ink layer.
 *
 * The layer used to keep one viewport-sized "bake" of every committed op. That
 * bake was keyed on zoom and canvas size but not on scroll, so panning slid it
 * under a CSS translate and the board went blank wherever the translate exposed
 * ground the bake never covered — then the whole scene replayed in one blocking
 * go when you let go. Zooming was worse: zoom is in the key, so every frame of
 * a pinch or a smooth zoom replayed every stroke on the page before it could
 * paint.
 *
 * Tiles fix both. Ink is rasterised into fixed squares of scene space, cached
 * per zoom level, and the visible ones are blitted every frame. Panning reuses
 * tiles it has and rasterises only the newly exposed ones; zooming blits the
 * tiles it already has, scaled, and sharpens them in the background. Nothing
 * ever replays the whole page to put one frame on screen.
 *
 * Rasterising is budgeted per frame and continues across frames, so a board
 * with a lot of writing on it degrades into "sharpens a moment later" rather
 * than "stops responding".
 */

import {
  applyInkOp,
  applyInkOpFrom,
  applyInkOpInHost,
  HIGHLIGHT_WIDTH_SCALE,
  hostScrollDx,
  inkLineWidth,
  INK_SPEED_WIDTH_RANGE,
  INK_TIP_STEP,
  isHostBoundOp,
  paintHostBoundOps,
  setInkSceneTransform,
  type InkOp,
  type SceneBounds,
  type ScrollHostLookup,
  type ViewportTransform,
} from "./rasterInk";

/** Tile edge in device pixels. */
export const TILE_PX = 384;
/**
 * Extra pixels past each tile edge, baked into the canvas only.
 *
 * A stroke that meets the square is rasterised with neighbour context so the
 * core-edge pixels are fully covered. The dest blit copies the core, not this
 * pad: overlapping dest copies of translucent ink stacked into a lattice the
 * colour of the stroke.
 *
 * 3px was enough for solid-ink AA. A drying wash that clips there still
 * showed a grid-aligned color cut, so the pad is on the order of a nib.
 */
export const TILE_OVERLAP_PX = 16;

/**
 * Zoom levels tiles are rasterised at, as steps of the exponent of two.
 *
 * Half-steps mean the worst-case resample between a tile and the screen is
 * √2 — visible as a touch of softness mid-gesture, gone as soon as the
 * background pass catches up. Whole steps would double that; quarter steps
 * would re-rasterise the page twice as often for a difference nobody sees.
 */
export const LEVEL_STEP = 0.5;

/** Milliseconds of rasterising allowed inside one `draw` call. */
export const DRAW_BUDGET_MS = 5;
/** And inside a background catch-up frame, where nothing is waiting on us. */
export const IDLE_BUDGET_MS = 8;
/**
 * And inside a frame of a moving camera, where the next one is already due.
 *
 * A pan or zoom frame is not a good moment to build anything. The gesture is
 * still running, so whatever gets rasterised now is for a camera that has
 * already moved on, and the 5ms it costs comes out of a budget that Excalidraw
 * is also drawing a whole scene from. Fall back to the cached levels instead —
 * a frame or two of softness during motion is invisible next to the stutter of
 * paying for sharpness on every one of them.
 */
export const MOVING_BUDGET_MS = 3.5;

/**
 * How far, in levels, a gesture may drift from the level it pinned.
 *
 * One octave: at the far end of it a screen costs four times the squares it
 * would at the right level, which is still a blit and still cheaper than
 * rasterising them. Past that the arithmetic turns over.
 */
export const MAX_PIN_DRIFT = 1;

/**
 * Cache ceiling, as a multiple of the visible tile count.
 *
 * Enough to hold a screen, the ring around it a pan is about to reach, and the
 * level a zoom just came from. Past that it is memory spent on ground the user
 * has left.
 */
export const TILE_BUDGET_FACTOR = 3.5;
export const TILE_BUDGET_MIN = 24;
export const TILE_BUDGET_MAX = 160;

export interface TileRange {
  minTx: number;
  minTy: number;
  maxTx: number;
  maxTy: number;
}

/** Rasterisation level for a screen scale, snapped to the level ladder. */
export function pickRenderLevel(pixelScale: number): number {
  const safe = Math.max(pixelScale, 1e-6);
  return Math.round(Math.log2(safe) / LEVEL_STEP) * LEVEL_STEP;
}

/** Device pixels per scene unit that a level rasterises at. */
export function levelScale(level: number): number {
  return 2 ** level;
}

/** Scene-space edge of one tile at a level. */
export function tileSceneSize(level: number, tilePx = TILE_PX): number {
  return tilePx / levelScale(level);
}

export function tileRangeFor(view: SceneBounds, tileScene: number): TileRange {
  return {
    minTx: Math.floor(view.minX / tileScene),
    minTy: Math.floor(view.minY / tileScene),
    maxTx: Math.floor((view.maxX - 1e-9) / tileScene),
    maxTy: Math.floor((view.maxY - 1e-9) / tileScene),
  };
}

/**
 * Order tiles should be rasterised when the frame budget cannot cover them all.
 *
 * A fixed top-to-bottom walk left the leading edge of a downward pan — new
 * tiles at the bottom of the screen — for the deferred pass, while an upward
 * pan's new top tiles took the synchronous budget. That is why ink looked
 * pre-painted scrolling one way and late the other. Match the visit order to
 * the pan: whichever way the page is moving, the newly exposed band paints
 * first.
 *
 * `scrollDeltaY` is live − previous Excalidraw `scrollY`. Positive means the
 * view moved toward earlier content (new tiles at the top); negative toward
 * later content (new tiles at the bottom).
 */
export function tileVisitOrder(
  range: TileRange,
  scrollDeltaY: number,
): Array<{ tx: number; ty: number }> {
  const rows: number[] = [];
  for (let ty = range.minTy; ty <= range.maxTy; ty++) rows.push(ty);
  if (scrollDeltaY < 0) rows.reverse();
  const out: Array<{ tx: number; ty: number }> = [];
  for (const ty of rows) {
    for (let tx = range.minTx; tx <= range.maxTx; tx++) {
      out.push({ tx, ty });
    }
  }
  return out;
}

/** Scene rect the viewport shows. */
export function viewportSceneBounds(viewport: ViewportTransform): SceneBounds {
  const zoom = viewport.zoom || 1;
  return {
    minX: -viewport.scrollX,
    minY: -viewport.scrollY,
    maxX: -viewport.scrollX + viewport.width / zoom,
    maxY: -viewport.scrollY + viewport.height / zoom,
  };
}

export function boundsOverlap(a: SceneBounds, b: SceneBounds): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

/** The smallest box holding both — see the diverged range in `setOps`. */
export function unionBounds(a: SceneBounds, b: SceneBounds): SceneBounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function intersectBounds(a: SceneBounds, b: SceneBounds): SceneBounds | null {
  const box = {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
  };
  if (box.maxX <= box.minX || box.maxY <= box.minY) return null;
  return box;
}

/**
 * Scene box one op touches, padded by half the widest line it can carry.
 *
 * Cached per op: it never changes once committed, and every tile that has to
 * decide whether to replay the op asks for it again.
 */
const opBoundsCache = new WeakMap<InkOp, SceneBounds>();

export function inkOpBounds(op: InkOp): SceneBounds {
  const cached = opBoundsCache.get(op);
  if (cached) return cached;
  const pad =
    op.kind === "erase"
      ? op.radius
      : // Full press at a standstill spreads the nib as far as it goes; with
        // pressure and speed ink both off this is the same number it always was.
        // Extra tip-step pad so a borderline tile is never left blank forever
        // after clear+append (reset-board invisible band). Blot can overshoot
        // past that standstill width, so the pad has to cover the pool too.
        (op.highlight
          ? inkLineWidth(op.baseWidth, 0, false) * HIGHLIGHT_WIDTH_SCALE
          : inkLineWidth(
              op.baseWidth,
              1,
              op.pressureSensitive,
              1,
              op.speedInk ?? 0,
            ) *
            (1 + INK_SPEED_WIDTH_RANGE * (op.speedBlotBlend ?? 0))) /
          2 +
        INK_TIP_STEP;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of op.points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const bounds: SceneBounds =
    minX === Infinity
      ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      : { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  opBoundsCache.set(op, bounds);
  return bounds;
}

interface Tile {
  key: string;
  level: number;
  tx: number;
  ty: number;
  canvas: HTMLCanvasElement;
  /** Draw-call counter when this tile was last blitted, for eviction. */
  usedAt: number;
  /** True once anything was rasterised into it. */
  painted: boolean;
}

function tileKey(level: number, tx: number, ty: number): string {
  return `${level}|${tx}|${ty}`;
}

export interface InkTileCacheOptions {
  tilePx?: number;
  /** Called when a background pass finished tiles the last draw could not. */
  onTilesReady?: () => void;
  /** Injectable for tests; defaults to a detached canvas element. */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  /** Injectable for tests. */
  now?: () => number;
  /** Injectable for tests. */
  schedule?: (callback: () => void) => number;
  cancel?: (handle: number) => void;
}

interface PendingTile {
  level: number;
  tx: number;
  ty: number;
}

export class InkTileCache {
  private ops: InkOp[] = [];
  private readonly tiles = new Map<string, Tile>();
  private readonly tilePx: number;
  private readonly onTilesReady?: () => void;
  private readonly createCanvas: (width: number, height: number) => HTMLCanvasElement;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => number;
  private readonly cancel: (handle: number) => void;

  private clip: SceneBounds | null = null;
  private drawCount = 0;
  private budget = TILE_BUDGET_MIN;
  private pending: PendingTile[] = [];
  private idleHandle = 0;
  /** True between the start of a camera gesture and its settle. */
  private moving = false;
  /**
   * The level being drawn at, pinned for the duration of a gesture.
   *
   * A zoom crosses a level boundary every √2, and crossing one invalidates
   * every visible square at once: the new level has nothing cached, so a
   * screenful of tiles all want rasterising inside the same frame that the
   * zoom is already animating. Pinning holds the gesture on the level it
   * started from — the tiles are all cached, so every frame is pure blit, and
   * the resample is the same one `blitFallback` would have done anyway. The
   * settle re-levels and the background pass sharpens it.
   */
  private pinnedLevel: number | null = null;
  /** Level the last `draw` resolved to — what a gesture opening now would pin. */
  private lastLevel: number | null = null;
  /** `scrollY` of the last draw — drives leading-edge visit order. */
  private lastScrollY: number | null = null;

  constructor(options: InkTileCacheOptions = {}) {
    this.tilePx = options.tilePx ?? TILE_PX;
    this.onTilesReady = options.onTilesReady;
    this.createCanvas =
      options.createCanvas ??
      ((width, height) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      });
    this.now = options.now ?? (() => performance.now());
    this.schedule =
      options.schedule ?? ((callback) => requestAnimationFrame(callback));
    this.cancel = options.cancel ?? ((handle) => cancelAnimationFrame(handle));
  }

  /**
   * A camera gesture started or settled.
   *
   * While moving, `draw` blits and little else: the level is pinned to the one
   * the gesture began on, and the rasterising budget drops to
   * {@link MOVING_BUDGET_MS}. The settle releases both and leaves the
   * background pass to bring the page back to full sharpness.
   */
  setMoving(moving: boolean): void {
    if (this.moving === moving) return;
    this.moving = moving;
    // Pinned at the open, not on the first frame inside: by then the camera has
    // already moved and the level it wants is the uncached one we are trying to
    // avoid. The level to hold is the one the last still frame drew.
    this.pinnedLevel =
      moving && this.lastLevel !== null && this.hasLevel(this.lastLevel)
        ? this.lastLevel
        : null;
  }

  /**
   * Replace the committed history — notebook restore, undo, clear.
   *
   * Only the tiles the change actually touched are dropped, because dropping
   * all of them is what the undo flash was. `draw` renders misses against a
   * time budget and stands a coarser *cached* tile in for anything that misses
   * it — so with the cache emptied there is nothing to stand in, and the
   * squares that ran out of budget come back as holes. Tiles are walked
   * top-to-bottom, which is why the holes were a band across the lower half of
   * the screen and not scattered: those rows are simply the ones the budget
   * never reached.
   *
   * An undo removes the last stroke, which covers a few tiles out of a
   * screenful. Rebuilding those costs one frame's worth of replay and leaves
   * the rest of the page on screen, untouched, the whole time.
   */
  setOps(ops: readonly InkOp[]): void {
    const prev = this.ops;
    const next = [...ops];
    // Ops are shared objects — a history array is rebuilt, its entries are not
    // — so identity is enough to find where the two histories diverge.
    let shared = 0;
    while (shared < prev.length && shared < next.length && prev[shared] === next[shared]) {
      shared += 1;
    }

    if (shared === prev.length && shared === next.length) {
      this.ops = next;
      return;
    }
    // Pure append: composite the new ops in, exactly as `appendOp` argues. It
    // maintains `this.ops` itself, so the swap is left to it — assigning `next`
    // first and then iterating it while `appendOp` pushed onto the same array
    // is a loop that does not end.
    if (shared === prev.length) {
      const added = next.slice(shared);
      for (const op of added) this.appendOp(op);
      return;
    }

    this.ops = next;
    // Nothing in common: a different notebook, or a clear. There is no cache
    // worth keeping and no flash to avoid — the page is changing wholesale.
    if (shared === 0) {
      this.invalidate();
      return;
    }

    // Ops were removed or replaced. Both sides of the divergence matter: the
    // pixels that must come off, and the ones that must go on.
    let dirty: SceneBounds | null = null;
    const widen = (op: InkOp) => {
      const bounds = inkOpBounds(op);
      dirty = dirty ? unionBounds(dirty, bounds) : bounds;
    };
    for (let i = shared; i < prev.length; i += 1) widen(prev[i]);
    for (let i = shared; i < next.length; i += 1) widen(next[i]);
    if (!dirty) return;

    for (const [key, tile] of [...this.tiles]) {
      const box = this.tileBounds(tile.level, tile.tx, tile.ty);
      if (boundsOverlap(dirty, box)) this.tiles.delete(key);
    }
  }

  /**
   * Add one just-committed op by drawing it *into* the tiles it lands on.
   *
   * This is the difference between writing staying cheap and writing getting
   * slower the more of it there is. Committing used to drop every tile the new
   * stroke touched, and the repaint that followed rebuilt them by replaying
   * every op those tiles overlap — so the tenth letter in a square replayed
   * nine strokes, the fortieth replayed thirty-nine, and the pen-lift hitch
   * grew without bound across a page. That is the "smooth for a few letters,
   * then it starts lagging" that the tiling was supposed to have fixed.
   *
   * Nothing about a freshly committed op requires a rebuild: it is chronologically
   * last, so compositing it over what the tile already holds is exactly what a
   * replay would have produced — including an erase, which is `destination-out`
   * against the tile's own pixels either way. Cost is one stroke per tile,
   * independent of what is already written there.
   */
  appendOp(op: InkOp): void {
    this.ops.push(op);
    if (isHostBoundOp(op)) return;
    const bounds = inkOpBounds(op);
    for (const tile of [...this.tiles.values()]) {
      const box = this.tileBounds(tile.level, tile.tx, tile.ty);
      const scale = levelScale(tile.level);
      if (!boundsOverlap(bounds, this.paddedTileBounds(box, scale))) continue;
      this.paintOpIntoTile(tile, op, box);
    }
  }

  /** Composite one op onto a tile that is already rasterised. */
  private paintOpIntoTile(tile: Tile, op: InkOp, bounds: SceneBounds): void {
    const ctx = tile.canvas.getContext("2d");
    if (!ctx) {
      // Nothing sane to composite onto — fall back to the old behaviour and
      // let the tile rasterise from scratch next time it is asked for.
      this.tiles.delete(tile.key);
      return;
    }
    const paintable = this.clip ? intersectBounds(bounds, this.clip) : bounds;
    if (!paintable) return;
    const scale = levelScale(tile.level);
    this.setTileTransform(ctx, bounds, scale);
    if (this.clip) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        this.clip.minX,
        this.clip.minY,
        this.clip.maxX - this.clip.minX,
        this.clip.maxY - this.clip.minY,
      );
      ctx.clip();
    }
    applyInkOp(ctx, op, scale);
    if (this.clip) ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Page turn — the clip box is baked into the tiles, so they all go. */
  setClip(clip: SceneBounds | null): void {
    const same =
      (clip === null && this.clip === null) ||
      (clip !== null &&
        this.clip !== null &&
        clip.minX === this.clip.minX &&
        clip.minY === this.clip.minY &&
        clip.maxX === this.clip.maxX &&
        clip.maxY === this.clip.maxY);
    if (same) return;
    this.clip = clip;
    this.invalidate();
  }

  invalidate(): void {
    this.tiles.clear();
    this.pending = [];
    if (this.idleHandle) {
      this.cancel(this.idleHandle);
      this.idleHandle = 0;
    }
  }

  dispose(): void {
    this.invalidate();
    this.ops = [];
  }

  /** Tiles currently held — for tests and for the metrics readout. */
  get size(): number {
    return this.tiles.size;
  }

  /** True while the last draw left tiles to rasterise in the background. */
  get settled(): boolean {
    return this.pending.length === 0;
  }

  private tileBounds(level: number, tx: number, ty: number): SceneBounds {
    const size = tileSceneSize(level, this.tilePx);
    return {
      minX: tx * size,
      minY: ty * size,
      maxX: (tx + 1) * size,
      maxY: (ty + 1) * size,
    };
  }

  private tileCanvasPx(): number {
    return this.tilePx + 2 * TILE_OVERLAP_PX;
  }

  /** Scene → tile pixels, origin at the padded top-left. */
  private setTileTransform(
    ctx: CanvasRenderingContext2D,
    bounds: SceneBounds,
    scale: number,
  ): void {
    ctx.setTransform(
      scale,
      0,
      0,
      scale,
      TILE_OVERLAP_PX - bounds.minX * scale,
      TILE_OVERLAP_PX - bounds.minY * scale,
    );
  }

  /** Core tile plus the overlap pad in scene units. */
  private paddedTileBounds(bounds: SceneBounds, scale: number): SceneBounds {
    const pad = TILE_OVERLAP_PX / scale;
    return {
      minX: bounds.minX - pad,
      minY: bounds.minY - pad,
      maxX: bounds.maxX + pad,
      maxY: bounds.maxY + pad,
    };
  }

  private renderTile(level: number, tx: number, ty: number): Tile | null {
    const key = tileKey(level, tx, ty);
    const existing = this.tiles.get(key);
    if (existing) return existing;

    const canvasPx = this.tileCanvasPx();
    const canvas = this.createCanvas(canvasPx, canvasPx);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const bounds = this.tileBounds(level, tx, ty);
    const scale = levelScale(level);
    const tile: Tile = {
      key,
      level,
      tx,
      ty,
      canvas,
      usedAt: this.drawCount,
      painted: true,
    };

    const paintable = this.clip ? intersectBounds(bounds, this.clip) : bounds;
    if (paintable) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvasPx, canvasPx);
      // Scene → tile pixels: the padded top-left is the origin.
      this.setTileTransform(ctx, bounds, scale);
      if (this.clip) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          this.clip.minX,
          this.clip.minY,
          this.clip.maxX - this.clip.minX,
          this.clip.maxY - this.clip.minY,
        );
        ctx.clip();
      }
      // Chronological, so a stroke drawn after an erase survives it. Ops that
      // miss the tile are skipped: an erase outside it cannot reach in.
      for (const op of this.ops) {
        if (isHostBoundOp(op)) continue;
        if (!boundsOverlap(inkOpBounds(op), this.paddedTileBounds(bounds, scale))) continue;
        applyInkOp(ctx, op, scale);
      }
      if (this.clip) ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    this.tiles.set(key, tile);
    return tile;
  }

  private evict(): void {
    if (this.tiles.size <= this.budget) return;
    const bySeen = [...this.tiles.values()].sort((a, b) => a.usedAt - b.usedAt);
    const drop = this.tiles.size - this.budget;
    for (let i = 0; i < drop; i++) {
      this.tiles.delete(bySeen[i].key);
    }
  }

  private runPending(): void {
    this.idleHandle = 0;
    if (this.pending.length === 0) return;
    // "Idle" is a lie while a gesture is running — this pass shares the frame
    // with it. Keep filling ground in, but a sliver at a time.
    const deadline =
      this.now() + (this.moving ? MOVING_BUDGET_MS : IDLE_BUDGET_MS);
    while (this.pending.length > 0 && this.now() < deadline) {
      const next = this.pending.shift()!;
      this.renderTile(next.level, next.tx, next.ty);
    }
    this.evict();
    if (this.pending.length > 0) {
      this.idleHandle = this.schedule(() => this.runPending());
    }
    this.onTilesReady?.();
  }

  /**
   * Blit the visible ink onto `ctx`, which must be in device-pixel space with
   * the identity transform. Rasterises what it can afford and schedules the rest.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    viewport: ViewportTransform,
    dpr: number,
  ): void {
    this.drawCount += 1;
    const zoom = viewport.zoom || 1;
    const pixelScale = zoom * dpr;
    const wanted = pickRenderLevel(pixelScale);
    let level = wanted;
    if (this.moving && this.pinnedLevel !== null) {
      // Hold the gesture's level, but not past the point where holding it is
      // the more expensive answer. A tile covers a fixed span of *scene*, so
      // every octave the camera zooms out past the pinned level quadruples the
      // squares a screen needs — cheaper, eventually, to just re-level.
      const drift = Math.abs(this.pinnedLevel - wanted);
      if (drift <= MAX_PIN_DRIFT) {
        level = this.pinnedLevel;
      } else {
        this.pinnedLevel = wanted;
      }
    }
    this.lastLevel = level;
    const tileScene = tileSceneSize(level, this.tilePx);

    const view = viewportSceneBounds(viewport);
    const visible = this.clip ? intersectBounds(view, this.clip) : view;
    if (!visible) {
      this.pending = [];
      return;
    }

    const range = tileRangeFor(visible, tileScene);
    const across = range.maxTx - range.minTx + 1;
    const down = range.maxTy - range.minTy + 1;
    this.budget = Math.min(
      TILE_BUDGET_MAX,
      Math.max(TILE_BUDGET_MIN, Math.ceil(across * down * TILE_BUDGET_FACTOR)),
    );

    // Scene → device pixels on the destination canvas.
    const toDeviceX = (sceneX: number) => (sceneX + viewport.scrollX) * pixelScale;
    const toDeviceY = (sceneY: number) => (sceneY + viewport.scrollY) * pixelScale;

    const deadline =
      this.now() + (this.moving ? MOVING_BUDGET_MS : DRAW_BUDGET_MS);
    const missed: PendingTile[] = [];
    // Worked out on the first miss, if there is one, and reused for the rest.
    let fallbacks: number[] | null = null;

    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    const scrollDeltaY =
      this.lastScrollY == null ? 0 : viewport.scrollY - this.lastScrollY;
    this.lastScrollY = viewport.scrollY;

    for (const { tx, ty } of tileVisitOrder(range, scrollDeltaY)) {
      const bounds = this.tileBounds(level, tx, ty);
      const key = tileKey(level, tx, ty);
      let tile = this.tiles.get(key);
      if (!tile && this.now() < deadline) {
        tile = this.renderTile(level, tx, ty) ?? undefined;
      }
      if (!tile) {
        missed.push({ level, tx, ty });
        if (fallbacks === null) fallbacks = this.fallbackLevels(level);
        this.blitFallback(ctx, bounds, toDeviceX, toDeviceY, fallbacks);
        continue;
      }
      tile.usedAt = this.drawCount;
      const dx = toDeviceX(bounds.minX);
      const dy = toDeviceY(bounds.minY);
      const size = tileScene * pixelScale;
      ctx.drawImage(
        tile.canvas,
        TILE_OVERLAP_PX,
        TILE_OVERLAP_PX,
        this.tilePx,
        this.tilePx,
        dx,
        dy,
        size,
        size,
      );
    }

    this.pending = missed;
    this.evict();
    if (missed.length > 0 && this.idleHandle === 0) {
      this.idleHandle = this.schedule(() => this.runPending());
    }
  }

  /**
   * Levels that could stand in for `level`, sharpest-nearest first.
   *
   * This used to be a single remembered level: the last one at which every
   * visible tile was ready. That answer is wrong exactly when it matters. Once
   * a few frames complete at the level you are on, the remembered level *is*
   * the level you are on — and a fallback from a level to itself is refused, so
   * the next square that misses its budget is left as a hole. On an overlay
   * that has just been cleared, a hole is not "a bit blurry", it is committed
   * ink that is not on screen: the letter you just lifted the pen off vanishes,
   * and stays gone until the deferred repaint at the next lift brings it back.
   *
   * The cache is sized to hold the level a zoom came from, so there is nearly
   * always something to draw. Ask what is actually cached instead of
   * remembering one answer, and prefer the nearest level — least resampling,
   * so the stand-in is as sharp as the cache can make it — breaking ties toward
   * the finer one.
   */
  /** Whether anything is cached at a level — i.e. whether pinning to it buys a blit. */
  private hasLevel(level: number): boolean {
    for (const tile of this.tiles.values()) {
      if (tile.level === level) return true;
    }
    return false;
  }

  private fallbackLevels(level: number): number[] {
    const levels = new Set<number>();
    for (const tile of this.tiles.values()) {
      if (tile.level !== level) levels.add(tile.level);
    }
    return [...levels].sort(
      (a, b) => Math.abs(a - level) - Math.abs(b - level) || b - a,
    );
  }

  /**
   * Fill a not-yet-rasterised square from whatever level is already cached.
   *
   * Blurry for a frame or two beats a hole. This is the whole reason a zoom
   * stays continuous on a busy page, and why a freshly committed stroke stays
   * on screen when the frame that should have drawn it ran out of budget — a
   * just-appended op is composited into every cached tile it overlaps, at every
   * level, so the stand-in carries it too.
   *
   * A pan-missed tile at the pinned level has no same-level stale tile by
   * construction — the miss is newly exposed ground, not a budget skip on a
   * square that was ready a frame ago — so fallback walks other cached levels.
   */
  private blitFallback(
    ctx: CanvasRenderingContext2D,
    bounds: SceneBounds,
    toDeviceX: (x: number) => number,
    toDeviceY: (y: number) => number,
    levels: readonly number[],
  ): void {
    for (const from of levels) {
      if (this.blitFrom(ctx, bounds, toDeviceX, toDeviceY, from)) return;
    }
  }

  /** Blit `bounds` out of one cached level. False if it held nothing to draw. */
  private blitFrom(
    ctx: CanvasRenderingContext2D,
    bounds: SceneBounds,
    toDeviceX: (x: number) => number,
    toDeviceY: (y: number) => number,
    from: number,
  ): boolean {
    let drew = false;
    const size = tileSceneSize(from, this.tilePx);
    const minTx = Math.floor(bounds.minX / size);
    const maxTx = Math.floor((bounds.maxX - 1e-9) / size);
    const minTy = Math.floor(bounds.minY / size);
    const maxTy = Math.floor((bounds.maxY - 1e-9) / size);
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const tile = this.tiles.get(tileKey(from, tx, ty));
        if (!tile) continue;
        const src = this.tileBounds(from, tx, ty);
        const box = intersectBounds(src, bounds);
        if (!box) continue;
        const srcScale = this.tilePx / size;
        const destW = toDeviceX(box.maxX) - toDeviceX(box.minX);
        const destH = toDeviceY(box.maxY) - toDeviceY(box.minY);
        ctx.drawImage(
          tile.canvas,
          TILE_OVERLAP_PX + (box.minX - src.minX) * srcScale,
          TILE_OVERLAP_PX + (box.minY - src.minY) * srcScale,
          (box.maxX - box.minX) * srcScale,
          (box.maxY - box.minY) * srcScale,
          toDeviceX(box.minX),
          toDeviceY(box.minY),
          destW,
          destH,
        );
        drew = true;
      }
    }
    return drew;
  }
}

/**
 * Paint a live, in-progress op straight onto the overlay.
 *
 * Live ink never goes through a tile: the stroke is still growing and the
 * pointer is waiting on it. Tiles only ever hold committed history.
 *
 * Caps are the same overlapping discs the committed stroke uses. Live used to
 * omit them (`capEnd: false`, head only when short) so a long stroke was a
 * butt-ended rectangle until lift glued half-discs on — and those half-discs
 * left a paper hairline on the butt.
 */
export type PaintLiveOpOptions = {
  fromIndex?: number;
  capEnd?: boolean;
  capHead?: boolean;
};

export function paintLiveOp(
  ctx: CanvasRenderingContext2D,
  op: InkOp,
  viewport: ViewportTransform,
  dpr: number,
  clip: SceneBounds | null,
  hosts: ScrollHostLookup = new Map(),
  options?: PaintLiveOpOptions,
): void {
  setInkSceneTransform(ctx, viewport, dpr);
  const pixelScale = viewport.zoom * dpr;
  const fromIndex = options?.fromIndex ?? 0;
  const capOptions = {
    capEnd: options?.capEnd ?? true,
    capHead: options?.capHead ?? fromIndex === 0,
  };
  const paint = () => {
    if (isHostBoundOp(op)) {
      const host = hosts.get(op.hostKey!);
      if (host) {
        applyInkOpInHost(
          ctx,
          op,
          host.bounds,
          hostScrollDx(op, host.scrollLeft, viewport.zoom),
          pixelScale,
          capOptions,
        );
      } else {
        applyInkOp(ctx, op, pixelScale, capOptions);
      }
      return;
    }
    if (fromIndex > 0 && op.kind === "draw") {
      applyInkOpFrom(ctx, op, fromIndex, pixelScale, capOptions);
      return;
    }
    applyInkOp(ctx, op, pixelScale, capOptions);
  };
  if (clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
    ctx.clip();
    paint();
    ctx.restore();
  } else {
    paint();
  }
}

/**
 * Host-bound committed ops after the tile blit — see {@link paintHostBoundOps}.
 */
export function paintHostBoundPass(
  ctx: CanvasRenderingContext2D,
  ops: readonly InkOp[],
  hosts: ScrollHostLookup,
  viewport: ViewportTransform,
  dpr: number,
  clip: SceneBounds | null,
): void {
  if (hosts.size === 0 && !ops.some(isHostBoundOp)) return;
  setInkSceneTransform(ctx, viewport, dpr);
  const pixelScale = viewport.zoom * dpr;
  if (clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
    ctx.clip();
    paintHostBoundOps(ctx, ops, hosts, pixelScale, undefined, viewport.zoom);
    ctx.restore();
  } else {
    paintHostBoundOps(ctx, ops, hosts, pixelScale, undefined, viewport.zoom);
  }
}
