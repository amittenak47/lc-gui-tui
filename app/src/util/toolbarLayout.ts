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

export function toolbarAxis(
  mode: "docked" | "floating",
  x: number,
  width: number,
  viewWidth: number,
  dockNear: boolean,
  previous: "row" | "column" = "row",
): "row" | "column" {
  if (mode === "docked" || dockNear) return "row";
  const cx = x + width / 2;
  const enter = TOOLBAR_SIDE_BAND_PX;
  const leave = TOOLBAR_SIDE_BAND_PX + TOOLBAR_SIDE_HYSTERESIS_PX;
  const inEnter = cx < enter || cx > viewWidth - enter;
  const inLeave = cx <= leave || cx >= viewWidth - leave;
  if (previous === "column") return inLeave ? "column" : "row";
  return inEnter ? "column" : "row";
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
