import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadStartupTabs,
  saveStartupTabs,
  startupTabState,
} from "./startupTabsPref";
import { HOME_TAB_ID, homeTab, visibleTabIds, type TabState, type WhiteboardTab } from "./tabs";

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

function board(id: string, group?: string): WhiteboardTab {
  return { id, kind: "whiteboard", title: id, dirty: false, lastActive: 1, notebookId: `nb-${id}`, group };
}

const saved: TabState = {
  tabs: [homeTab(5), board("a", "g"), board("b", "g"), board("c")],
  activeId: "a",
  groups: [{ id: "g", children: ["a", "b"], split: { axis: "vertical", ratio: 0.5 } }],
};

describe("startup tabs pref", () => {
  it("restores by default", () => {
    expect(loadStartupTabs()).toBe("restore");
  });

  it("round-trips and ignores junk", () => {
    saveStartupTabs("home");
    expect(loadStartupTabs()).toBe("home");
    localStorage.setItem("whiteboard.startupTabs.v1", "sideways");
    expect(loadStartupTabs()).toBe("restore");
  });
});

describe("startupTabState", () => {
  it("leaves the strip alone when restoring", () => {
    expect(startupTabState(saved, "restore")).toBe(saved);
  });

  it("keeps every chip but lands on Home", () => {
    const next = startupTabState(saved, "home");
    expect(next.tabs).toBe(saved.tabs);
    expect(next.groups).toBe(saved.groups);
    expect(next.activeId).toBe(HOME_TAB_ID);
    // Only Home is on screen, so only Home mounts.
    expect(visibleTabIds(next)).toEqual([HOME_TAB_ID]);
  });

  it("starts fresh with Home alone", () => {
    const next = startupTabState(saved, "fresh");
    expect(next.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID]);
    expect(next.groups).toEqual([]);
    expect(next.activeId).toBe(HOME_TAB_ID);
  });
});
