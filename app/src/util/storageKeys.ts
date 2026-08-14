/**
 * localStorage key names after the pad / surface rename.
 *
 * Boot copies `lc.*` onto these via {@link remapLcKey}, then modules only write
 * the new names. Dual-read of the old names is a one-release safety net if the
 * marker never landed.
 */

export const MIGRATED_MARKER = "whiteboard.migrated.v1";

/** Theme used to live at `lc-app-theme` (hyphen, not `lc.`). */
export const THEME_KEY = "whiteboard.app-theme";
export const LEGACY_THEME_KEY = "lc-app-theme";

/**
 * Map a pre-rename storage key onto its `whiteboard.*` name.
 *
 * Returns null when the key is already new, or is unrelated.
 */
export function remapLcKey(key: string): string | null {
  if (key === LEGACY_THEME_KEY) return THEME_KEY;
  if (key === MIGRATED_MARKER) return null;
  if (!key.startsWith("lc.")) return null;
  if (key.startsWith("lc.scratchpad.")) {
    return `whiteboard.notebook.${key.slice("lc.scratchpad.".length)}`;
  }
  if (key.startsWith("lc.md-ink.")) {
    return `whiteboard.annotate.${key.slice("lc.md-ink.".length)}`;
  }
  return `whiteboard.${key.slice("lc.".length)}`;
}

/** Read the new key, then any legacy spellings still sitting around. */
export function getStorageItem(key: string, ...legacy: string[]): string | null {
  try {
    const current = localStorage.getItem(key);
    if (current != null) return current;
    for (const old of legacy) {
      const value = localStorage.getItem(old);
      if (value != null) return value;
    }
  } catch {
    /* private browsing */
  }
  return null;
}
