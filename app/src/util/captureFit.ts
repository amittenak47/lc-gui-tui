/**
 * Whether a freshly captured page is still the page your marks are on.
 *
 * A web pad's identity is its address, so a second capture arrives under the
 * same hash and would replace the first. For an article that is right — the page
 * was edited, the words are still there, everything re-anchors. For a feed it is
 * destruction: today's capture holds none of yesterday's tweets, so replacing it
 * leaves every mark displaying an excerpt and pointing at nothing.
 *
 * Nothing has to guess which kind of page it is looking at. **The page says so,
 * by whether the marks are still on it.**
 */

import { findQuote } from "./quoteAnchor";
import { isTextAnchor, type DocAnchor } from "./docAnchors";

export interface FitMark {
  id: string;
  anchor: DocAnchor;
  excerpt?: string;
}

export interface CaptureFit {
  /** Marks that can still be found in the new capture. */
  kept: string[];
  /** Marks whose words are not in it. */
  stranded: string[];
  /**
   * Marks that cannot be judged — a region on a page has no words to search
   * for, so a re-capture says nothing about whether it still points anywhere.
   * Counted apart rather than guessed either way.
   */
  unknown: string[];
}

/**
 * Which marks survive a proposed capture.
 *
 * `text` is the new capture's character stream. Only text marks can be checked:
 * a region is a rectangle, and whether it still frames the right thing is a
 * question about layout that no amount of searching answers.
 */
export function captureFit(marks: readonly FitMark[], text: string): CaptureFit {
  const fit: CaptureFit = { kept: [], stranded: [], unknown: [] };
  for (const mark of marks) {
    const anchor = mark.anchor;
    if (!isTextAnchor(anchor)) {
      fit.unknown.push(mark.id);
      continue;
    }
    const exact = anchor.exact ?? mark.excerpt ?? "";
    if (!exact.trim()) {
      /*
       * Written before quotes were recorded and with nothing usable to fall back
       * on. Its offsets may well still be right; they may equally be pointing at
       * whatever now occupies those positions. Unknown is the honest answer.
       */
      fit.unknown.push(mark.id);
      continue;
    }
    const found = findQuote(text, {
      exact,
      ...(anchor.prefix ? { prefix: anchor.prefix } : {}),
      ...(anchor.suffix ? { suffix: anchor.suffix } : {}),
    });
    if (found) fit.kept.push(mark.id);
    else fit.stranded.push(mark.id);
  }
  return fit;
}

/** Nothing would be lost by taking the new capture. */
export function captureIsSafe(fit: CaptureFit): boolean {
  return fit.stranded.length === 0;
}

/**
 * What to tell the reader when it is not safe.
 *
 * Counts, not adjectives: "six of nine" is a fact they can act on, where "some
 * marks may not appear" is a hedge that leaves them no wiser.
 */
export function captureFitSummary(fit: CaptureFit): string | null {
  const total = fit.kept.length + fit.stranded.length + fit.unknown.length;
  if (fit.stranded.length === 0 || total === 0) return null;
  if (fit.kept.length === 0 && fit.unknown.length === 0) {
    return fit.stranded.length === 1
      ? "The mark you made is not on this version of the page."
      : `None of your ${fit.stranded.length} marks are on this version of the page.`;
  }
  return `${fit.stranded.length} of ${total} marks are not on this version of the page.`;
}
