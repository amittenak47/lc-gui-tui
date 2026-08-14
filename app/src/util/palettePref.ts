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

export function isPaletteTag(value: unknown): value is PaletteTag {
  return typeof value === "string" && (PALETTE_TAGS as readonly string[]).includes(value);
}

export function loadPaletteTag(): PaletteTag {
  try {
    const raw = localStorage.getItem(KEY);
    return isPaletteTag(raw) ? raw : "any";
  } catch {
    return "any";
  }
}

export function savePaletteTag(tag: PaletteTag): void {
  try {
    localStorage.setItem(KEY, tag);
  } catch {
    /* private browsing */
  }
}

/** What the feed's `tags` field should carry. `any` means no preference. */
export function paletteTagQuery(tag: PaletteTag): string {
  return tag === "any" ? "" : tag;
}

/** Title case for the picker; "any" reads as a choice, not a missing value. */
export function paletteTagLabel(tag: PaletteTag): string {
  if (tag === "any") return "Any";
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}
