/** Time-sliced committed replay so opening a notebook cannot pin the UI. */

export const REPLAY_SLICE_MS = 8;

/**
 * Paint `[from, n)` until `budgetMs` elapses. Always paints at least one
 * index so a single expensive stroke still makes progress.
 */
export function replayUntil(
  from: number,
  n: number,
  now: () => number,
  budgetMs: number,
  paintOne: (index: number) => void,
): number {
  if (from >= n) return n;
  const t0 = now();
  let i = from;
  while (i < n && (i === from || now() - t0 < budgetMs)) {
    paintOne(i);
    i += 1;
  }
  return i;
}
