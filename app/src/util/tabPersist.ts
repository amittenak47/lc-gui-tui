/**
 * The header strip, written as a pref so relaunch restores the chips.
 *
 * Cold content already lives under IndexedDB / the libraries. This file is
 * only the *records* — titles, storage keys, split groups — so the strip can
 * draw without mounting a board. Web HTML is deliberately not stored: a
 * captured page can be megabytes, and Back still works in-session from the
 * live record. After a relaunch the url is recaptured.
 */

import { setStorageItem } from "./storageQuota";
import {
  HOME_TAB_ID,
  clampSplitRatio,
  homeTab,
  initialTabState,
  syncGroupSeq,
  syncTabSeq,
  type SplitAxis,
  type TabGroup,
  type TabIndexState,
  type TabRecord,
  type TabState,
  type WebTab,
} from "./tabs";

export const TAB_STRIP_KEY = "whiteboard.tabs.v1";

/** Parked markdown that never reached the library. Bigger than this is dropped. */
export const MAX_SOURCE_CHARS = 80_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asIndex(value: unknown): TabIndexState {
  return value === "indexed" ? "indexed" : "idle";
}

function persistable(tab: TabRecord): TabRecord | null {
  switch (tab.kind) {
    case "home":
      return { ...homeTab(tab.lastActive), lastActive: tab.lastActive };
    case "practice":
      return { ...tab, dirty: false, group: tab.group };
    case "whiteboard":
      if (!tab.notebookId) return null;
      return { ...tab, dirty: false };
    case "annotate": {
      // Keep the text until the library actually has it. A hash/docId on the
      // chip used to drop source and assume IndexedDB already stored a copy —
      // unsaved markdown never got one, so relaunch showed a missing-file dialog.
      const source =
        tab.source && tab.source.length > 0 && tab.source.length <= MAX_SOURCE_CHARS
          ? tab.source
          : null;
      if (!tab.hash && !tab.docId && !source) return null;
      return { ...tab, dirty: false, indexed: asIndex(tab.indexed), source };
    }
    case "explore":
      // The chip only. Nodes and edges live in IndexedDB, so a restored atlas
      // reads the graph as it is now rather than as it was when the app closed.
      return { ...tab, dirty: false };
    case "web": {
      const entries = tab.entries
        .filter((entry) => typeof entry.url === "string" && entry.url.length > 0)
        .map((entry) => ({ url: entry.url, title: entry.title || entry.url, html: "" }));
      if (entries.length === 0) return null;
      const index = Math.min(Math.max(0, tab.index), entries.length - 1);
      const next: WebTab = {
        ...tab,
        dirty: false,
        indexed: asIndex(tab.indexed),
        entries,
        index,
      };
      return next;
    }
  }
}

function parseTab(raw: unknown): TabRecord | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const title = asString(raw.title) ?? "Untitled";
  const lastActive = typeof raw.lastActive === "number" && Number.isFinite(raw.lastActive) ? raw.lastActive : 0;
  const group = asString(raw.group) ?? undefined;
  const dirty = false;
  const kind = raw.kind;
  if (!id) return null;
  if (kind === "home") return persistable({ id: HOME_TAB_ID, kind: "home", title: "Home", dirty, lastActive, group });
  if (kind === "practice") {
    const dataset = asString(raw.dataset);
    const taskId = asString(raw.taskId);
    if (!dataset || !taskId) return null;
    return persistable({ id, kind, title, dirty, lastActive, group, dataset, taskId });
  }
  if (kind === "whiteboard") {
    const notebookId = asString(raw.notebookId);
    if (!notebookId) return null;
    return persistable({ id, kind, title, dirty, lastActive, group, notebookId });
  }
  if (kind === "annotate") {
    const docType = raw.docType;
    if (
      docType !== "markdown" &&
      docType !== "code" &&
      docType !== "pdf" &&
      docType !== "epub" &&
      docType !== "web"
    ) {
      return null;
    }
    const source = typeof raw.source === "string" ? raw.source : null;
    return persistable({
      id,
      kind,
      title,
      dirty,
      lastActive,
      group,
      docId: asString(raw.docId),
      hash: asString(raw.hash),
      docType,
      indexed: asIndex(raw.indexed),
      source,
    });
  }
  if (kind === "explore") {
    return persistable({ id, kind, title: "Explore", dirty, lastActive, group });
  }
  if (kind === "web") {
    const entriesRaw = Array.isArray(raw.entries) ? raw.entries : [];
    const entries = entriesRaw.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const url = asString(entry.url);
      if (!url) return [];
      return [{ url, title: asString(entry.title) ?? url, html: "" }];
    });
    const index = typeof raw.index === "number" && Number.isFinite(raw.index) ? raw.index : 0;
    return persistable({
      id,
      kind,
      title,
      dirty,
      lastActive,
      group,
      indexed: asIndex(raw.indexed),
      entries,
      index,
    });
  }
  return null;
}

function parseAxis(value: unknown): SplitAxis | null {
  return value === "vertical" || value === "horizontal" ? value : null;
}

function parseGroup(raw: unknown, ids: Set<string>): TabGroup | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  const children = Array.isArray(raw.children) ? raw.children : [];
  const a = asString(children[0]);
  const b = asString(children[1]);
  const split = isRecord(raw.split) ? raw.split : null;
  const axis = split ? parseAxis(split.axis) : null;
  if (!id || !a || !b || a === b || !axis) return null;
  if (!ids.has(a) || !ids.has(b) || a === HOME_TAB_ID || b === HOME_TAB_ID) return null;
  const ratio = clampSplitRatio(typeof split?.ratio === "number" ? split.ratio : 0.5);
  return { id, children: [a, b], split: { axis, ratio } };
}

/** Drop fields a relaunch cannot honour, then keep Home first. */
export function serializeTabState(state: TabState): TabState {
  const seen = new Set<string>([HOME_TAB_ID]);
  const tabs: TabRecord[] = [homeTab(state.tabs[0]?.lastActive ?? 0)];
  for (const tab of state.tabs) {
    if (tab.kind === "home" || seen.has(tab.id)) continue;
    const next = persistable(tab);
    if (!next) continue;
    seen.add(next.id);
    tabs.push(next);
  }
  const ids = new Set(tabs.map((tab) => tab.id));
  const groups: TabGroup[] = [];
  const used = new Set<string>();
  for (const group of state.groups) {
    const parsed = parseGroup(group, ids);
    if (!parsed) continue;
    if (used.has(parsed.children[0]) || used.has(parsed.children[1])) continue;
    used.add(parsed.children[0]);
    used.add(parsed.children[1]);
    groups.push(parsed);
  }
  const groupIds = new Set(groups.map((group) => group.id));
  const aligned = tabs.map((tab) =>
    tab.group && !groupIds.has(tab.group) ? { ...tab, group: undefined } : tab,
  );
  const activeId = ids.has(state.activeId) ? state.activeId : HOME_TAB_ID;
  return { tabs: aligned, activeId, groups };
}

export function parseTabState(raw: unknown, at = 0): TabState | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  const parsed = (Array.isArray(raw.tabs) ? raw.tabs : [])
    .map(parseTab)
    .filter((tab): tab is TabRecord => Boolean(tab));
  const draft: TabState = {
    tabs: parsed.length > 0 ? parsed : [homeTab(at)],
    activeId: asString(raw.activeId) ?? HOME_TAB_ID,
    groups: Array.isArray(raw.groups) ? (raw.groups as TabGroup[]) : [],
  };
  return serializeTabState(draft);
}

export function loadTabState(at = Date.now()): TabState {
  try {
    const raw = localStorage.getItem(TAB_STRIP_KEY);
    if (!raw) return initialTabState(at);
    const parsed = parseTabState(JSON.parse(raw) as unknown, at);
    if (!parsed) return initialTabState(at);
    syncTabSeq(parsed.tabs);
    syncGroupSeq(parsed.groups);
    return parsed;
  } catch {
    return initialTabState(at);
  }
}

export function saveTabState(state: TabState): void {
  const serial = serializeTabState(state);
  try {
    setStorageItem(TAB_STRIP_KEY, JSON.stringify({ v: 1, ...serial }));
  } catch {
    /* quota / private browsing — the strip is a pref, not the writing */
  }
}
