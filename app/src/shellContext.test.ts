import { describe, expect, it } from "vitest";

import { chromeLooksSame, NO_CHROME, type WorkspaceChrome } from "./shellContext";

function chrome(patch: Partial<WorkspaceChrome["docIndex"]>): WorkspaceChrome {
  return { ...NO_CHROME, docIndex: { ...NO_CHROME.docIndex, ...patch } };
}

describe("chromeLooksSame", () => {
  it("treats index progress as a visible change", () => {
    const indexing = chrome({ status: "indexing", indexProgress: null });
    expect(chromeLooksSame(indexing, indexing)).toBe(true);
    expect(
      chromeLooksSame(indexing, chrome({ status: "indexing", indexProgress: { done: 12, total: 40 } })),
    ).toBe(false);
  });

  it("treats embed progress as a visible change", () => {
    const a = chrome({ status: "indexed", embedding: true, embedProgress: { done: 1, total: 10 } });
    const b = chrome({ status: "indexed", embedding: true, embedProgress: { done: 4, total: 10 } });
    expect(chromeLooksSame(a, b)).toBe(false);
  });

  it("treats a walk-stage change as a visible change", () => {
    // Workspace publishes walk reports through chrome. If this compared equal,
    // the tab would keep the last Index frame while the pill moved on to Pad.
    const indexing = chrome({ walkStage: "index", walkJob: "extract" });
    expect(chromeLooksSame(indexing, chrome({ walkStage: "pad" }))).toBe(false);
    expect(chromeLooksSame(indexing, chrome({ walkStage: "index", walkJob: null }))).toBe(false);
    expect(
      chromeLooksSame(
        chrome({ walkStage: "pad" }),
        chrome({ walkStage: "pad", walkWaiting: "conflict" }),
      ),
    ).toBe(false);
  });
});
