import { describe, expect, it } from "vitest";

import {
  HOME_TAB_ID,
  PRACTICE_TAB_LIMIT,
  WEB_TAB_LIMIT,
  type AnnotateTab,
  type TabRecord,
  type TabState,
  type WebTab,
  activeTab,
  initialTabState,
  liveOverflow,
  promoteLive,
  sameEntity,
  tabsReducer,
  openTarget,
  webTabCount,
  webTabTitle,
} from "./tabs";

const entry = (url: string) => ({ url, title: url, html: `<p>${url}</p>` });

function web(id: string, url: string, lastActive = 0): WebTab {
  return {
    id,
    kind: "web",
    title: webTabTitle(entry(url)),
    dirty: false,
    lastActive,
    indexed: "idle",
    entries: [entry(url)],
    index: 0,
  };
}

function board(id: string, notebookId: string | null, lastActive = 0): TabRecord {
  return { id, kind: "whiteboard", title: "Whiteboard", dirty: false, lastActive, notebookId };
}

function doc(id: string, hash: string | null, lastActive = 0): AnnotateTab {
  return {
    id,
    kind: "annotate",
    title: "notes.md",
    dirty: false,
    lastActive,
    docId: null,
    hash,
    docType: "markdown",
    indexed: "idle",
    source: null,
  };
}

function problem(id: string, taskId: string, dataset = "leetcode"): TabRecord {
  return { id, kind: "practice", title: taskId, dirty: false, lastActive: 0, dataset, taskId };
}

/** Fold a script of actions so the arrange step of each test stays one line. */
function run(state: TabState, ...actions: Parameters<typeof tabsReducer>[1][]): TabState {
  return actions.reduce(tabsReducer, state);
}

describe("the mount budget", () => {
  it("puts the tab just looked at at the front", () => {
    expect(promoteLive(["home"], "b1")).toEqual(["b1", "home"]);
    expect(promoteLive(["b1", "home"], "home")).toEqual(["home", "b1"]);
  });

  it("keeps the list unique — coming back is a move, not a second entry", () => {
    const ids = promoteLive(promoteLive(["home"], "b1"), "home");
    expect(promoteLive(ids, "b1")).toEqual(["b1", "home"]);
  });

  it("returns the same array when nothing moved, so no needless remount", () => {
    const ids = ["b1", "home"];
    expect(promoteLive(ids, "b1")).toBe(ids);
  });

  it("names the tabs past the limit, oldest last", () => {
    expect(liveOverflow(["a"], 2)).toEqual([]);
    expect(liveOverflow(["a", "b"], 2)).toEqual([]);
    expect(liveOverflow(["a", "b", "c", "d"], 2)).toEqual(["c", "d"]);
  });

  it("keeps the one just left mounted, and drops the one before it", () => {
    // Home → notebook → document: the notebook stays warm, Home falls off.
    let ids = ["home"];
    ids = promoteLive(ids, "b1");
    ids = promoteLive(ids, "d1");
    expect(ids.slice(0, 2)).toEqual(["d1", "b1"]);
    expect(liveOverflow(ids, 2)).toEqual(["home"]);
  });
});

describe("tabsReducer", () => {
  it("starts on Home and never closes it", () => {
    const start = initialTabState();
    expect(start.activeId).toBe(HOME_TAB_ID);
    expect(tabsReducer(start, { type: "close", id: HOME_TAB_ID })).toBe(start);
  });

  it("opens a workspace as a tab and focuses it", () => {
    const state = run(initialTabState(), { type: "open", tab: board("b1", null), at: 1 });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe("b1");
    expect(activeTab(state).kind).toBe("whiteboard");
  });

  it("focuses an existing workspace instead of opening a second tab for it", () => {
    const state = run(
      initialTabState(),
      { type: "open", tab: board("b1", "nb-7"), at: 1 },
      { type: "focus", id: HOME_TAB_ID, at: 2 },
      { type: "open", tab: board("b2", "nb-7"), at: 3 },
    );
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe("b1");
  });

  it("treats a workspace with no storage key yet as its own tab", () => {
    // Two blank notebooks are two notebooks — neither has an id to match on.
    const state = run(
      initialTabState(),
      { type: "open", tab: board("b1", null), at: 1 },
      { type: "open", tab: board("b2", null), at: 2 },
    );
    expect(state.tabs).toHaveLength(3);
    expect(sameEntity(board("b1", null), board("b2", null))).toBe(false);
    expect(sameEntity(doc("d1", null), doc("d2", null))).toBe(false);
  });

  it("matches annotate tabs on the content hash", () => {
    const state = run(
      initialTabState(),
      { type: "open", tab: doc("d1", "h-1"), at: 1 },
      { type: "open", tab: doc("d2", "h-1"), at: 2 },
    );
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe("d1");
  });

  it("caps web tabs and evicts the least recently used one", () => {
    const state = run(
      initialTabState(),
      { type: "open", tab: web("w1", "https://a.test/"), at: 1 },
      { type: "open", tab: web("w2", "https://b.test/"), at: 2 },
      { type: "focus", id: "w1", at: 3 },
      { type: "open", tab: web("w3", "https://c.test/"), at: 4 },
    );
    expect(webTabCount(state)).toBe(WEB_TAB_LIMIT);
    // w2 was the stale one; the page just asked for is never the one dropped.
    expect(state.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "w1", "w3"]);
    expect(state.activeId).toBe("w3");
  });

  it("leaves other kinds uncapped", () => {
    const state = run(
      initialTabState(),
      { type: "open", tab: board("b1", "nb-1"), at: 1 },
      { type: "open", tab: board("b2", "nb-2"), at: 2 },
      { type: "open", tab: board("b3", "nb-3"), at: 3 },
      { type: "open", tab: doc("d1", "h-1"), at: 4 },
    );
    expect(state.tabs).toHaveLength(5);
  });

  it("keeps Practice to one tab and moves it to the new problem", () => {
    const state = run(
      initialTabState(),
      { type: "open", tab: problem("p1", "two-sum"), at: 1 },
      { type: "open", tab: problem("p2", "add-two-numbers"), at: 2 },
    );
    expect(state.tabs.filter((tab) => tab.kind === "practice")).toHaveLength(PRACTICE_TAB_LIMIT);
    expect(state.activeId).toBe("p1");
    expect(activeTab(state)).toMatchObject({ id: "p1", taskId: "add-two-numbers" });
  });

  it("tells the caller which record an open will land on", () => {
    const state = run(initialTabState(), { type: "open", tab: problem("p1", "two-sum"), at: 1 });
    // The caller has to patch the record the reducer picked, not the one it proposed.
    expect(openTarget(state, problem("p2", "reverse-list"))?.id).toBe("p1");
    expect(openTarget(state, board("b1", null))).toBeNull();
  });

  it("keeps a practice tab out of the way of other kinds", () => {
    const state = run(
      initialTabState(),
      { type: "open", tab: problem("p1", "two-sum"), at: 1 },
      { type: "open", tab: board("b1", "nb-1"), at: 2 },
      { type: "open", tab: problem("p2", "three-sum"), at: 3 },
    );
    expect(state.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "p1", "b1"]);
    expect(state.activeId).toBe("p1");
  });

  it("closes onto the neighbour that took the slot", () => {
    const state = run(
      initialTabState(),
      { type: "open", tab: board("b1", "nb-1"), at: 1 },
      { type: "open", tab: board("b2", "nb-2"), at: 2 },
      { type: "close", id: "b2" },
    );
    expect(state.activeId).toBe("b1");
    expect(tabsReducer(state, { type: "close", id: "b1" }).activeId).toBe(HOME_TAB_ID);
  });

  it("keeps the active tab when a background tab closes", () => {
    const state = run(
      initialTabState(),
      { type: "open", tab: board("b1", "nb-1"), at: 1 },
      { type: "open", tab: board("b2", "nb-2"), at: 2 },
      { type: "close", id: "b1" },
    );
    expect(state.activeId).toBe("b2");
    expect(state.tabs).toHaveLength(2);
  });

  it("patches only the fields the kind actually has", () => {
    const state = run(
      initialTabState(),
      { type: "open", tab: board("b1", null), at: 1 },
      { type: "patch", id: "b1", patch: { notebookId: "nb-9", dirty: true, docId: "no" } },
    );
    const tab = activeTab(state);
    expect(tab).toMatchObject({ kind: "whiteboard", notebookId: "nb-9", dirty: true });
    expect(tab).not.toHaveProperty("docId");
  });

  it("drops the parked text once a save gives the tab a docId", () => {
    const parked: AnnotateTab = { ...doc("d1", "h-1"), source: "# notes" };
    const state = run(
      initialTabState(),
      { type: "open", tab: parked, at: 1 },
      { type: "patch", id: "d1", patch: { docId: "saved-1", source: null } },
    );
    expect(activeTab(state)).toMatchObject({ docId: "saved-1", source: null });
  });

  it("keeps the same object when a patch changes nothing", () => {
    const opened = run(initialTabState(), { type: "open", tab: board("b1", null), at: 1 });
    expect(tabsReducer(opened, { type: "patch", id: "b1", patch: { dirty: false } })).toBe(opened);
    expect(tabsReducer(opened, { type: "patch", id: "nope", patch: { dirty: true } })).toBe(opened);
  });

  it("relabels a web tab as its history moves", () => {
    const opened = run(initialTabState(), {
      type: "open",
      tab: web("w1", "https://www.google.com/"),
      at: 1,
    });
    expect(activeTab(opened).title).toBe("google.com");

    const pushed = tabsReducer(opened, {
      type: "web-push",
      id: "w1",
      entry: entry("https://news.ycombinator.com/"),
    });
    expect(activeTab(pushed).title).toBe("news.ycombinator.com");

    const back = tabsReducer(pushed, { type: "web-step", id: "w1", delta: -1 });
    expect(activeTab(back).title).toBe("google.com");
    expect((activeTab(back) as WebTab).index).toBe(0);
  });

  it("ignores a web step past the ends of the history", () => {
    const opened = run(initialTabState(), {
      type: "open",
      tab: web("w1", "https://a.test/"),
      at: 1,
    });
    const stepped = tabsReducer(opened, { type: "web-step", id: "w1", delta: -1 });
    expect((activeTab(stepped) as WebTab).index).toBe(0);
  });
});
