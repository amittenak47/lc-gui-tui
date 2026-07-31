/** Local preference: which palm zone the near-pen chrome sits in. */

export type InkHandedness = "right" | "left";

const KEY = "lc.inkHandedness";

export function loadInkHandedness(): InkHandedness {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "left" || raw === "right") return raw;
  } catch {
    /* ignore */
  }
  return "right";
}

export function saveInkHandedness(value: InkHandedness): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* ignore */
  }
}
