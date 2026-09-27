/**
 * What the tab strip comes back as on launch.
 *
 *   - **restore** — every chip, and the tab (or split) you were on. The default,
 *     and the only behaviour there used to be.
 *   - **home** — every chip, but land on Home. Parked chips are records, not
 *     mounted workspaces, so nothing heavy opens until you tap one.
 *   - **fresh** — Home alone. The previous strip is let go on the first save.
 *
 * Only the strip. Notebooks, documents and their ink live in the libraries
 * either way; this never touches them.
 */

import { HOME_TAB_ID, initialTabState, type TabState } from "./tabs";

export type StartupTabs = "restore" | "home" | "fresh";

const KEY = "whiteboard.startupTabs.v1";

export const STARTUP_TABS_CHOICES: readonly StartupTabs[] = ["restore", "home", "fresh"];

export function isStartupTabs(value: unknown): value is StartupTabs {
  return value === "restore" || value === "home" || value === "fresh";
}

export function loadStartupTabs(): StartupTabs {
  try {
    const raw = localStorage.getItem(KEY);
    return isStartupTabs(raw) ? raw : "restore";
  } catch {
    return "restore";
  }
}

export function saveStartupTabs(value: StartupTabs): void {
  try {
    localStorage.setItem(KEY, isStartupTabs(value) ? value : "restore");
  } catch {
    /* storage unavailable — launch keeps restoring */
  }
}

/** The saved strip, cut down to what this launch should open. */
export function startupTabState(saved: TabState, mode: StartupTabs, at = 0): TabState {
  switch (mode) {
    case "restore":
      return saved;
    case "home":
      return saved.activeId === HOME_TAB_ID ? saved : { ...saved, activeId: HOME_TAB_ID };
    case "fresh":
      return initialTabState(saved.tabs.find((tab) => tab.id === HOME_TAB_ID)?.lastActive ?? at);
  }
}
