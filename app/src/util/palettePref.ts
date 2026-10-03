/**
 * What kind of colours the wheel should ask for.
 *
 * The palette feed was queried with an empty `tags`, which is not "no
 * preference" so much as "whatever the site is sorting by" — and what came
 * back was pastel after pastel. The feed takes a tag, so this is a question the
 * reader can answer once rather than a shuffle they keep re-rolling.
 *
 * `any` sends no tag, which is the old behaviour kept deliberately as the
 * default: a preference nobody asked for should not narrow what they get.
 */

const KEY = "whiteboard.palette.tag";
const PREFS_KEY = "whiteboard.palette.v1";

/**
 * The tags worth offering, in the feed's own vocabulary.
 *
 * A subset, not the whole list: these are the ones that describe *ink*. The
 * site also tags by occasion — christmas, wedding — which say nothing about
 * whether a colour reads on a page you are writing on.
 */
export const PALETTE_TAGS = [
  "any",
  "pastel",
  "vintage",
  "retro",
  "neon",
  "light",
  "dark",
  "warm",
  "cold",
  "nature",
  "earth",
  "sunset",
  "space",
] as const;

export type PaletteTag = (typeof PALETTE_TAGS)[number];

export interface PalettePrefs {
  tags: PaletteTag[];
  matchAll: boolean;
  mixColours: boolean;
}

export function isPaletteTag(value: unknown): value is PaletteTag {
  return typeof value === "string" && (PALETTE_TAGS as readonly string[]).includes(value);
}

export function loadPaletteTag(): PaletteTag {
  return loadPalettePrefs().tags[0] ?? "any";
}

/** Canonical order makes equality, caching and tag rotation independent of clicks. */
export function normalizePalettePrefs(value: unknown): PalettePrefs {
  const prefs = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<PalettePrefs> : {};
  const input = typeof value === "string" ? [value] : Array.isArray(value) ? value : prefs.tags;
  const chosen = new Set(Array.isArray(input) ? input.filter(isPaletteTag) : []);
  const tags = chosen.has("any") ? ["any" as const] : PALETTE_TAGS.filter(tag => chosen.has(tag));
  return { tags: tags.length ? tags : ["any"], matchAll: prefs.matchAll === true, mixColours: prefs.mixColours === true };
}

export function loadPalettePrefs(): PalettePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      try { return normalizePalettePrefs(JSON.parse(raw)); } catch { /* try the old single tag */ }
    }
    return normalizePalettePrefs(localStorage.getItem(KEY));
  } catch {
    return normalizePalettePrefs(null);
  }
}

export function savePaletteTag(tag: PaletteTag): void {
  savePalettePrefs(normalizePalettePrefs(tag));
}

export function savePalettePrefs(prefs: PalettePrefs): void {
  try {
    const next = normalizePalettePrefs(prefs);
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    // An older build can still use the first selected tag.
    localStorage.setItem(KEY, next.tags[0]!);
  } catch {
    /* private browsing */
  }
}

export function togglePaletteTag(prefs: PalettePrefs, tag: PaletteTag): PalettePrefs {
  const tags = tag === "any" ? [tag] : prefs.tags.includes(tag)
    ? prefs.tags.filter(value => value !== tag)
    : [...prefs.tags.filter(value => value !== "any"), tag];
  return normalizePalettePrefs({ ...prefs, tags });
}

/** What the feed's `tags` field should carry. `any` means no preference. */
export function paletteTagQuery(tag: PaletteTag): string {
  return tag === "any" ? "" : tag;
}

/** Title case for the picker; "any" reads as a choice, not a missing value. */
export function paletteTagLabel(tag: PaletteTag): string {
  if (tag === "any") return "All";
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}
