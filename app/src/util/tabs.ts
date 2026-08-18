/**
 * The header tab strip's model — one record per open workspace.
 *
 * Records are bytes, not mounts. The strip has to draw every open workspace
 * while only one board is live, so nothing in here reaches for Excalidraw,
 * pdf.js, or a document's text. A record carries the title, the dirty flag,
 * and the per-entity key the content is *already* stored under — the
 * `annotateStore` doc id, the `whiteboardStore` notebook id, the
 * `{dataset, task_id}` pair the daemon routes already name — and focusing the
 * tab re-reads the workspace from that key. There is no new resource here and
 * nothing to sync.
 *
 * Web tabs are the one exception, and only because Back has to work: their
 * page snapshots live on the record so stepping back restores the same HTML
 * hash — and therefore the same ink — instead of re-fetching a live page.
 * That is also why they are the one kind with a cap. Two captured pages is
 * the memory ceiling worth holding, and {@link tabsReducer} is where the cap
 * is enforced, rather than at the three call sites that can open one.
 */

import type { DocType } from "./annotateStore";
import { hostLabelFromUrl } from "./webPage";
import { type WebHistory, type WebPadEntry, currentEntry, pushWeb, stepWeb } from "./webPadSession";

export type TabKind = "home" | "practice" | "whiteboard" | "annotate" | "web";

/** Mirrors `DocIndexChipStatus` without pulling a component into the model. */
export type TabIndexState = "idle" | "indexing" | "indexed" | "error";

/** Home is a tab, not a button that tears the workspace down. It never closes. */
export const HOME_TAB_ID = "home";

/** See the note at the top: two captured pages is the ceiling. */
export const WEB_TAB_LIMIT = 2;

/**
 * Practice is capped at one, and unlike the web cap this is not about memory.
 *
 * A problem workspace is an attempt: a solution file on disk, a run, a graded
 * submission, a coach thread that has been reading all of it. Two of those
 * open at once is a lot of state for the app to keep straight and more than a
 * reader wants to hold either. A second problem moves the tab that exists.
 */
export const PRACTICE_TAB_LIMIT = 1;

interface TabBase {
  id: string;
  title: string;
  /** Unsaved work; parking the tab is what clears it. */
  dirty: boolean;
  /** Split group id. Both children of a group stay live — see the mount budget. */
  group?: string;
  lastActive: number;
}

export interface HomeTab extends TabBase {
  kind: "home";
}

export interface PracticeTab extends TabBase {
  kind: "practice";
  dataset: string;
  taskId: string;
}

export interface WhiteboardTab extends TabBase {
  kind: "whiteboard";
  /** Null until the autosave has written the notebook once. */
  notebookId: string | null;
}

export interface AnnotateTab extends TabBase {
  kind: "annotate";
  docId: string | null;
  /** Content hash — the annotate store's real key, stable before an id exists. */
  hash: string | null;
  docType: DocType;
  indexed: TabIndexState;
  /**
   * The text, held only while this document has nowhere else to be read from.
   *
   * A document that was merely *read* never reaches the library — the store
   * deliberately does not fill with every file ever opened — so parking one
   * would otherwise be losing it. Dropped the moment a save gives the tab a
   * `docId`. Binary types never set it: their bytes went to IndexedDB under
   * the hash when the file was opened, annotations or not.
   */
  source: string | null;
}

export interface WebTab extends TabBase, WebHistory {
  kind: "web";
  indexed: TabIndexState;
}

export type TabRecord = HomeTab | PracticeTab | WhiteboardTab | AnnotateTab | WebTab;

export interface TabState {
  /** Home is always `tabs[0]`, and it is the one tab that cannot be closed. */
  tabs: TabRecord[];
  activeId: string;
}

/**
 * Fields a live workspace reports back as it learns them.
 *
 * A whiteboard has no id until the first autosave and a document has no index
 * status until the embed returns, so records are opened incomplete and filled
 * in. Keys that do not belong to the tab's kind are dropped rather than
 * grown onto it — see {@link applyPatch}.
 */
export type TabPatch = Partial<{
  title: string;
  dirty: boolean;
  group: string;
  dataset: string;
  taskId: string;
  notebookId: string | null;
  docId: string | null;
  hash: string | null;
  docType: DocType;
  indexed: TabIndexState;
  source: string | null;
}>;

export type TabAction =
  | { type: "focus"; id: string; at: number }
  | { type: "open"; tab: TabRecord; at: number }
  | { type: "close"; id: string }
  | { type: "patch"; id: string; patch: TabPatch }
  | { type: "web-push"; id: string; entry: WebPadEntry }
  | { type: "web-step"; id: string; delta: number }
  | { type: "hydrate"; state: TabState };

let tabSeq = 0;

export function newTabId(kind: TabKind): string {
  tabSeq += 1;
  return `${kind}-${tabSeq}`;
}

export function homeTab(at = 0): HomeTab {
  return { id: HOME_TAB_ID, kind: "home", title: "Home", dirty: false, lastActive: at };
}

export function initialTabState(at = 0): TabState {
  return { tabs: [homeTab(at)], activeId: HOME_TAB_ID };
}

export function activeTab(state: TabState): TabRecord {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]!;
}

export function webTabCount(state: TabState): number {
  return state.tabs.reduce((count, tab) => count + (tab.kind === "web" ? 1 : 0), 0);
}

/** Hostnames, not page titles — `google.com`, not `Google`. */
export function webTabTitle(entry: WebPadEntry | undefined): string {
  return entry ? hostLabelFromUrl(entry.url) : "Page";
}

/**
 * Is this the same workspace, so an icon tap should focus rather than spawn?
 *
 * Identity is the storage key, which is why a blank whiteboard and an
 * un-annotated document are *not* the same as anything: they have no key yet,
 * so two of them are two tabs. Web tabs never match — the globe and the `+`
 * are asking for another page, not for the one already open.
 */
export function sameEntity(a: TabRecord, b: TabRecord): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "home":
      return true;
    case "practice":
      return a.dataset === (b as PracticeTab).dataset && a.taskId === (b as PracticeTab).taskId;
    case "whiteboard":
      return a.notebookId !== null && a.notebookId === (b as WhiteboardTab).notebookId;
    case "annotate":
      return a.hash !== null && a.hash === (b as AnnotateTab).hash;
    case "web":
      return false;
  }
}

/**
 * The record an `open` collapses onto, or null when it earns a new chip.
 *
 * Two things collapse an open: it is the same entity, or it is Practice and a
 * problem is already open. Exported because the caller needs the same answer
 * the reducer is about to reach — it has to know which record to keep
 * patching as the workspace loads.
 */
export function openTarget(state: TabState, tab: TabRecord): TabRecord | null {
  const same = state.tabs.find((open) => sameEntity(open, tab));
  if (same) return same;
  if (tab.kind !== "practice") return null;
  const practice = state.tabs.filter((open) => open.kind === "practice");
  return practice.length >= PRACTICE_TAB_LIMIT ? (practice[0] ?? null) : null;
}

/** Only keys the record already declares are written; the rest are dropped. */
function applyPatch(tab: TabRecord, patch: TabPatch): TabRecord {
  const next: Record<string, unknown> = { ...tab };
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    // `group` is optional on every kind, so it is the one key that may be new.
    if (!(key in tab) && key !== "group") continue;
    if (next[key] === value) continue;
    next[key] = value;
    changed = true;
  }
  return changed ? (next as unknown as TabRecord) : tab;
}

/**
 * Hold the web cap by dropping the least recently used page, never the one
 * just opened — a cap that refuses the tab you asked for reads as a bug.
 */
function evictOverCap(tabs: TabRecord[], keepId: string): TabRecord[] {
  const web = tabs.filter((tab): tab is WebTab => tab.kind === "web");
  if (web.length <= WEB_TAB_LIMIT) return tabs;
  const doomed = new Set(
    web
      .filter((tab) => tab.id !== keepId)
      .sort((a, b) => a.lastActive - b.lastActive)
      .slice(0, web.length - WEB_TAB_LIMIT)
      .map((tab) => tab.id),
  );
  return tabs.filter((tab) => !doomed.has(tab.id));
}

export function tabsReducer(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case "hydrate":
      return action.state;

    case "focus": {
      if (!state.tabs.some((tab) => tab.id === action.id)) return state;
      return {
        tabs: state.tabs.map((tab) =>
          tab.id === action.id ? { ...tab, lastActive: action.at } : tab,
        ),
        activeId: action.id,
      };
    }

    case "open": {
      const target = openTarget(state, action.tab);
      if (target) {
        // A practice tab reused for a different problem takes that problem's
        // identity; every other collapse is onto the entity already there.
        const renamed =
          target.kind === "practice" && action.tab.kind === "practice"
            ? tabsReducer(state, {
                type: "patch",
                id: target.id,
                patch: {
                  title: action.tab.title,
                  dataset: action.tab.dataset,
                  taskId: action.tab.taskId,
                },
              })
            : state;
        return tabsReducer(renamed, { type: "focus", id: target.id, at: action.at });
      }
      const opened = { ...action.tab, lastActive: action.at };
      return {
        tabs: evictOverCap([...state.tabs, opened], opened.id),
        activeId: opened.id,
      };
    }

    case "close": {
      if (action.id === HOME_TAB_ID) return state;
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      if (state.activeId !== action.id) return { ...state, tabs };
      // Land on whatever slid into the closed tab's place, the way a browser does.
      const neighbour = tabs[Math.min(index, tabs.length - 1)] ?? tabs[0]!;
      return { tabs, activeId: neighbour.id };
    }

    case "patch": {
      const tabs = state.tabs.map((tab) =>
        tab.id === action.id ? applyPatch(tab, action.patch) : tab,
      );
      return tabs.every((tab, i) => tab === state.tabs[i]) ? state : { ...state, tabs };
    }

    case "web-push": {
      return {
        ...state,
        tabs: state.tabs.map((tab) => {
          if (tab.id !== action.id || tab.kind !== "web") return tab;
          const pushed = pushWeb(tab, action.entry);
          return { ...pushed, title: webTabTitle(currentEntry(pushed)) };
        }),
      };
    }

    case "web-step": {
      return {
        ...state,
        tabs: state.tabs.map((tab) => {
          if (tab.id !== action.id || tab.kind !== "web") return tab;
          const stepped = stepWeb(tab, action.delta);
          return { ...stepped, title: webTabTitle(currentEntry(stepped)) };
        }),
      };
    }
  }
}
