/**
 * Back/forward history for one web pad.
 *
 * Snapshots stay in memory so Back restores the same HTML hash (and its ink)
 * instead of re-fetching a live page.
 *
 * The list of open pages is no longer here — it lives in `tabs.ts` with every
 * other workspace, since the header strip draws them all from one model. What
 * is left is the per-page history, and it is written against the narrow
 * {@link WebHistory} shape so a tab record can *be* its own history rather
 * than holding a second object that has to be kept in step.
 */

export interface WebPadEntry {
  url: string;
  title: string;
  /**
   * The frozen copy, once there is one.
   *
   * Absent for a page reached by browsing the live view. That view is a native
   * surface with its own document; the app learns the address it moved to and
   * nothing else, so an entry recorded from it is a place without a snapshot.
   * Stepping back onto one fetches it — which is what {@link needsFetch} is
   * for, and why this is optional rather than an empty string that would read
   * as "a page with no content".
   */
  html?: string;
}

/** An entry recorded from live browsing, which has to be fetched to be shown. */
export function needsFetch(entry: WebPadEntry | undefined): boolean {
  return entry != null && entry.html == null;
}

/** The history slice of a web tab: the entries, and where we are in them. */
export interface WebHistory {
  entries: WebPadEntry[];
  index: number;
}

export function currentEntry(tab: WebHistory): WebPadEntry | undefined {
  return tab.entries[tab.index];
}

export function canStepWeb(tab: WebHistory, delta: number): boolean {
  const next = tab.index + delta;
  return next >= 0 && next < tab.entries.length;
}

export function stepWeb<T extends WebHistory>(tab: T, delta: number): T {
  if (!canStepWeb(tab, delta)) return tab;
  return { ...tab, index: tab.index + delta };
}

export function pushWeb<T extends WebHistory>(tab: T, entry: WebPadEntry): T {
  const kept = tab.entries.slice(0, tab.index + 1);
  const last = kept[kept.length - 1];
  /*
   * A page arriving with its snapshot replaces the placeholder live browsing
   * left at the same address, rather than sitting next to it as a second
   * entry. Otherwise Back walks the same page twice — once as a promise and
   * once as the thing itself.
   */
  if (last && last.url === entry.url && (last.html === entry.html || last.html == null)) {
    return { ...tab, entries: [...kept.slice(0, -1), entry], index: kept.length - 1 };
  }
  const entries = [...kept, entry];
  return { ...tab, entries, index: entries.length - 1 };
}
