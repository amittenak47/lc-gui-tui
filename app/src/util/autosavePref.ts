/**
 * Device-local preference: how often the board writes itself down.
 *
 * The autosave has always existed and has never been visible. That is a bad
 * combination for the one feature whose entire value is confidence — a writer
 * who cannot see it working has no reason to believe in it, and the report that
 * prompted this asked for "autosave in settings so notes don't get accidentally
 * discarded" for a board that was already autosaving every three seconds.
 *
 * So it is a setting, with the old three seconds as the default, and turning it
 * off is allowed: it is the writer's call whether a notebook they are still
 * making up their mind about should be committing itself to the library.
 *
 * Note what the autosave is *not*. It survives a crash or a closed lid; it does
 * not decide what the writer meant to keep. Discard still rolls back to the
 * session's baseline, autosaved or not — see `whiteboardBaselineRef` in App.
 */

const KEY = "whiteboard.autosave.ms";

/** Off, or how many milliseconds between writes. */
export type AutosaveInterval = 0 | 3000 | 15000 | 60000;

export const AUTOSAVE_DEFAULT_MS: AutosaveInterval = 3000;

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
