/**
 * Local preference: which palm zone the near-pen chrome sits in.
 *
 * The colour radial tilts away from the writing hand in JS. Ink toolbar,
 * preset editor and annotation toggle layout use CSS. App chrome (header,
 * agent panel and general menus) uses the separate UI hand preference. This
 * preference is published as `data-handedness` on the document element and the
 * stylesheet mirrors the chrome across the Y-axis from there. Portalled chrome
 * (message menus, sheets) lands outside the app subtree, which is the reason
 * the attribute goes on the root rather than on `.lc-app`.
 */

export type InkHandedness = "right" | "left";

const KEY = "whiteboard.inkHandedness";

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

/**
 * Publish the preference to CSS as `data-handedness` on `<html>`.
 *
 * Only `left` is written. A right-handed layout is the one the stylesheet
 * already describes, so stamping `data-handedness="right"` would add an
 * attribute that no rule matches and invite selectors that need both spellings.
 */
export function applyHandednessAttr(value: InkHandedness): void {
  const root = document.documentElement;
  if (value === "left") root.setAttribute("data-handedness", "left");
  else root.removeAttribute("data-handedness");
}

/**
 * Keep the attribute in step with Settings for the life of the app.
 *
 * Settings dispatches `lc-ink-handedness` on save; the initial read happens
 * here so the very first paint is already mirrored. Returns a teardown.
 */
export function installHandednessAttr(): () => void {
  applyHandednessAttr(loadInkHandedness());
  const onChange = (event: Event) => {
    const next = (event as CustomEvent<InkHandedness>).detail;
    applyHandednessAttr(next === "left" || next === "right" ? next : loadInkHandedness());
  };
  window.addEventListener("lc-ink-handedness", onChange);
  return () => window.removeEventListener("lc-ink-handedness", onChange);
}
