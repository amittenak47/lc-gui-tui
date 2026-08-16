/**
 * Session history for the web annotate pad — tabs, each with back/forward.
 *
 * Snapshots stay in memory so Back restores the same HTML hash (and its ink)
 * instead of re-fetching a live page.
 */

export interface WebPadEntry {
  url: string;
  title: string;
  html: string;
}

export interface WebPadTab {
  id: string;
  entries: WebPadEntry[];
  index: number;
}

let tabSeq = 0;

export function newWebTabId(): string {
  tabSeq += 1;
  return `web-tab-${tabSeq}`;
}

export function tabFromEntry(entry: WebPadEntry, id = newWebTabId()): WebPadTab {
  return { id, entries: [entry], index: 0 };
}

export function currentEntry(tab: WebPadTab): WebPadEntry | undefined {
  return tab.entries[tab.index];
}

export function canStepWeb(tab: WebPadTab, delta: number): boolean {
  const next = tab.index + delta;
  return next >= 0 && next < tab.entries.length;
}

export function stepWeb(tab: WebPadTab, delta: number): WebPadTab {
  if (!canStepWeb(tab, delta)) return tab;
  return { ...tab, index: tab.index + delta };
}

export function pushWeb(tab: WebPadTab, entry: WebPadEntry): WebPadTab {
  const kept = tab.entries.slice(0, tab.index + 1);
  const last = kept[kept.length - 1];
  if (last && last.url === entry.url && last.html === entry.html) {
    return { ...tab, entries: [...kept.slice(0, -1), entry], index: kept.length - 1 };
  }
  const entries = [...kept, entry];
  return { ...tab, entries, index: entries.length - 1 };
}

export function commitWebPush(
  tabs: WebPadTab[],
  tabId: string | null,
  entry: WebPadEntry,
  newTab = false,
): { tabs: WebPadTab[]; tabId: string } {
  if (newTab || !tabId || !tabs.some((tab) => tab.id === tabId)) {
    const tab = tabFromEntry(entry);
    return { tabs: [...tabs, tab], tabId: tab.id };
  }
  return {
    tabs: tabs.map((tab) => (tab.id === tabId ? pushWeb(tab, entry) : tab)),
    tabId,
  };
}

export function closeWebTab(
  tabs: WebPadTab[],
  tabId: string,
): { tabs: WebPadTab[]; tabId: string | null } {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return { tabs, tabId };
  const next = tabs.filter((tab) => tab.id !== tabId);
  if (next.length === 0) return { tabs: next, tabId: null };
  const neighbor = next[Math.min(index, next.length - 1)];
  return { tabs: next, tabId: neighbor?.id ?? null };
}
