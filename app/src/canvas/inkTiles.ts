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
  applyInkOpInHost,
  beginInkOpBatch,
  endInkOpBatch,
  HIGHLIGHT_WIDTH_SCALE,
  hostScrollDx,
  hostScrollDy,
  inkLineWidth,
  INK_SPEED_WIDTH_RANGE,
  INK_TIP_STEP,
  isHostBoundOp,
  paintHostBoundOps,
  setInkSceneTransform,
  type InkDrawOp,
  type InkOp,
  type SceneBounds,
  type ScrollHostLookup,
  type ViewportTransform,
} from "./rasterInk";
import { paintInkTile } from "./inkLab/tilePaint";
import {
  LEVEL_STEP,
  TILE_OVERLAP_PX,
  TILE_PX,
  inkTileCanvasPx,
  levelScale,
  tileSceneSize,
} from "./inkTileGrid";
import {
  blobFromTileSource,
  inkTilePersistKey,
  loadPersistedInkTiles,
  persistInkTile,
} from "./inkTileStore";

export {
  LEVEL_STEP,
  TILE_OVERLAP_PX,
  TILE_PX,
  inkTileCanvasPx,
  levelScale,
  tileSceneSize,
} from "./inkTileGrid";

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

/**
 * Scene box whose tiles we blit.
 *
 * Intersecting the camera with the page clip dropped the strip of screen that
 * sits outside a tight first-open frame. Lined paper still filled the hole;
 * writing stopped at a vertical cut. If the page is on screen, fill the camera.
 * A clip that misses the camera is a different page — skip.
 */
export function visibleDrawBounds(
  view: SceneBounds,
  clip: SceneBounds | null,
): SceneBounds | null {
  if (!clip) return view;
  if (!boundsOverlap(view, clip)) return null;
  return view;
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

/**
 * Scene box one op touches, padded by half the widest line it can carry.
 *
 * Not cached: a live stroke mutates `points` every frame, and a WeakMap keyed
 * on the op would freeze the first AABB.
 */
export function strokeAabb(op: InkOp, fromIndex = 0): SceneBounds {
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
  const points = op.points;
  const start = Math.max(0, Math.min(fromIndex, points.length));
  for (let i = start; i < points.length; i++) {
    const point = points[i]!;
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return minX === Infinity
    ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    : { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function inkOpBounds(op: InkOp): SceneBounds {
  const cached = opBoundsCache.get(op);
  if (cached) return cached;
  const bounds = strokeAabb(op);
  opBoundsCache.set(op, bounds);
  return bounds;
}

interface Tile {
  key: string;
  level: number;
  tx: number;
  ty: number;
  canvas: CanvasImageSource;
  width: number;
  height: number;
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
  /** True while foreground ink owns the frame; deferred tile work must yield. */
  pause?: () => boolean;
  /**
   * Raster tiles off the UI thread. Camera present waits for
   * {@link InkTileCache.covered} before swapping a bitmap; this only keeps
   * `draw` to blits.
   */
  useWorker?: boolean;
  /** Persist completed scene tiles so a full-quit reopen is a hydrate + blit. */
  persist?: boolean;
}

interface PendingTile {
  level: number;
  tx: number;
  ty: number;
}

export class InkTileCache {
  private ops: InkOp[] = [];
  private opBounds = new WeakMap<InkOp, SceneBounds>();
  private readonly tiles = new Map<string, Tile>();
  private readonly tilePx: number;
  private readonly onTilesReady?: () => void;
  private readonly createCanvas: (width: number, height: number) => HTMLCanvasElement;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => number;
  private readonly cancel: (handle: number) => void;
  private readonly pause: () => boolean;

  private clip: SceneBounds | null = null;
  private drawCount = 0;
  private budget = TILE_BUDGET_MIN;
  private pending: PendingTile[] = [];
  private visibleMisses = 1;
  private idleHandle = 0;
  private suspended = false;

  /** Stop the unfocused split's pump without polling every animation frame. */
  setSuspended(on: boolean): void {
    this.suspended = on;
    if (on && this.idleHandle) {
      this.cancel(this.idleHandle);
      this.idleHandle = 0;
    } else if (!on && !this.idleHandle && this.pending.length > 0) {
      this.idleHandle = this.schedule(() => this.runPending());
    }
  }
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
  private readonly useWorker: boolean;
  private readonly persist: boolean;
  private sig = "";
  private hydrating = false;
  private sliceVisible = false;
  private hydrateGen = 0;
  private inflight = new Set<string>();
  private workerGeneration = 0;
  private workerOps: readonly InkOp[] | null = null;
  private persistDirty = false;

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
    this.pause = options.pause ?? (() => false);
    this.useWorker = options.useWorker === true;
    this.persist = options.persist === true;
  }

  private boundsOf(op: InkOp): SceneBounds {
    const cached = this.opBounds.get(op);
    if (cached) return cached;
    const bounds = inkOpBounds(op);
    this.opBounds.set(op, bounds);
    return bounds;
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

    this.invalidateWorkerHistory();
    this.ops = next;
    // Nothing in common: a different notebook, or a clear. There is no cache
    // worth keeping and no flash to avoid — the page is changing wholesale.
    if (shared === 0) {
      this.invalidate();
      this.beginHydrate();
      return;
    }

    // Ops were removed or replaced. Both sides of the divergence matter: the
    // pixels that must come off, and the ones that must go on.
    let dirty: SceneBounds | null = null;
    const widen = (op: InkOp) => {
      const bounds = this.boundsOf(op);
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
    this.invalidateWorkerHistory();
    this.ops.push(op);
    if (isHostBoundOp(op)) return;
    const bounds = this.boundsOf(op);
    /*
     * Every tile below repaints the same op, and deriving that op's ribbon is
     * the expensive half of the work: styles, coalescing, densifying, pooling,
     * sides, fills. Only the rasterisation differs between tiles, so the batch
     * lets the derivation happen once and be reused for the rest.
     *
     * The window is exactly this synchronous loop — the op cannot change while
     * it runs, and `finally` closes the window even if a tile throws, so no
     * later draw can inherit a stale ribbon.
     */
    beginInkOpBatch();
    try {
      for (const tile of [...this.tiles.values()]) {
        const box = this.tileBounds(tile.level, tile.tx, tile.ty);
        const scale = levelScale(tile.level);
        if (!boundsOverlap(bounds, this.paddedTileBounds(box, scale))) continue;
        this.paintOpIntoTile(tile, op, box);
      }
    } finally {
      endInkOpBatch();
    }
  }

  /** Composite one op onto a tile that is already rasterised. */
  private boundedDrawRuns(op: InkDrawOp, bounds: SceneBounds): InkDrawOp[] {
    const points = op.points;
    if (points.length <= 256) return [op];
    const runs: InkDrawOp[] = [];
    let runStart = -1;
    const flush = (end: number) => {
      if (runStart < 0) return;
      const from = Math.max(0, runStart - 1);
      const to = Math.min(points.length, end + 1);
      runs.push({ ...op, points: points.slice(from, to) });
      runStart = -1;
    };
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const reach = Math.max(
        2,
        op.baseWidth * (op.highlight ? HIGHLIGHT_WIDTH_SCALE : 1),
        a.radius ?? 0,
        b.radius ?? 0,
      );
      const hits =
        Math.max(a.x, b.x) + reach >= bounds.minX &&
        Math.min(a.x, b.x) - reach <= bounds.maxX &&
        Math.max(a.y, b.y) + reach >= bounds.minY &&
        Math.min(a.y, b.y) - reach <= bounds.maxY;
      if (hits) {
        if (runStart < 0) runStart = i - 1;
      } else {
        flush(i);
      }
    }
    flush(points.length);
    return runs;
  }

  /**
   * Synchronise history without raster work or a geometry walk.
   *
   * Whiteboard mutations already changed the visible WebGL snap. Their cache
   * bookkeeping must stay off pointer-up / eraser-confirm; missing tiles are
   * rebuilt later by the atomic camera preparation.
   */
  syncOpsDeferred(ops: readonly InkOp[]): void {
    if (
      this.ops.length === ops.length &&
      this.ops.every((op, index) => op === ops[index])
    ) {
      return;
    }
    this.ops = [...ops];
    this.invalidate();
    this.persistDirty = true;
    this.beginHydrate();
  }

  /**
   * Record a committed op without raster work on the pointer-up stack.
   * The live WebGL host already contains those pixels; touched cache tiles are
   * rebuilt later, before the next atomic camera presentation.
   */
  deferOp(op: InkOp): void {
    this.invalidateWorkerHistory();
    this.ops.push(op);
    this.sig = this.contentSig();
    this.persistDirty = true;
    if (isHostBoundOp(op) || this.tiles.size === 0) return;
    const bounds = this.boundsOf(op);
    for (const [key, tile] of [...this.tiles]) {
      const box = this.tileBounds(tile.level, tile.tx, tile.ty);
      if (boundsOverlap(bounds, this.paddedTileBounds(box, levelScale(tile.level)))) this.tiles.delete(key);
    }
  }

  private paintBoundedOp(
    ctx: CanvasRenderingContext2D,
    op: InkOp,
    bounds: SceneBounds,
    scale: number,
  ): void {
    const points = op.points;
    // Short marks are cheaper to submit whole. Long page-covering scribbles
    // must not allocate/upload their entire WebGL spine once per visible tile.
    if (points.length <= 256) {
      applyInkOp(ctx, op, scale);
      return;
    }

    if (op.kind === "erase") {
      const r = Math.max(0, op.radius);
      const local = points.filter(
        (p) =>
          p.x + r >= bounds.minX &&
          p.x - r <= bounds.maxX &&
          p.y + r >= bounds.minY &&
          p.y - r <= bounds.maxY,
      );
      if (local.length > 0) applyInkOp(ctx, { ...op, points: local }, scale);
      return;
    }

    for (const run of this.boundedDrawRuns(op, bounds)) applyInkOp(ctx, run, scale);
  }

  private paintOpIntoTile(tile: Tile, op: InkOp, bounds: SceneBounds): void {
    const canvas = tile.canvas as HTMLCanvasElement;
    if (typeof canvas.getContext !== "function") {
      this.tiles.delete(tile.key);
      return;
    }
    const ctx = canvas.getContext("2d");
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
    this.paintBoundedOp(ctx, op, this.paddedTileBounds(bounds, scale), scale);
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
    this.beginHydrate();
  }

  invalidate(): void {
    this.invalidateWorkerHistory();
    this.tiles.clear();
    this.opBounds = new WeakMap<InkOp, SceneBounds>();
    this.pending = [];
    this.inflight.clear();
    this.hydrateGen += 1;
    this.hydrating = false;
    if (this.idleHandle) {
      this.cancel(this.idleHandle);
      this.idleHandle = 0;
    }
  }

  /** Drop only cached pixels touched by changed stroke geometry. */
  invalidateBounds(bounds: SceneBounds, op?: InkOp): void {
    this.invalidateWorkerHistory();
    if (op) this.opBounds.delete(op);
    for (const [key, tile] of [...this.tiles]) {
      const tileBounds = this.tileBounds(tile.level, tile.tx, tile.ty);
      const padded = this.paddedTileBounds(tileBounds, levelScale(tile.level));
      if (boundsOverlap(bounds, padded)) this.tiles.delete(key);
    }
  }

  dispose(): void {
    this.invalidate();
    this.ops = [];
  }

  private contentSig(): string {
    return inkTilePersistKey(this.ops, this.clip);
  }

  private beginHydrate(): void {
    this.sig = this.contentSig();
    if (!this.persist || !this.sig) return;
    const sig = this.sig;
    const gen = this.hydrateGen;
    this.hydrating = true;
    void loadPersistedInkTiles(sig)
      .then(async (rows) => {
        if (gen !== this.hydrateGen || this.sig !== sig) return;
        for (const row of rows) {
          const key = tileKey(row.level, row.tx, row.ty);
          if (this.tiles.has(key)) continue;
          if (typeof createImageBitmap !== "function") continue;
          let source: CanvasImageSource;
          try {
            source = await createImageBitmap(row.blob);
          } catch {
            continue;
          }
          if (gen !== this.hydrateGen || this.sig !== sig) return;
          this.tiles.set(key, {
            key,
            level: row.level,
            tx: row.tx,
            ty: row.ty,
            canvas: source,
            width: row.width,
            height: row.height,
            usedAt: this.drawCount,
            painted: true,
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        if (gen === this.hydrateGen) this.hydrating = false;
        this.onTilesReady?.();
      });
  }

  private installSource(
    level: number,
    tx: number,
    ty: number,
    source: CanvasImageSource,
  ): void {
    const key = tileKey(level, tx, ty);
    if (this.tiles.has(key)) return;
    const canvasPx = this.tileCanvasPx();
    const tile: Tile = {
      key,
      level,
      tx,
      ty,
      canvas: source,
      width: canvasPx,
      height: canvasPx,
      usedAt: this.drawCount,
      painted: true,
    };
    this.tiles.set(key, tile);
    this.schedulePersist(tile);
  }

  private schedulePersist(tile: Tile): void {
    if (!this.persist) return;
    const sig = this.sig || this.contentSig();
    this.sig = sig;
    void blobFromTileSource(tile.canvas, tile.width, tile.height).then((blob) => {
      if (!blob || this.sig !== sig) return;
      return persistInkTile(sig, {
        level: tile.level,
        tx: tile.tx,
        ty: tile.ty,
        blob,
        width: tile.width,
        height: tile.height,
      });
    });
  }

  private pumpWorker(): void {
    if (this.suspended) return;
    if (this.inflight.size > 0) return;
    const next = this.pending.shift();
    if (!next) {
      this.onTilesReady?.();
      return;
    }
    const key = tileKey(next.level, next.tx, next.ty);
    if (this.tiles.has(key)) {
      this.schedule(() => this.pumpWorker());
      return;
    }
    this.inflight.add(key);
    const generation = this.workerGeneration;
    // The client uses identity to decide whether to send history. Appends and
    // geometry edits must get a fresh snapshot, even if this.ops was mutated.
    const ops = this.workerOps ?? (this.workerOps = this.ops.slice());
    const clip = this.clip;
    void import("./inkLab/tileRasterClient")
      .then((mod) =>
        mod.rasterInkTileOffThread({
          ops,
          clip,
          level: next.level,
          tx: next.tx,
          ty: next.ty,
          tilePx: this.tilePx,
        }),
      )
      .then((bitmap) => {
        if (generation !== this.workerGeneration) {
          bitmap?.close();
          return;
        }
        this.inflight.delete(key);
        if (bitmap) this.installSource(next.level, next.tx, next.ty, bitmap);
        else if (!this.suspended) this.renderTile(next.level, next.tx, next.ty);
        this.evict();
        this.onTilesReady?.();
        if (!this.suspended && (this.pending.length > 0 || this.inflight.size > 0)) {
          this.idleHandle = this.schedule(() => this.runPending());
        }
      })
      .catch(() => {
        if (generation !== this.workerGeneration) return;
        this.inflight.delete(key);
        if (!this.suspended) this.renderTile(next.level, next.tx, next.ty);
        this.onTilesReady?.();
        if (!this.suspended && this.pending.length > 0) {
          this.idleHandle = this.schedule(() => this.runPending());
        }
      });
  }

  private invalidateWorkerHistory(): void {
    this.workerGeneration += 1;
    this.workerOps = null;
    this.inflight.clear();
  }

  /** Tiles currently held — for tests and for the metrics readout. */
  get size(): number {
    return this.tiles.size;
  }

  /** True while the last draw left tiles to rasterise in the background. */
  get settled(): boolean {
    return this.pending.length === 0 && this.inflight.size === 0 && !this.hydrating;
  }

  /**
   * True when the last draw blitted every visible tile from cache.
   *
   * Inflight work for tiles this view did not miss does not count. Persist
   * hydrate of the rest of the book is not coverage — that wait is the
   * 10–30s blank pad.
   */
  get covered(): boolean {
    // Shifting the last queued tile into a worker is not a completed blit.
    // Only draw() can establish coverage for its viewport.
    return this.visibleMisses === 0;
  }

  /**
   * Raster visible misses on the calling thread inside the draw budget.
   *
   * First present uses this under the overlay so the open camera is ink, not
   * a worker queue. Pan/zoom leave it off so those frames stay blits.
   */
  setSliceVisible(on: boolean): void {
    this.sliceVisible = on;
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
    return inkTileCanvasPx(this.tilePx);
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

    paintInkTile(
      ctx,
      {
        ops: this.ops,
        clip: this.clip,
        level,
        tx,
        ty,
        tilePx: this.tilePx,
      },
      (op) => this.boundsOf(op),
    );
    const tile: Tile = {
      key,
      level,
      tx,
      ty,
      canvas,
      width: canvasPx,
      height: canvasPx,
      usedAt: this.drawCount,
      painted: true,
    };
    this.tiles.set(key, tile);
    this.schedulePersist(tile);
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
    if (this.suspended) return;
    if (this.pending.length === 0 && this.inflight.size === 0) return;
    if (this.pause()) {
      this.idleHandle = this.schedule(() => this.runPending());
      return;
    }
    if (this.useWorker) {
      this.pumpWorker();
      return;
    }
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
    const visible = visibleDrawBounds(view, this.clip);
    if (!visible) {
      this.pending = [];
      this.visibleMisses = 0;
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

    const deadline = this.suspended || this.pause()
      ? this.now()
      : this.now() + (this.moving ? MOVING_BUDGET_MS : DRAW_BUDGET_MS);
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
      const canSlice =
        this.now() < deadline && (!this.useWorker || this.sliceVisible);
      if (!tile && canSlice) {
        tile = this.renderTile(level, tx, ty) ?? undefined;
      }
      if (!tile) {
        missed.push({ level, tx, ty });
        if (fallbacks === null) fallbacks = this.fallbackLevels(level);
        this.blitFallback(ctx, bounds, toDeviceX, toDeviceY, fallbacks);
        continue;
      }
      tile.usedAt = this.drawCount;
      /*
       * Snap each square to whole device pixels, taking both edges from the
       * tile's own bounds.
       *
       * The destination used to be a fractional origin plus a fractional size,
       * so neighbouring squares met partway through a pixel. The blit samples a
       * tile's edge texels against the transparency outside it, and the result
       * is a faint grid over the page wherever ink crosses a tile line -- the
       * seams visible in a filled area.
       *
       * Rounding both edges rather than the origin and a width is what makes it
       * exact: one square's `maxX` is the next one's `minX`, so they round to
       * the same integer and share an edge with nothing between them and
       * nothing doubled.
       */
      const x0 = Math.round(toDeviceX(bounds.minX));
      const y0 = Math.round(toDeviceY(bounds.minY));
      const x1 = Math.round(toDeviceX(bounds.maxX));
      const y1 = Math.round(toDeviceY(bounds.maxY));
      ctx.drawImage(
        tile.canvas,
        TILE_OVERLAP_PX,
        TILE_OVERLAP_PX,
        this.tilePx,
        this.tilePx,
        x0,
        y0,
        Math.max(1, x1 - x0),
        Math.max(1, y1 - y0),
      );
    }

    this.pending = missed;
    this.visibleMisses = missed.length;
    this.evict();
    if (missed.length === 0 && this.persistDirty) {
      this.persistDirty = false;
      for (const tile of this.tiles.values()) this.schedulePersist(tile);
    }
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
export function paintLiveOp(
  ctx: CanvasRenderingContext2D,
  op: InkOp,
  viewport: ViewportTransform,
  dpr: number,
  clip: SceneBounds | null,
  hosts: ScrollHostLookup = new Map(),
): void {
  setInkSceneTransform(ctx, viewport, dpr);
  const pixelScale = viewport.zoom * dpr;
  const capOptions = { capEnd: true, capHead: true, live: true };
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
          hostScrollDy(op, host.scrollTop ?? 0, viewport.zoom),
        );
        } else {
          applyInkOp(ctx, op, pixelScale, capOptions);
        }
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
