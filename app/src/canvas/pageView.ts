/**
 * One page at a time, like a PDF.
 *
 * On a tablet the board is paged: Problem & constraints, Code, Approach,
 * Complexity, Walkthrough. Fitting the viewport to one dashed frame was not
 * enough — the neighbouring frames still peeked in at the edges, and zooming
 * out put the whole stacked column back on screen. A page has to *be* a page.
 *
 * The scene is never rewritten to get there. Off-page elements stay exactly
 * where they are, at `opacity: 0` and `locked` so nothing can be nudged by a
 * palm, with their real values parked in `customData.lcPage`. Everything that
 * reads the board — capture, the coach's thumbnails, `board.json` — goes
 * through {@link clearPageVisibility} first, so paging is invisible to them and
 * a saved board can never carry a hidden element back to the desktop.
 *
 * Membership is by tag when the element carries one (`lcRegion`) and by centre
 * point otherwise, measured against the *live* frames — the student can resize
 * a region, and a page has to follow the box they can see.
 */

import { PAGE_BREAK, REGIONS, REGION_GUTTER, type RegionId } from "../templates/regions";

/** What an element needs to have for paging to place and hide it. */
export interface PageableElement {
  id: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  opacity?: number;
  locked?: boolean;
  isDeleted?: boolean;
  customData?: Record<string, unknown> | null;
  [key: string]: unknown;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the hidden element's real `opacity` / `locked` are parked. */
interface ParkedState {
  opacity: number;
  locked: boolean;
}

const PAGE_KEY = "lcPage";

/** Frame rectangles as they are right now, falling back to the authored ones. */
function frameRects(elements: readonly PageableElement[]): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  for (const element of elements) {
    if (element.isDeleted) continue;
    const meta = element.customData;
    if (!meta?.lcRegionFrame) continue;
    const region = meta.lcRegion;
    if (typeof region !== "string") continue;
    const authored = REGIONS[region as RegionId];
    rects.set(region, {
      x: num(element.x, authored?.x ?? 0),
      y: num(element.y, authored?.y ?? 0),
      w: num(element.width, authored?.w ?? 0),
      h: num(element.height, authored?.h ?? 0),
    });
  }
  if (rects.size === 0) {
    for (const region of Object.values(REGIONS)) {
      rects.set(region.id, { x: region.x, y: region.y, w: region.w, h: region.h });
    }
  }
  return rects;
}

/**
 * The region an element sits in: its tag if it has one, otherwise the frame its
 * centre falls inside — and, for something dropped in the gutter *between*
 * frames, the nearest one.
 *
 * The gutter case matters: a note written just under the Problem box would
 * otherwise belong to no page and show on all five, which is the one thing a
 * page turner must not do. Only work outside the board's frames entirely stays
 * unassigned, and that stays visible rather than disappearing into a page the
 * student cannot turn to.
 */
export function regionOfElement(
  element: PageableElement,
  rects: Map<string, Rect>,
): string | null {
  const tagged = element.customData?.lcRegion;
  if (typeof tagged === "string") return tagged;
  const x = num(element.x, NaN);
  const y = num(element.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cx = x + num(element.width, 0) / 2;
  const cy = y + num(element.height, 0) / 2;

  let nearest: string | null = null;
  let nearestDistance = Infinity;
  for (const [region, rect] of rects) {
    if (cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h) {
      return region;
    }
    const dx = Math.max(rect.x - cx, 0, cx - (rect.x + rect.w));
    const dy = Math.max(rect.y - cy, 0, cy - (rect.y + rect.h));
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = region;
    }
  }
  // A gap is one page break wide; anything further out is off the board.
  return nearestDistance <= GUTTER_REACH ? nearest : null;
}

/**
 * How far outside a frame still counts as that frame's page.
 *
 * Half a `PAGE_BREAK` is the distance from a frame edge to the middle of the gap
 * below it, so the two neighbours split the break between them and every point
 * in it belongs to somebody. Anything beyond that is off the board.
 *
 * It has to track `PAGE_BREAK` rather than `REGION_GUTTER`: when the vertical
 * break grew past the gutter, the middle of every gap stopped belonging to any
 * page — and an element that belongs to no page is shown on *all* of them, which
 * is the one thing a page turner must not do.
 */
const GUTTER_REACH = Math.max(REGION_GUTTER, PAGE_BREAK / 2);

/**
 * Hide everything that is not on `page`, or reveal everything when `page` is
 * `null` (desktop). Returns `null` when the scene already looks like that, so
 * the caller can skip the `updateScene` — this runs inside `onChange`.
 */
export function applyPageVisibility<T extends PageableElement>(
  elements: readonly T[],
  page: string | null,
): T[] | null {
  const rects = page ? frameRects(elements) : new Map<string, Rect>();
  let changed = false;
  const next = elements.map((element) => {
    if (element.isDeleted) return element;
    const parked = parkedState(element);
    const region = page === null ? null : regionOfElement(element, rects);
    const shouldHide = region !== null && region !== page;

    if (shouldHide) {
      if (parked) return element;
      changed = true;
      return {
        ...element,
        opacity: 0,
        locked: true,
        customData: {
          ...(element.customData ?? {}),
          [PAGE_KEY]: {
            opacity: num(element.opacity, 100),
            locked: element.locked === true,
          } satisfies ParkedState,
        },
      };
    }

    if (!parked) return element;
    changed = true;
    return restore(element, parked);
  });
  return changed ? next : null;
}

/** The board as it really is: every parked value put back. */
export function clearPageVisibility<T extends PageableElement>(elements: readonly T[]): T[] {
  return elements.map((element) => {
    const parked = parkedState(element);
    return parked ? restore(element, parked) : element;
  });
}

/** True when anything in the scene is currently hidden by paging. */
export function hasPagedElements(elements: readonly PageableElement[]): boolean {
  return elements.some((element) => parkedState(element) !== null);
}

function restore<T extends PageableElement>(element: T, parked: ParkedState): T {
  const { [PAGE_KEY]: _parked, ...rest } = (element.customData ?? {}) as Record<string, unknown>;
  return {
    ...element,
    opacity: parked.opacity,
    locked: parked.locked,
    customData: Object.keys(rest).length > 0 ? rest : null,
  };
}

function parkedState(element: PageableElement): ParkedState | null {
  const raw = element.customData?.[PAGE_KEY];
  if (!raw || typeof raw !== "object") return null;
  const parked = raw as Partial<ParkedState>;
  return {
    opacity: typeof parked.opacity === "number" ? parked.opacity : 100,
    locked: parked.locked === true,
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The band of scene the camera is showing, top to bottom.
 *
 * Excalidraw's screen→scene mapping is `sceneY = clientY / zoom - scrollY`, so
 * the top of the viewport is `-scrollY` and the bottom is one viewport height
 * further on *in scene units* — the height has to be divided by the zoom before
 * it means anything on the board. Its own kept function because getting either
 * the sign or the division wrong still produces a plausible-looking number, and
 * the only symptom is a page label that names the wrong page.
 *
 * `null` for a camera that cannot be showing anything: no height yet (the board
 * mounts before it is measured) or a zoom of zero.
 */
export function viewportBand(
  scrollY: number,
  zoom: number,
  viewHeight: number,
): { top: number; bottom: number } | null {
  if (!(viewHeight > 0) || !(zoom > 0)) return null;
  // `-0` is a distinct value in JavaScript: it survives arithmetic, fails an
  // `Object.is` comparison against `0`, and renders as "-0" in a style string.
  // An unscrolled board is the common case, so normalise it away here.
  const top = scrollY === 0 ? 0 : -scrollY;
  return { top, bottom: top + viewHeight / zoom };
}

/**
 * Which page a freely-scrolling reader is looking at.
 *
 * Desktop does not turn pages — it scrolls the whole stack — so "where am I" has
 * to be read back off the camera. The answer is the page filling most of the
 * viewport, which is the one a reader would name: it changes at the halfway
 * point of a scroll between two sheets, and a short page that fits entirely on
 * screen still wins over the slivers of its neighbours above and below.
 *
 * Scene coordinates, so the caller converts once from the camera and this stays
 * a pure function. Returns `null` when the viewport is over no page at all —
 * off the top of the board, or in a page break wide enough to fill the screen.
 */
export function pageAtViewport(
  elements: readonly PageableElement[],
  order: readonly RegionId[],
  viewTop: number,
  viewBottom: number,
): RegionId | null {
  if (!(viewBottom > viewTop)) return null;
  const rects = frameRects(elements);

  let best: RegionId | null = null;
  let bestOverlap = 0;
  for (const region of order) {
    const rect = rects.get(region);
    if (!rect) continue;
    const overlap =
      Math.min(viewBottom, rect.y + rect.h) - Math.max(viewTop, rect.y);
    // Strictly greater, so an exact tie keeps the earlier page in reading order.
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = region;
    }
  }
  return best;
}

/**
 * Scene box of the open page, for clipping the raster ink layer to it.
 *
 * Padded by half a gutter so pen ink follows the same rule as elements: each
 * gutter is split between its two neighbours, so a stroke that runs just past
 * the frame edge shows on one page rather than on none.
 */
export function pageBounds(
  elements: readonly PageableElement[],
  page: string | null,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!page) return null;
  const rect = frameRects(elements).get(page);
  if (!rect) return null;
  const pad = REGION_GUTTER / 2;
  return {
    minX: rect.x - pad,
    minY: rect.y - pad,
    maxX: rect.x + rect.w + pad,
    maxY: rect.y + rect.h + pad,
  };
}
