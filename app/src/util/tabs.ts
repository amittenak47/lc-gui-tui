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

export type TabKind = "home" | "practice" | "whiteboard" | "annotate" | "web" | "explore";

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

/**
 * One atlas.
 *
 * Explore is a view *of* the other tabs, so a second copy would show the same
 * thing twice and disagree with itself the moment one of them was filtered.
 * Unlike Practice, opening it again focuses the existing chip rather than
 * replacing it — there is no second Explore to switch to.
 */
export const EXPLORE_TAB_LIMIT = 1;

interface TabBase {
  id: string;
  title: string;
  /** Unsaved work; parking the tab is what clears it. */
  dirty: boolean;
  /** Split group id. Both children of a group stay live — see the mount budget. */
  group?: string;
  lastActive: number;
}

export interface ExploreTab extends TabBase {
  kind: "explore";
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

export type TabRecord =
  | HomeTab
  | PracticeTab
  | WhiteboardTab
  | AnnotateTab
  | WebTab
  | ExploreTab;

/** Vertical sash = left | right panes. Horizontal sash = top | bottom. */
export type SplitAxis = "vertical" | "horizontal";

export type SplitEdge = "left" | "right" | "top" | "bottom";

export interface TabSplit {
  axis: SplitAxis;
  /** Fraction of the main axis given to `children[0]`. Clamped 0.2–0.8. */
  ratio: number;
}

export interface TabGroup {
  id: string;
  children: [string, string];
  split: TabSplit;
}

export interface TabState {
  /** Home is always `tabs[0]`, and it is the one tab that cannot be closed. */
  tabs: TabRecord[];
  activeId: string;
  groups: TabGroup[];
}

export const SPLIT_RATIO_MIN = 0.2;
export const SPLIT_RATIO_MAX = 0.8;

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

export function axisOfEdge(edge: SplitEdge): SplitAxis {
  return edge === "left" || edge === "right" ? "vertical" : "horizontal";
}

/**
 * Which edge of `box` the pointer is in, or null when it is in the middle.
 *
 * `band` is a fraction of the width/height. Corners pick the nearer axis.
 */
export function splitEdgeAt(
  box: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
  band = 0.22,
): SplitEdge | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const l = (x - box.left) / box.width;
  const t = (y - box.top) / box.height;
  if (l < 0 || l > 1 || t < 0 || t > 1) return null;
  const dl = l;
  const dr = 1 - l;
  const dt = t;
  const db = 1 - t;
  const min = Math.min(dl, dr, dt, db);
  if (min > band) return null;
  if (min === dl) return "left";
  if (min === dr) return "right";
  if (min === dt) return "top";
  return "bottom";
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
  | { type: "split"; a: string; b: string; axis: SplitAxis; edge?: SplitEdge; at: number }
  | { type: "unsplit"; id: string }
  | { type: "swap-split"; id: string }
  | { type: "set-ratio"; groupId: string; ratio: number }
  | { type: "hydrate"; state: TabState };

let tabSeq = 0;
let groupSeq = 0;

export function newTabId(kind: TabKind): string {
  tabSeq += 1;
  return `${kind}-${tabSeq}`;
}

export function newGroupId(): string {
  groupSeq += 1;
  return `group-${groupSeq}`;
}

/** After hydrate, new ids must not collide with restored `kind-N` chips. */
export function syncTabSeq(tabs: TabRecord[]): void {
  let max = tabSeq;
  for (const tab of tabs) {
    const match = /^.+-(\d+)$/.exec(tab.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  tabSeq = max;
}

export function syncGroupSeq(groups: TabGroup[]): void {
  let max = groupSeq;
  for (const group of groups) {
    const match = /^group-(\d+)$/.exec(group.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  groupSeq = max;
}

export function homeTab(at = 0): HomeTab {
  return { id: HOME_TAB_ID, kind: "home", title: "Home", dirty: false, lastActive: at };
}

export function initialTabState(at = 0): TabState {
  return { tabs: [homeTab(at)], activeId: HOME_TAB_ID, groups: [] };
}

export function groupOf(state: TabState, id: string): TabGroup | undefined {
  const tab = state.tabs.find((entry) => entry.id === id);
  const groupId = tab?.group;
  if (!groupId) return undefined;
  return state.groups.find((group) => group.id === groupId);
}

/**
 * What is painted: a split pair, or the focused tab alone.
 *
 * Home is never in a group, so focusing it is always a single pane.
 */
export function visibleTabIds(state: TabState): string[] {
  if (state.activeId === HOME_TAB_ID) return [HOME_TAB_ID];
  const group = groupOf(state, state.activeId);
  return group ? [...group.children] : [state.activeId];
}

/**
 * Pin ids at the front of the live list, in that order, without duplicates.
 *
 * Split panes have to occupy the mount-budget slots or one half remounts.
 */
export function pinLive(ids: string[], pinned: string[]): string[] {
  const pin: string[] = [];
  for (const id of pinned) {
    if (!pin.includes(id)) pin.push(id);
  }
  const rest = ids.filter((id) => !pin.includes(id));
  const next = [...pin, ...rest];
  return next.length === ids.length && next.every((id, i) => id === ids[i]) ? ids : next;
}

function clearGroup(state: TabState, groupId: string): TabState {
  return {
    ...state,
    groups: state.groups.filter((group) => group.id !== groupId),
    tabs: state.tabs.map((tab) => (tab.group === groupId ? { ...tab, group: undefined } : tab)),
  };
}

function detachFromGroup(state: TabState, id: string): TabState {
  const group = groupOf(state, id);
  return group ? clearGroup(state, group.id) : state;
}

/**
 * Order the pair so `edge` places `incoming` on that side of `anchor`.
 */
export function splitChildren(
  anchor: string,
  incoming: string,
  edge: SplitEdge = "right",
): [string, string] {
  if (edge === "left" || edge === "top") return [incoming, anchor];
  return [anchor, incoming];
}

export function activeTab(state: TabState): TabRecord {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]!;
}

export function webTabCount(state: TabState): number {
  return state.tabs.reduce((count, tab) => count + (tab.kind === "web" ? 1 : 0), 0);
}

/**
 * The mount budget, as a list of ids, most recently looked at first.
 *
 * Records are cheap and mounts are not, so most parked tabs are a record and
 * nothing else. This is the short list of the ones that stay *mounted* — the
 * board, its ink layer, any pdf.js workers — so that coming back to one is
 * showing it again rather than reading it out of the store and re-fitting.
 *
 * Separated from the component because the interesting part is a list
 * operation, and a list operation should not need a browser to check.
 */
export function promoteLive(ids: string[], id: string): string[] {
  return ids[0] === id ? ids : [id, ...ids.filter((entry) => entry !== id)];
}

/**
 * The ids past the limit: the ones to flush and unmount, oldest last.
 *
 * They have to be flushed *before* they are dropped — the board handle is what
 * the flush writes through — which is why this answers with a list to act on
 * rather than doing the trimming itself.
 */
export function liveOverflow(ids: string[], limit: number): string[] {
  // Home is always kept: the chooser is cheap to hold and a full Workspace
  // remount (idle Excalidraw included) is what made tapping Home feel like a
  // load. The budget applies to every other chip.
  const working = ids.filter((id) => id !== HOME_TAB_ID);
  return working.length <= limit ? [] : working.slice(limit);
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
    case "explore":
      // There is only ever one, so any two explore records are the same one.
      return true;
    case "annotate":
      /*
       * The annotation set, not the file it was drawn over.
       *
       * This matched on `hash` while a file could only carry one set. Now that
       * it can carry several, the hash is the wrong question — two forks of
       * `dp.pdf` share it, and matching on it would fold them into one chip
       * and hand whichever opened second the other's board.
       *
       * Null matches nothing: a record mid-open has no set yet, and must not
       * collapse onto an unrelated document that is in the same state.
       */
      return a.docId !== null && a.docId === (b as AnnotateTab).docId;
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

/**
 * The record an `open` leaves focused — what the loader should then read.
 *
 * Opening is two steps now: write the record, then load from it. Which record
 * gets loaded is the reducer's decision, so this is where that decision lives
 * and {@link tabsReducer} calls it too. A caller that guessed instead would
 * load the problem it proposed into the tab the reducer actually kept.
 */
export function openedRecord(state: TabState, tab: TabRecord): TabRecord {
  const target = openTarget(state, tab);
  if (!target) return tab;
  // The one collapse that is not onto the same entity: a Practice tab reused
  // for a different problem keeps its id and takes the new identity.
  if (target.kind === "practice" && tab.kind === "practice") {
    return { ...target, title: tab.title, dataset: tab.dataset, taskId: tab.taskId };
  }
  return target;
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

function pruneGroups(state: TabState): TabState {
  const ids = new Set(state.tabs.map((tab) => tab.id));
  const groups = state.groups.filter(
    (group) => ids.has(group.children[0]) && ids.has(group.children[1]),
  );
  const live = new Set(groups.map((group) => group.id));
  const tabs = state.tabs.map((tab) =>
    tab.group && !live.has(tab.group) ? { ...tab, group: undefined } : tab,
  );
  const groupsSame =
    groups.length === state.groups.length && groups.every((group, i) => group === state.groups[i]);
  const tabsSame = tabs.every((tab, i) => tab === state.tabs[i]);
  return groupsSame && tabsSame ? state : { ...state, tabs, groups };
}

export function tabsReducer(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case "hydrate":
      syncTabSeq(action.state.tabs);
      syncGroupSeq(action.state.groups);
      return action.state;

    case "focus": {
      if (!state.tabs.some((tab) => tab.id === action.id)) return state;
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.id ? { ...tab, lastActive: action.at } : tab,
        ),
        activeId: action.id,
      };
    }

    case "open": {
      const target = openTarget(state, action.tab);
      if (target) {
        const landed = openedRecord(state, action.tab);
        const renamed =
          landed === target
            ? state
            : { ...state, tabs: state.tabs.map((tab) => (tab.id === target.id ? landed : tab)) };
        return tabsReducer(renamed, { type: "focus", id: target.id, at: action.at });
      }
      const opened = { ...action.tab, lastActive: action.at };
      return pruneGroups({
        ...state,
        tabs: evictOverCap([...state.tabs, opened], opened.id),
        activeId: opened.id,
      });
    }

    case "close": {
      if (action.id === HOME_TAB_ID) return state;
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const group = groupOf(state, action.id);
      const partner = group?.children.find((child) => child !== action.id);
      const stripped = group ? clearGroup(state, group.id) : state;
      const tabs = stripped.tabs.filter((tab) => tab.id !== action.id);
      if (stripped.activeId !== action.id) return { ...stripped, tabs };
      const neighbour =
        (partner && tabs.find((tab) => tab.id === partner)) ||
        tabs[Math.min(index, tabs.length - 1)] ||
        tabs[0]!;
      return { ...stripped, tabs, activeId: neighbour.id };
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

    case "split": {
      if (action.a === action.b) return state;
      if (action.a === HOME_TAB_ID || action.b === HOME_TAB_ID) return state;
      if (!state.tabs.some((tab) => tab.id === action.a)) return state;
      if (!state.tabs.some((tab) => tab.id === action.b)) return state;
      const existing = groupOf(state, action.a);
      const children = splitChildren(action.a, action.b, action.edge ?? "right");
      if (existing && existing.children.includes(action.b)) {
        return {
          ...state,
          activeId: action.a,
          groups: state.groups.map((group) =>
            group.id === existing.id
              ? { ...group, children, split: { ...group.split, axis: "vertical" } }
              : group,
          ),
        };
      }
      let next = detachFromGroup(state, action.a);
      next = detachFromGroup(next, action.b);
      const id = newGroupId();
      const group: TabGroup = {
        id,
        children,
        // Side-by-side only. A horizontal split fights the existing chrome.
        split: { axis: "vertical", ratio: 0.5 },
      };
      return {
        ...next,
        activeId: action.a,
        groups: [...next.groups, group],
        tabs: next.tabs.map((tab) =>
          tab.id === action.a || tab.id === action.b
            ? { ...tab, group: id, lastActive: tab.id === action.a ? action.at : tab.lastActive }
            : tab,
        ),
      };
    }

    case "unsplit":
      return detachFromGroup(state, action.id);

    /*
     * The pair keeps its columns; the two panes trade places.
     *
     * Dragging one half of a split onto the other used to be a no-op — the
     * drop rebuilt the same pair in the same order, so the one gesture anyone
     * would try for "put this one on the left" did nothing at all.
     *
     * The ratio deliberately stays where it is. A reader who dragged a chip to
     * the left side asked for that side, at that side's width; inverting the
     * ratio as well would move the boundary they set for reasons that have
     * nothing to do with which pane is which.
     */
    case "swap-split": {
      const group = groupOf(state, action.id);
      if (!group) return state;
      return {
        ...state,
        groups: state.groups.map((entry) =>
          entry.id === group.id
            ? { ...entry, children: [entry.children[1], entry.children[0]] }
            : entry,
        ),
      };
    }

    case "set-ratio": {
      const ratio = clampSplitRatio(action.ratio);
      const groups = state.groups.map((group) =>
        group.id !== action.groupId || group.split.ratio === ratio
          ? group
          : { ...group, split: { ...group.split, ratio } },
      );
      return groups.every((group, i) => group === state.groups[i]) ? state : { ...state, groups };
    }
  }
}
