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
  html: string;
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
  if (last && last.url === entry.url && last.html === entry.html) {
    return { ...tab, entries: [...kept.slice(0, -1), entry], index: kept.length - 1 };
  }
  const entries = [...kept, entry];
  return { ...tab, entries, index: entries.length - 1 };
}
