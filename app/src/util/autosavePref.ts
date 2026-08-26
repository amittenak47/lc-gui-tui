/**
 * Device-local preference: how often the board writes itself down.
 *
 * The autosave has always existed and has never been visible. That is a bad
 * combination for the one feature whose entire value is confidence — a writer
 * who cannot see it working has no reason to believe in it, and the report that
 * prompted this asked for "autosave in settings so notes don't get accidentally
 * discarded" for a board that was already autosaving every three seconds.
 *
 * So it is a setting, and turning it off is allowed: it is the writer's call
 * whether a notebook they are still making up their mind about should be
 * committing itself to the library. Off is the default — a board the writer has
 * not asked to save should not save itself until they say so.
 *
 * Note what the autosave is *not*. It survives a crash or a closed lid; it does
 * not decide what the writer meant to keep. Discard still rolls back to the
 * session's baseline, autosaved or not — see `whiteboardBaselineRef` in App.
 */

const KEY = "whiteboard.autosave.ms";

/** Off, or how many milliseconds between writes. */
export type AutosaveInterval = 0 | 3000 | 15000 | 60000;

export const AUTOSAVE_DEFAULT_MS: AutosaveInterval = 0;

export const AUTOSAVE_CHOICES: ReadonlyArray<[AutosaveInterval, string]> = [
  [0, "Off"],
  [3000, "3s"],
  [15000, "15s"],
  [60000, "1m"],
];

export const AUTOSAVE_EVENT = "lc-autosave-interval";

function isInterval(value: number): value is AutosaveInterval {
  return AUTOSAVE_CHOICES.some(([ms]) => ms === value);
}

export function loadAutosaveInterval(): AutosaveInterval {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return AUTOSAVE_DEFAULT_MS;
    const value = Number(raw);
    return isInterval(value) ? value : AUTOSAVE_DEFAULT_MS;
  } catch {
    return AUTOSAVE_DEFAULT_MS;
  }
}

export function saveAutosaveInterval(ms: AutosaveInterval): void {
  try {
    localStorage.setItem(KEY, String(ms));
  } catch {
    /* private browsing */
  }
}

const BANNER_KEY = "whiteboard.autosave.banner";

/**
 * Whether a successful autosave raises the chrome banner.
 *
 * The write always happens. This only answers whether the page should say so.
 * Parked tabs (open, not on screen, not in the focused split) stay silent so
 * a background notebook cannot flash “Saved” over the pad you are looking at.
 * A split pair shares one banner: the second pane must not replace the first.
 */
export type AutosaveBanner = "on" | "off";

export const AUTOSAVE_BANNER_DEFAULT: AutosaveBanner = "on";

export const AUTOSAVE_BANNER_CHOICES: ReadonlyArray<[AutosaveBanner, string, string]> = [
  [
    "on",
    "On screen",
    "Show Saved on the focused pad. A split pair shares one banner. Parked tabs still write, silently.",
  ],
  ["off", "Hide", "Writes still happen. Nothing pops up."],
];

function isBanner(value: string): value is AutosaveBanner {
  return value === "on" || value === "off";
}

export function loadAutosaveBanner(): AutosaveBanner {
  try {
    const raw = localStorage.getItem(BANNER_KEY);
    if (raw == null) return AUTOSAVE_BANNER_DEFAULT;
    return isBanner(raw) ? raw : AUTOSAVE_BANNER_DEFAULT;
  } catch {
    return AUTOSAVE_BANNER_DEFAULT;
  }
}

export function saveAutosaveBanner(value: AutosaveBanner): void {
  try {
    localStorage.setItem(BANNER_KEY, value);
  } catch {
    /* private browsing */
  }
}

/** Parked / off-screen chips never own the strip. Split partners share it. */
export function autosaveBannerAllowed(tabId: string, visibleIds: string[]): boolean {
  return visibleIds.includes(tabId);
}

/**
 * One Saved banner per beat. A split pair saving on the same tick must not
 * flip “Saved A” into “Saved B”.
 */
export function coalesceAutosaveNotice(
  current: string | null,
  title: string,
  split: boolean,
): string {
  if (current && current.startsWith("Saved")) return current;
  return split ? "Saved." : `Saved “${title}”.`;
}
