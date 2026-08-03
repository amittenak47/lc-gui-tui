/**
 * Remember whether the drawing toolbar is docked in the bottom chrome slot or
 * floating freely over the workspace.
 */

const STORAGE_KEY = "lc.toolbar.layout.v1";

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
