/**
 * A web pad has one address and, sometimes, more than one capture.
 *
 * §1d made the address the identity, which is right for an article: re-freeze
 * it and you get the same pad with its words edited. It is wrong for a feed.
 * `x.com/home` is not a text, it is a *viewport onto many texts* — a query that
 * answers differently every time it is asked — so replacing the capture there
 * destroys the only copy of the tweet somebody marked yesterday.
 *
 * The way out is that the timestamp belongs to the **capture**, not to the pad.
 * The pad keeps its single identity, and `source` stops being *the* body and
 * becomes the newest of possibly several. A mark records which capture it was
 * made against, so it can still be read in context — the page as it was when
 * you marked it, which is exactly what annotating a snapshot gave you and what
 * a bare quote would lose.
 *
 * The retention rule keeps that bounded: **a capture is kept while at least one
 * mark still points at it and cannot move forward into a newer one.** An
 * approximately static page — a changed comment count, a rotated ad — has all
 * its marks re-anchor, so it replaces and never accumulates. A feed marked on
 * three days keeps one capture per day *that has a stranded mark on it*, which
 * is correct: those captures hold posts that exist nowhere else. The count is
 * bounded by how often you marked something that later vanished, not by how
 * often you visited.
 */

/** How the reader answered "is this a page, or a feed?" for this pad. */
export type WebPadKind = "page" | "feed";

export interface WebCapture {
  id: string;
  capturedAt: number;
  html: string;
}

export interface CaptureSet {
  /** Newest first. `captures[0].html` is what the pad renders. */
  captures: WebCapture[];
  kind?: WebPadKind;
}

export function newCaptureId(now: number, seed = Math.random()): string {
  return `cap-${now.toString(36)}-${Math.floor(seed * 1e6).toString(36)}`;
}

/**
 * Default the offer; do not guess silently.
 *
 * A URL with a path is more likely a page, a bare host more likely a feed.
 * This is the pre-selected answer and nothing more — `medium.com/@someone`
 * versus `medium.com/@someone/a-post` is genuinely hard, and the point of
 * asking is that the reader knows which one they are looking at.
 */
export function likelyKind(url: string): WebPadKind {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path.length > 1 ? "page" : "feed";
  } catch {
    return "page";
  }
}

export interface AddCaptureInput {
  existing: readonly WebCapture[];
  html: string;
  now: number;
  /** Capture ids that still have a mark on them which could not move forward. */
  needed: readonly string[];
  kind?: WebPadKind;
  id?: string;
}

/**
 * Fold a fresh capture in, and drop the ones nothing needs any more.
 *
 * Replace is the common case and stays the common case. A capture survives only
 * because a mark is still standing on it — which is the difference between
 * keeping history and hoarding it.
 */
export function addCapture(input: AddCaptureInput): WebCapture[] {
  const fresh: WebCapture = {
    id: input.id ?? newCaptureId(input.now),
    capturedAt: input.now,
    html: input.html,
  };
  const needed = new Set(input.needed);
  /*
   * "Feed" is foreknowledge, and foreknowledge buys what evidence cannot.
   *
   * Evidence only reacts to stranding that has already happened. A news
   * homepage where the story you marked is still there today has every mark
   * re-anchor — so evidence says "same document", replaces, and throws away the
   * one capture those marks could have lived on. Tomorrow the story rotates
   * off, the marks strand, and the capture that would have saved them is gone.
   */
  const keepAll = input.kind === "feed";
  const kept = input.existing.filter(
    (capture) => keepAll || needed.has(capture.id),
  );
  return [fresh, ...kept].sort((a, b) => b.capturedAt - a.capturedAt);
}

/**
 * Which captures are still doing work.
 *
 * A mark with no `captureId` predates all of this and belongs to the newest
 * capture by default — that is where it was made, since there was only ever
 * one.
 */
export function neededCaptures(
  marks: readonly { id: string; captureId?: string }[],
  stranded: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const mark of marks) {
    if (!mark.captureId) continue;
    if (!stranded.has(mark.id)) continue;
    out.add(mark.captureId);
  }
  return [...out];
}

/** The body the pad renders: the newest capture, or nothing yet. */
export function currentCapture(captures: readonly WebCapture[]): WebCapture | null {
  return captures.length > 0 ? (captures[0] ?? null) : null;
}

export function captureById(
  captures: readonly WebCapture[],
  id: string | undefined,
): WebCapture | null {
  if (!id) return null;
  return captures.find((capture) => capture.id === id) ?? null;
}

/**
 * What to tell the reader after a capture that stranded something.
 *
 * Names the count, because "some marks" is not something anyone can act on,
 * and says where the old page went, because a mark that still opens its own
 * context is the whole reason the old capture was kept.
 */
export function captureKeptSummary(strandedCount: number, total: number): string {
  if (strandedCount <= 0) return "";
  const marks = strandedCount === 1 ? "1 mark is" : `${strandedCount} marks are`;
  return `${marks} not on this version of the page — of ${total}. The version they were made on is kept, so they still open in context.`;
}
