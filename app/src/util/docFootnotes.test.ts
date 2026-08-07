import { describe, expect, it } from "vitest";

import {
  addFootnote,
  freshFootnoteId,
  googleSearchUrl,
  removeFootnote,
  sanitizeFootnotes,
  searchQueryFor,
  type DocFootnote,
} from "./docFootnotes";

function footnote(patch: Partial<DocFootnote> = {}): DocFootnote {
  return {
    id: "fn-1",
    kind: "coach",
    anchor: { start: 10, end: 20 },
    excerpt: "hash maps",
    createdAt: 1,
    ...patch,
  };
}

describe("addFootnote", () => {
  it("keeps footnotes in reading order", () => {
    const list = addFootnote(
      addFootnote([], footnote({ id: "b", anchor: { start: 90, end: 95 } })),
      footnote({ id: "a", anchor: { start: 3, end: 5 } }),
    );
    expect(list.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("replaces a footnote of the same kind on the same words", () => {
    // Asking twice about one sentence is normal; two stacked ribbons the
    // writer has to tell apart by pixel is not.
    const first = addFootnote([], footnote({ id: "old", threadRootId: "t1" }));
    const second = addFootnote(first, footnote({ id: "new", threadRootId: "t2" }));
    expect(second).toHaveLength(1);
    expect(second[0].threadRootId).toBe("t2");
  });

  it("lets a search and a thread share the same words", () => {
    const list = addFootnote(
      addFootnote([], footnote({ id: "coach", kind: "coach" })),
      footnote({ id: "search", kind: "search", query: "hash maps" }),
    );
    expect(list).toHaveLength(2);
  });

  it("treats the same offsets in different scopes as different places", () => {
    const list = addFootnote(
      addFootnote([], footnote({ id: "p1", anchor: { start: 1, end: 4, scope: "page-1" } })),
      footnote({ id: "p2", anchor: { start: 1, end: 4, scope: "page-2" } }),
    );
    expect(list).toHaveLength(2);
  });
});

describe("removeFootnote", () => {
  it("drops only the named one", () => {
    const list = [footnote({ id: "a" }), footnote({ id: "b", anchor: { start: 40, end: 45 } })];
    expect(removeFootnote(list, "a").map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("freshFootnoteId", () => {
  it("does not collide inside one millisecond", () => {
    const first = freshFootnoteId([], 1700000000000);
    const second = freshFootnoteId([footnote({ id: first })], 1700000000000);
    expect(second).not.toBe(first);
  });
});

describe("sanitizeFootnotes", () => {
  it("drops anything that is not a footnote", () => {
    const kept = sanitizeFootnotes([
      footnote(),
      null,
      "nope",
      { id: "x", kind: "shrug", anchor: { start: 1, end: 2 } },
      { id: "y", kind: "coach", anchor: { start: 5, end: 5 } },
      { id: "z", kind: "coach" },
    ]);
    expect(kept.map((entry) => entry.id)).toEqual(["fn-1"]);
  });

  it("returns an empty list for a corrupt blob", () => {
    expect(sanitizeFootnotes(undefined)).toEqual([]);
    expect(sanitizeFootnotes({ nope: true })).toEqual([]);
  });
});

describe("searchQueryFor", () => {
  it("cuts a paragraph down to something someone would have typed", () => {
    const query = searchQueryFor("one two three four five", 3);
    expect(query).toBe("one two three");
  });

  it("flattens whitespace", () => {
    expect(searchQueryFor("  hash \n maps  ")).toBe("hash maps");
  });

  it("is empty for empty input, so callers can skip the search", () => {
    expect(searchQueryFor("   \n  ")).toBe("");
  });
});

describe("googleSearchUrl", () => {
  it("escapes the query", () => {
    expect(googleSearchUrl("a&b c")).toBe("https://www.google.com/search?q=a%26b%20c");
  });
});
