/** `two-sum` → `Two Sum`; `…-ii` → `… II` (roman numeral segments). */
export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((word) => titleWord(word))
    .filter(Boolean)
    .join(" ");
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
  return lower[0].toUpperCase() + lower.slice(1);
}
