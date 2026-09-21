import { describe, expect, it } from "vitest";
import { artifactTab } from "./artifactTabs";
import { initialTabState, sameEntity, tabsReducer } from "./tabs";
import { serializeTabState } from "./tabPersist";
import { tabAllowsRename } from "./libraryPadRename";

describe("attachment tabs", () => {
  it("restores parent-owned tabs without creating standalone library IDs", () => {
    const reference = { parent: { kind: "annotate" as const, id: "book" }, artifactId: "answer", kind: "markdown" as const };
    const tab = artifactTab(reference, "Answer.md");
    const state = tabsReducer(initialTabState(), { type: "open", tab, at: 1 });
    const restored = serializeTabState(state).tabs.find(item => item.id === tab.id)!;
    expect(restored.artifact).toEqual(reference);
    expect(restored).toMatchObject({ docId: null, hash: null });
    expect(tabAllowsRename(restored)).toBe(false);
    expect(sameEntity(tab, artifactTab(reference, "Renamed"))).toBe(true);
    expect(sameEntity(tab, artifactTab({ ...reference, parent: { ...reference.parent, id: "other set" } }, "Answer.md"))).toBe(false);
  });
});
