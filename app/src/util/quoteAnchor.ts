/**
 * Finding a quote again when its offsets have stopped meaning anything.
 *
 * A text anchor is `{start, end}` into a scope's character stream, which is
 * exact and free to resolve — as long as that stream is fixed. It is, for a PDF
 * page or a markdown file. It stopped being true for a web pad the moment its
 * identity became the URL: a second freeze replaces the captured HTML under the
 * same hash, so every offset recorded against the first capture now points into
 * a different string.
 *
 * This is the W3C `TextQuoteSelector`, and pairing it with the offsets is the
 * standard's own canonical shape — a `TextPositionSelector` *refinedBy* a
 * `TextQuoteSelector`. Offsets stay the finder; the quote is how a mark recovers
 * when they miss.
 *
 * `prefix` and `suffix` are what make it trustworthy. "Sign in" appears forty
 * times on a page; the words either side of the one you meant are what tell it
 * apart from the other thirty-nine.
 */

/** Characters of context kept each side. Enough to disambiguate, short to store. */
export const QUOTE_CONTEXT_CHARS = 32;

export interface QuoteSelector {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/** Read the quote and its surroundings out of a stream at a known position. */
export function quoteFromStream(
  text: string,
  start: number,
  end: number,
  context = QUOTE_CONTEXT_CHARS,
): QuoteSelector | null {
  if (!(start >= 0) || !(end > start) || end > text.length) return null;
  const exact = text.slice(start, end);
  if (!exact.trim()) return null;
  const prefix = text.slice(Math.max(0, start - context), start);
  const suffix = text.slice(end, Math.min(text.length, end + context));
  return {
    exact,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

/**
 * Where the quote is now, or null.
 *
 * Three passes, most specific first, because a confident wrong answer is worse
 * than an admitted miss:
 *
 * 1. `prefix + exact + suffix` — the phrase in its original surroundings.
 * 2. `exact` where it appears **once**. Unambiguous, so the context adds nothing.
 * 3. `exact` with whichever occurrence best matches the remembered context.
 *
 * Deliberately no fuzzy matching. A near-miss anchor puts a reader's note on
 * words they did not write it about, which is worse than telling them the words
 * are gone.
 */
export function findQuote(text: string, quote: QuoteSelector): { start: number; end: number } | null {
  const { exact } = quote;
  if (!exact) return null;

  const prefix = quote.prefix ?? "";
  const suffix = quote.suffix ?? "";
  if (prefix || suffix) {
    const needle = `${prefix}${exact}${suffix}`;
    const whole = text.indexOf(needle);
    /*
     * The context must also be *unique*, not merely present.
     *
     * On a page of near-identical rows the surroundings repeat as faithfully as
     * the phrase does, so matching them proves nothing — taking the first hit
     * would be a coin flip reported as a fact. When the context cannot separate
     * them, fall through and let the passes below decide or admit the miss.
     */
    if (whole >= 0 && text.indexOf(needle, whole + 1) < 0) {
      const start = whole + prefix.length;
      return { start, end: start + exact.length };
    }
  }

  const hits: number[] = [];
  for (let at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) {
    hits.push(at);
    // A phrase repeated hundreds of times is not going to be disambiguated by
    // thirty characters; stop rather than scan a whole book for it.
    if (hits.length > 64) return null;
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) return { start: hits[0]!, end: hits[0]! + exact.length };

  let best: number | null = null;
  let bestScore = -1;
  let tied = false;
  for (const at of hits) {
    const before = text.slice(Math.max(0, at - prefix.length), at);
    const after = text.slice(at + exact.length, at + exact.length + suffix.length);
    const score = commonSuffix(before, prefix) + commonPrefix(after, suffix);
    if (score > bestScore) {
      bestScore = score;
      best = at;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  /*
   * No overlap at all, or two places that matched the context equally well.
   *
   * A tie is the case worth being careful about: the winner would be whichever
   * came first in the document, which is an ordering fact rather than a
   * relevance one, and it would be presented as certainty.
   */
  if (best == null || bestScore === 0 || tied) return null;
  return { start: best, end: best + exact.length };
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}
