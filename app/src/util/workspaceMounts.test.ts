import { describe, expect, it } from "vitest";

import { bumpRetry, planWorkspaceMounts, workspaceMountKey } from "./workspaceMounts";

type Tab = { id: string };

const tabs: Tab[] = [{ id: "home" }, { id: "a" }, { id: "b" }];

function live(entries: Array<[string, boolean, boolean]>) {
  return entries.map(([id, active, showing]) => ({
    tab: { id },
    active,
    showing,
  }));
}

describe("workspaceMountKey", () => {
  it("does not change when a tab gains or loses focus", () => {
    expect(workspaceMountKey("a", {})).toBe("a:0");
    expect(workspaceMountKey("a", { b: 3 })).toBe("a:0");
  });

  it("changes only for the tab that retried", () => {
    const retried = bumpRetry({}, "a");
    expect(workspaceMountKey("a", retried)).toBe("a:1");
    expect(workspaceMountKey("b", retried)).toBe("b:0");
  });

  it("keeps other tabs' generations when one retries again", () => {
    const once = bumpRetry({}, "a");
    const twice = bumpRetry(bumpRetry(once, "b"), "a");
    expect(twice).toEqual({ a: 2, b: 1 });
  });
});

describe("planWorkspaceMounts", () => {
  it("keeps every mounted workspace in one list across a switch", () => {
    const before = planWorkspaceMounts({
      liveTabs: live([
        ["a", true, true],
        ["b", false, false],
      ]),
      allTabs: tabs,
      visibleIds: ["a"],
      groupChildren: null,
      activeId: "a",
    });
    const after = planWorkspaceMounts({
      liveTabs: live([
        ["b", true, true],
        ["a", false, false],
      ]),
      allTabs: tabs,
      visibleIds: ["b"],
      groupChildren: null,
      activeId: "b",
    });

    // Same tabs, same keys — only `showing`/`active` moved.
    expect(before.map((m) => workspaceMountKey(m.tab.id, {})).sort()).toEqual(
      after.map((m) => workspaceMountKey(m.tab.id, {})).sort(),
    );
    expect(before.find((m) => m.tab.id === "b")?.showing).toBe(false);
    expect(after.find((m) => m.tab.id === "b")?.showing).toBe(true);
    expect(after.find((m) => m.tab.id === "a")?.showing).toBe(false);
  });

  it("assigns split roles from the group's children", () => {
    const mounts = planWorkspaceMounts({
      liveTabs: live([
        ["a", true, true],
        ["b", false, true],
      ]),
      allTabs: tabs,
      visibleIds: ["a", "b"],
      groupChildren: ["a", "b"],
      activeId: "a",
    });
    expect(mounts.map((m) => [m.tab.id, m.splitRole])).toEqual([
      ["a", "a"],
      ["b", "b"],
    ]);
    expect(mounts.every((m) => m.showing && m.onScreen)).toBe(true);
  });

  it("leaves a tab outside the split parked, without moving it", () => {
    const mounts = planWorkspaceMounts({
      liveTabs: live([
        ["a", true, true],
        ["b", false, true],
        ["home", false, false],
      ]),
      allTabs: tabs,
      visibleIds: ["a", "b"],
      groupChildren: ["a", "b"],
      activeId: "a",
    });
    const home = mounts.find((m) => m.tab.id === "home");
    expect(home?.splitRole).toBeNull();
    expect(home?.showing).toBe(false);
    expect(mounts).toHaveLength(3);
  });

  it("keeps the Home overlay showing while it is not on screen", () => {
    const mounts = planWorkspaceMounts({
      liveTabs: live([
        ["a", true, true],
        ["home", false, true],
      ]),
      allTabs: tabs,
      visibleIds: ["a"],
      groupChildren: null,
      activeId: "a",
    });
    const home = mounts.find((m) => m.tab.id === "home");
    expect(home?.showing).toBe(true);
    expect(home?.onScreen).toBe(false);
    expect(home?.splitRole).toBeNull();
  });

  it("mounts an on-screen tab the live set has not caught up with", () => {
    const mounts = planWorkspaceMounts({
      liveTabs: live([["a", false, false]]),
      allTabs: tabs,
      visibleIds: ["b"],
      groupChildren: null,
      activeId: "b",
    });
    expect(mounts.map((m) => m.tab.id)).toEqual(["a", "b"]);
    const b = mounts.find((m) => m.tab.id === "b");
    expect(b?.active).toBe(true);
    expect(b?.showing).toBe(true);
  });

  it("ignores a visible id with no tab record", () => {
    const mounts = planWorkspaceMounts({
      liveTabs: live([["a", true, true]]),
      allTabs: tabs,
      visibleIds: ["a", "gone"],
      groupChildren: null,
      activeId: "a",
    });
    expect(mounts.map((m) => m.tab.id)).toEqual(["a"]);
  });
});
