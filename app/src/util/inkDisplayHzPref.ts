/**
 * Device-local display refresh for ink HUD and live present cap.
 */

import {
  INK_DISPLAY_HZ,
  INK_DISPLAY_HZ_PREF_DEFAULT,
  type InkDisplayHz,
  type InkDisplayHzPref,
} from "../canvas/inkLab/displayHz";

export {
  INK_DISPLAY_HZ,
  INK_DISPLAY_HZ_PREF_DEFAULT,
  type InkDisplayHz,
  type InkDisplayHzPref,
};

const KEY = "whiteboard.inkDisplayHz";
const MATCH_KEY = "whiteboard.inkMatchDisplay";

export const INK_DISPLAY_HZ_EVENT = "lc-ink-display-hz";

function emit(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(INK_DISPLAY_HZ_EVENT));
  }
}

function parsePref(raw: string | null): InkDisplayHzPref {
  if (raw === "auto" || raw == null || raw === "") return "auto";
  const n = Number(raw);
  if ((INK_DISPLAY_HZ as readonly number[]).includes(n)) return n as InkDisplayHz;
  return INK_DISPLAY_HZ_PREF_DEFAULT;
}

export function loadInkDisplayHz(): InkDisplayHzPref {
  try {
    return parsePref(localStorage.getItem(KEY));
  } catch {
    return INK_DISPLAY_HZ_PREF_DEFAULT;
  }
}

export function saveInkDisplayHz(pref: InkDisplayHzPref): void {
  try {
    localStorage.setItem(KEY, String(pref));
  } catch {
    /* private browsing */
  }
  emit();
}

/** Present every dirty vsync. Off (default) keeps the 60fps cap on 90Hz+. */
export function loadInkMatchDisplay(): boolean {
  try {
    return localStorage.getItem(MATCH_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveInkMatchDisplay(on: boolean): void {
  try {
    localStorage.setItem(MATCH_KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
  emit();
}
