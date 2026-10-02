import { getAnnotateDocMeta, listAnnotateDocs } from "./annotateStore";
import { listWhiteboardNotebooks } from "./whiteboardStore";
import { parseTabState, serializeTabState } from "./tabPersist";
import { currentEntry } from "./webPadSession";
import { HOME_TAB_ID, type TabRecord } from "./tabs";

export const RECENT_WORKSPACES_KEY = "whiteboard.recentWorkspaces.v1";
export const RECENT_WORKSPACES_EVENT = "lc-recent-workspaces";
export const RECENT_WORKSPACE_LIMIT = 12;

/** Entity identity, including files read without saving an annotation set. */
export function recentWorkspaceKey(tab: TabRecord): string | null {
  if (tab.artifact) return null;
  switch (tab.kind) {
    case "practice": return `practice:${tab.dataset}/${tab.taskId}`;
    case "whiteboard": return !tab.footnoteBoard && tab.notebookId ? `whiteboard:${tab.notebookId}` : null;
    case "annotate": return tab.docId ? `document:${tab.docId}` : tab.hash ? `file:${tab.docType}:${tab.hash}` : null;
    case "web": return tab.docId ? `document:${tab.docId}` : currentEntry(tab)?.url ? `web:${currentEntry(tab)!.url}` : null;
    default: return null;
  }
}

/** Use the same recovery contract as restored tabs; never retain live Web HTML. */
function coldRecentTab(tab: TabRecord): TabRecord | null {
  if (!recentWorkspaceKey(tab)) return null;
  const cold = serializeTabState({tabs:[tab], activeId:tab.id, groups:[]}).tabs.find(row=>row.id===tab.id);
  if (!cold) return null;
  if (cold.kind === "annotate") {
    if (!cold.docId && !cold.source && cold.docType !== "pdf" && cold.docType !== "epub") return null;
    return {...cold, group:undefined, indexed:"idle"};
  }
  if (cold.kind === "web") {
    const entry = currentEntry(cold);
    return entry ? {...cold, group:undefined, entries:[entry], index:0, indexed:"idle"} : null;
  }
  return {...cold, group:undefined};
}

export function loadRecentWorkspaces(): TabRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_WORKSPACES_KEY) ?? "null");
    if (raw?.v !== 1 || !Array.isArray(raw.tabs)) return [];
    // Each visit is parsed separately: one reusable tab can have several past entities.
    return raw.tabs.slice(0,RECENT_WORKSPACE_LIMIT).flatMap((record:unknown)=>{
      const state = parseTabState({v:1, tabs:[record], activeId:HOME_TAB_ID, groups:[]});
      return (state?.tabs ?? []).flatMap(tab=>{
        const cold=coldRecentTab(tab);
        return cold ? [cold] : [];
      });
    });
  } catch { return []; }
}

/** Record visits independently of the open strip. Patches do not rewrite unchanged history. */
export function rememberRecentWorkspace(tab: TabRecord): void {
  const cold = coldRecentTab(tab);
  if (!cold) return;
  const key = recentWorkspaceKey(cold);
  const before = loadRecentWorkspaces();
  const next = [cold, ...before.filter(row=>{
    if (recentWorkspaceKey(row) === key) return false;
    // An unsaved annotation id may arrive after its cached file was recorded.
    // A reused Practice/Web tab can instead represent a different earlier item.
    const assignedId = row.kind === "annotate" && cold.kind === "annotate" && row.id === cold.id
      && row.hash === cold.hash && Boolean(row.docId) !== Boolean(cold.docId);
    return !assignedId;
  })].slice(0,RECENT_WORKSPACE_LIMIT);
  if (JSON.stringify(before) === JSON.stringify(next)) return;
  try {
    localStorage.setItem(RECENT_WORKSPACES_KEY,JSON.stringify({v:1,tabs:next}));
    if (typeof window !== "undefined") window.dispatchEvent(new Event(RECENT_WORKSPACES_EVENT));
  } catch { /* History is optional; quota must never block opening or closing work. */ }
}

/** Hide current tabs and removed work; labels follow library renames. */
export function visibleRecentWorkspaces(history: TabRecord[], openTabs: TabRecord[]): TabRecord[] {
  const openKeys = new Set(openTabs.map(recentWorkspaceKey));
  const docs = new Map(listAnnotateDocs().map(doc=>[doc.id,doc]));
  const notebooks = new Map(listWhiteboardNotebooks().map(book=>[book.id,book]));
  return history.flatMap<TabRecord>(tab=>{
    if (openKeys.has(recentWorkspaceKey(tab))) return [];
    if ((tab.kind === "annotate" || tab.kind === "web") && tab.docId) {
      const doc = docs.get(tab.docId);
      if (doc) return [{...tab,title:doc.label?.trim() || doc.name}];
      // A read-only session can have an id before it ever enters the library.
      // Keep its existing cached-file recovery, but never resurface trashed work.
      if (getAnnotateDocMeta(tab.docId)?.deletedAt) return [];
      if (tab.kind === "web" || tab.source || (tab.hash && (tab.docType === "pdf" || tab.docType === "epub"))) return [tab];
      return [];
    }
    if (tab.kind === "whiteboard") {
      const book = notebooks.get(tab.notebookId ?? "");
      return book ? [{...tab,title:book.title}] : [];
    }
    return [tab];
  });
}
