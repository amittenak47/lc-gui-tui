import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TAB_STRIP_KEY, loadTabState, parseTabState, saveTabState, serializeTabState } from "./tabPersist";
import {
  HOME_TAB_ID,
  initialTabState,
  newTabId,
  tabsReducer,
  type AnnotateTab,
  type TabState,
  type WebTab,
  type WhiteboardTab,
} from "./tabs";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => vi.unstubAllGlobals());

function board(id: string, notebookId: string): WhiteboardTab {
  return { id, kind: "whiteboard", title: "doodle", dirty: true, lastActive: 1, notebookId };
}

function doc(id: string, extra: Partial<AnnotateTab> = {}): AnnotateTab {
  return {
    id,
    kind: "annotate",
    title: "notes.md",
    dirty: false,
    lastActive: 1,
    docId: "d-1",
    hash: "h-1",
    docType: "markdown",
    indexed: "indexing",
    source: null,
    ...extra,
  };
}

function web(id: string): WebTab {
  return {
    id,
    kind: "web",
    title: "example.com",
    dirty: false,
    lastActive: 1,
    indexed: "indexed",
    entries: [{ url: "https://example.com/", title: "Example", html: "<html>big</html>" }],
    index: 0,
  };
}

describe("serializeTabState", () => {
  it("keeps Home first and drops a blank whiteboard", () => {
    const state: TabState = {
      tabs: [
        { id: HOME_TAB_ID, kind: "home", title: "Home", dirty: false, lastActive: 0 },
        board("b1", "nb-1"),
        { id: "b2", kind: "whiteboard", title: "scratch", dirty: true, lastActive: 2, notebookId: null },
      ],
      activeId: "b1",
      groups: [],
    };
    const serial = serializeTabState(state);
    expect(serial.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "b1"]);
    expect(serial.tabs[1]).toMatchObject({ dirty: false, notebookId: "nb-1" });
  });

  it("strips captured HTML and clears in-flight index status", () => {
    const state: TabState = {
      tabs: [
        { id: HOME_TAB_ID, kind: "home", title: "Home", dirty: false, lastActive: 0 },
        web("w1"),
        doc("d1"),
      ],
      activeId: "w1",
      groups: [],
    };
    const serial = serializeTabState(state);
    const page = serial.tabs.find((tab) => tab.id === "w1") as WebTab;
    expect(page.entries[0]?.html).toBe("");
    expect(page.entries[0]?.url).toBe("https://example.com/");
    expect(serial.tabs.find((tab) => tab.id === "d1")).toMatchObject({ indexed: "idle" });
  });

  it("keeps a split only when both children survive", () => {
    const state: TabState = {
      tabs: [
        { id: HOME_TAB_ID, kind: "home", title: "Home", dirty: false, lastActive: 0 },
        board("b1", "nb-1"),
        { id: "b2", kind: "whiteboard", title: "gone", dirty: false, lastActive: 2, notebookId: null },
      ],
      activeId: "b1",
      groups: [{ id: "group-1", children: ["b1", "b2"], split: { axis: "vertical", ratio: 0.4 } }],
    };
    const serial = serializeTabState(state);
    expect(serial.groups).toEqual([]);
    expect(serial.tabs.find((tab) => tab.id === "b1")?.group).toBeUndefined();
  });
});

describe("loadTabState / saveTabState", () => {
  it("round-trips a notebook and a document", () => {
    const state = tabsReducer(
      tabsReducer(initialTabState(), { type: "open", tab: board("b1", "nb-1"), at: 1 }),
      { type: "open", tab: doc("d1"), at: 2 },
    );
    saveTabState(state);
    expect(localStorage.getItem(TAB_STRIP_KEY)).toContain("nb-1");
    const loaded = loadTabState(9);
    expect(loaded.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "b1", "d1"]);
    expect(loaded.activeId).toBe("d1");
  });

  it("keeps unsaved markdown on the chip even when a hash and docId exist", () => {
    const state = tabsReducer(
      initialTabState(),
      { type: "open", tab: doc("d1", { source: "# still only on the tab" }), at: 2 },
    );
    saveTabState(state);
    const loaded = loadTabState(9);
    const annotate = loaded.tabs.find((tab) => tab.id === "d1");
    expect(annotate).toMatchObject({
      hash: "h-1",
      docId: "d-1",
      source: "# still only on the tab",
    });
  });

  it("falls back to Home on junk", () => {
    localStorage.setItem(TAB_STRIP_KEY, "{not json");
    expect(loadTabState(3).activeId).toBe(HOME_TAB_ID);
    expect(parseTabState({ v: 2, tabs: [] }, 3)).toBeNull();
  });

  it("does not reuse a restored id for a new tab", () => {
    saveTabState({
      tabs: [
        { id: HOME_TAB_ID, kind: "home", title: "Home", dirty: false, lastActive: 0 },
        board("whiteboard-9", "nb-9"),
      ],
      activeId: "whiteboard-9",
      groups: [],
    });
    loadTabState();
    const id = newTabId("whiteboard");
    expect(Number(id.slice("whiteboard-".length))).toBeGreaterThanOrEqual(10);
  });
});
