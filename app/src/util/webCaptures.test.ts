import { describe, expect, it } from "vitest";

import {
  addCapture,
  captureById,
  captureKeptSummary,
  currentCapture,
  likelyKind,
  neededCaptures,
  type WebCapture,
} from "./webCaptures";

function cap(id: string, at: number, html = `<p>${id}</p>`): WebCapture {
  return { id, capturedAt: at, html };
}

describe("likelyKind", () => {
  it("offers page for a path and feed for a bare host", () => {
    expect(likelyKind("https://newsletter.example.com/p/slug")).toBe("page");
    expect(likelyKind("https://x.com")).toBe("feed");
    expect(likelyKind("https://x.com/")).toBe("feed");
  });

  it("offers page for anything it cannot parse, rather than guessing feed", () => {
    // Wrong in the safe direction: "page" replaces and never accumulates, and
    // the first stranding reclassifies it anyway.
    expect(likelyKind("not a url")).toBe("page");
  });
});

describe("addCapture", () => {
  const now = 1000;

  it("replaces when nothing needs the old one", () => {
    // The common case, and it stays the common case: an article you re-froze.
    const out = addCapture({
      existing: [cap("a", 10)],
      html: "<p>new</p>",
      now,
      needed: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.html).toBe("<p>new</p>");
  });

  it("keeps a capture a stranded mark still stands on", () => {
    const out = addCapture({
      existing: [cap("a", 10)],
      html: "<p>new</p>",
      now,
      needed: ["a"],
    });
    expect(out.map((row) => row.id)).toEqual([out[0]!.id, "a"]);
    expect(out[0]?.capturedAt).toBe(now);
  });

  it("does not accumulate on a page that keeps stranding the same one mark", () => {
    /*
     * The retention rule's whole point. An approximately static page — one
     * mark that vanished, the rest fine — keeps exactly two captures however
     * many times you visit, because only one old capture is ever needed.
     */
    let captures = addCapture({
      existing: [cap("a", 10)],
      html: "<p>v2</p>",
      now: 20,
      needed: ["a"],
    });
    expect(captures).toHaveLength(2);
    captures = addCapture({
      existing: captures,
      html: "<p>v3</p>",
      now: 30,
      needed: ["a"],
    });
    expect(captures).toHaveLength(2);
    expect(captures.map((row) => row.id).includes("a")).toBe(true);
  });

  it("keeps every capture for a pad the reader called a feed", () => {
    /*
     * Foreknowledge buys what evidence cannot. A news homepage whose story is
     * still there today has every mark re-anchor, so evidence says "replace"
     * and throws away the capture those marks will need tomorrow.
     */
    const out = addCapture({
      existing: [cap("a", 10), cap("b", 5)],
      html: "<p>new</p>",
      now,
      needed: [],
      kind: "feed",
    });
    expect(out).toHaveLength(3);
  });

  it("sorts newest first, so the pad renders the latest", () => {
    const out = addCapture({
      existing: [cap("old", 5), cap("mid", 50)],
      html: "<p>new</p>",
      now: 20,
      needed: ["old", "mid"],
    });
    expect(out.map((row) => row.capturedAt)).toEqual([50, 20, 5]);
    expect(currentCapture(out)?.capturedAt).toBe(50);
  });
});

describe("neededCaptures", () => {
  it("names only the captures under a mark that could not move forward", () => {
    const needed = neededCaptures(
      [
        { id: "m1", captureId: "a" },
        { id: "m2", captureId: "a" },
        { id: "m3", captureId: "b" },
      ],
      new Set(["m1"]),
    );
    expect(needed).toEqual(["a"]);
  });

  it("ignores a mark made before captures existed", () => {
    // No `captureId` means there was only ever one capture to be made against.
    expect(neededCaptures([{ id: "m1" }], new Set(["m1"]))).toEqual([]);
  });

  it("needs nothing when every mark re-anchored", () => {
    expect(
      neededCaptures([{ id: "m1", captureId: "a" }], new Set()),
    ).toEqual([]);
  });
});

describe("captureById", () => {
  it("finds the capture a mark was made on, and tolerates one that is gone", () => {
    const rows = [cap("a", 10), cap("b", 5)];
    expect(captureById(rows, "b")?.html).toBe("<p>b</p>");
    expect(captureById(rows, "missing")).toBeNull();
    expect(captureById(rows, undefined)).toBeNull();
  });
});

describe("captureKeptSummary", () => {
  it("counts the marks and says where their page went", () => {
    expect(captureKeptSummary(1, 9)).toContain("1 mark is");
    expect(captureKeptSummary(7, 9)).toContain("7 marks are");
    expect(captureKeptSummary(7, 9)).toContain("of 9");
    expect(captureKeptSummary(7, 9)).toContain("kept");
  });

  it("says nothing when nothing stranded", () => {
    expect(captureKeptSummary(0, 9)).toBe("");
  });
});
