/**
 * Remember whether the drawing toolbar is docked in the bottom chrome slot or
 * floating freely over the workspace.
 */

const STORAGE_KEY = "whiteboard.toolbar.layout.v1";

export type ToolbarLayout =
  | { mode: "docked" }
  | { mode: "floating"; x: number; y: number };

const DOCKED: ToolbarLayout = { mode: "docked" };

export function loadToolbarLayout(): ToolbarLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DOCKED;
    const parsed = JSON.parse(raw) as Partial<ToolbarLayout> & { x?: number; y?: number };
    if (parsed.mode === "floating" && typeof parsed.x === "number" && typeof parsed.y === "number") {
      return { mode: "floating", x: parsed.x, y: parsed.y };
    }
  } catch {
    /* private browsing / corrupt */
  }
  return DOCKED;
}

export function saveToolbarLayout(layout: ToolbarLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* private browsing */
  }
}

/** How close (px) the toolbar centre must be to the dock slot to snap home. */
export const TOOLBAR_DOCK_SNAP_PX = 72;

/** Centre within this of a side edge → column. */
export const TOOLBAR_SIDE_BAND_PX = 96;
/** Stay in the previous axis until the centre clears the band by this much. */
export const TOOLBAR_SIDE_HYSTERESIS_PX = 28;
/** Extra left inset so a vertical island does not cover the annotate toggle. */
export const TOOLBAR_LEFT_CHROME_INSET_PX = 52;
/**
 * Assumed row length before the island has ever been measured as a row.
 *
 * Only used on a cold start that begins narrow, where there is no row to read.
 */
export const TOOLBAR_ROW_FALLBACK_PX = 320;
/**
 * Room the row needs beyond itself.
 *
 * Not decoration, and not a guess: the row is laid out *between* two rails it
 * must not touch — the annotate toggle on the left and the view stack on the
 * right — inside a control strip held 10 px off each board edge, with a gap
 * either side. 10 + 52 + 6 + 6 + 50 + 10. Counting only the row's own length
 * let a 450 px window keep a 350 px row that then ran under the view stack.
 */
export const TOOLBAR_ROW_MARGIN_PX = 136;
/** Once a column, stay one until the window clears the flip width by this much. */
export const TOOLBAR_ROW_HYSTERESIS_PX = 48;

/**
 * Is the app window too narrow to lay the island out as a row?
 *
 * The question is about the *window*, not the pane the island happens to be
 * drawn over. One island serves a whole split — it is docked in chrome that
 * spans `.lc-main` — so measuring the board under it meant the thin half of a
 * split turned the toolbar sideways while there was still most of a window to
 * lay it in. Worse, the board it measured was `querySelector(".lc-board")`,
 * which is the *first* pane in the DOM whichever pane has focus: a wide right
 * pane inherited the narrow left one's answer.
 *
 * So: compare the window against the length the row actually wants. `rowWidth`
 * is the island's own measured row, so a toolbar that grows a button raises its
 * own flip point instead of drifting away from a hard-coded one.
 */
export function toolbarWindowIsNarrow(
  viewWidth: number,
  rowWidth: number,
  previous: "row" | "column" = "row",
): boolean {
  if (!(viewWidth > 0)) return false;
  const want =
    Math.max(TOOLBAR_ROW_FALLBACK_PX, rowWidth > 0 ? rowWidth : 0) +
    TOOLBAR_ROW_MARGIN_PX;
  const flip = previous === "column" ? want + TOOLBAR_ROW_HYSTERESIS_PX : want;
  return viewWidth < flip;
}

export function toolbarAxis(
  mode: "docked" | "floating",
  x: number,
  width: number,
  viewWidth: number,
  dockNear: boolean,
  previous: "row" | "column" = "row",
  rowWidth: number = 0,
): "row" | "column" {
  if (toolbarWindowIsNarrow(viewWidth, rowWidth, previous)) return "column";
  if (mode === "docked" || dockNear) return "row";
  const cx = x + width / 2;
  const enter = TOOLBAR_SIDE_BAND_PX;
  const leave = TOOLBAR_SIDE_BAND_PX + TOOLBAR_SIDE_HYSTERESIS_PX;
  const inEnter = cx < enter || cx > viewWidth - enter;
  const inLeave = cx <= leave || cx >= viewWidth - leave;
  if (previous === "column") return inLeave ? "column" : "row";
  return inEnter ? "column" : "row";
}

export interface EdgeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Shortest distance between two rectangles; 0 when they touch or overlap. */
export function rectGap(a: EdgeRect, b: EdgeRect): number {
  const dx = Math.max(0, a.left - b.right, b.left - a.right);
  const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
  return Math.hypot(dx, dy);
}

/**
 * Is the island close enough to the dock slot to drop into it?
 *
 * Edge distance, not centre distance. A column island is several hundred px
 * tall; its centre sits that far from the slot's centre even when the two are
 * overlapping, so centre-to-centre made a sideways toolbar impossible to redock
 * in a short window — the clamp would not let it fall far enough for its middle
 * to reach. Edges do not care how big either box is.
 */
export function isNearDock(
  island: EdgeRect,
  anchor: EdgeRect,
  snapPx: number = TOOLBAR_DOCK_SNAP_PX,
): boolean {
  return rectGap(island, anchor) < snapPx;
}

export interface ClampBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Keep a floating island inside `box` (board hole, or the window). */
export function clampToBox(
  x: number,
  y: number,
  width: number,
  height: number,
  box: ClampBox,
  margin = 8,
): { x: number; y: number } {
  const minX = box.left + margin;
  const minY = box.top + margin;
  const maxX = Math.max(minX, box.right - width - margin);
  const maxY = Math.max(minY, box.bottom - height - margin);
  return {
    x: Math.min(maxX, Math.max(minX, x)),
    y: Math.min(maxY, Math.max(minY, y)),
  };
}
