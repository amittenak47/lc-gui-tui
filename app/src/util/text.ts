/**
 * `two-sum` → `Two Sum`; `…-ii` → `… II` (roman numeral segments).
 *
 * Synthetic corpora (KodCode) bake a seed number and style letter into the
 * slug (`running-max-45219-c`). Those duplicate the q# column, so they are
 * stripped for display. Leading digit-only segments (a LeetCode number baked
 * into a seed name) are dropped too. Multi-letter roman tails (`ii`, `iii`)
 * stay — that is how LeetCode names variants.
 */
export function titleFromSlug(slug: string, _questionId?: string | null): string {
  const parts = displaySlugParts(slug);
  return parts.map((word) => titleWord(word)).filter(Boolean).join(" ");
}

/** Slug segments that belong in a human title (after dropping id noise). */
export function displaySlugParts(slug: string): string[] {
  let parts = slug.split("-").filter(Boolean);
  if (parts.length === 0) return parts;

  // KodCode style letter: trailing single `c` / `i` (not `ii` / `iii` romans).
  const style = parts[parts.length - 1]?.toLowerCase();
  if (style === "c" || style === "i") {
    parts = parts.slice(0, -1);
  }

  // Trailing seed number (synthetic ids end `…-{n}-c`; n matches q#).
  const tail = parts[parts.length - 1];
  if (tail && /^\d+$/.test(tail)) {
    parts = parts.slice(0, -1);
  }

  // Leading digit-only tokens: `101-symmetric-tree` → Symmetric Tree.
  // Keep at least one word so a degenerate slug still shows something.
  while (parts.length > 1 && /^\d+$/.test(parts[0]!)) {
    parts = parts.slice(1);
  }

  return parts;
}

/** Common LeetCode roman-numeral slug tails (and a few extras). */
const ROMAN_SEGMENTS = new Set([
  "i",
  "ii",
  "iii",
  "iv",
  "v",
  "vi",
  "vii",
  "viii",
  "ix",
  "x",
  "xi",
  "xii",
  "xiii",
  "xiv",
  "xv",
  "xvi",
  "xvii",
  "xviii",
  "xix",
  "xx",
]);

function titleWord(word: string): string {
  if (!word) return "";
  const lower = word.toLowerCase();
  if (ROMAN_SEGMENTS.has(lower)) return lower.toUpperCase();
  return lower[0]!.toUpperCase() + lower.slice(1);
}
