import { describe, expect, it } from "vitest";

import {
  addFootnote,
  numberFootnotes,
  orderScopes,
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
    anchor: { kind: "text", start: 10, end: 20 },
    excerpt: "hash maps",
    createdAt: 1,
    ...patch,
  };
}

describe("addFootnote", () => {
  it("keeps footnotes in reading order", () => {
    const list = addFootnote(
      addFootnote([], footnote({ id: "b", anchor: { kind: "text", start: 90, end: 95 } })),
      footnote({ id: "a", anchor: { kind: "text", start: 3, end: 5 } }),
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
      addFootnote([], footnote({ id: "p1", anchor: { kind: "text", start: 1, end: 4, scope: "page-1" } })),
      footnote({ id: "p2", anchor: { kind: "text", start: 1, end: 4, scope: "page-2" } }),
    );
    expect(list).toHaveLength(2);
  });
});

describe("removeFootnote", () => {
  it("drops only the named one", () => {
    const list = [footnote({ id: "a" }), footnote({ id: "b", anchor: { kind: "text", start: 40, end: 45 } })];
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
      { id: "x", kind: "shrug", anchor: { kind: "text", start: 1, end: 2 } },
      { id: "y", kind: "coach", anchor: { kind: "text", start: 5, end: 5 } },
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


describe("numbering", () => {
  const at = (start: number, scope?: string) =>
    footnote({
      id: `fn-${scope ?? "x"}-${start}`,
      anchor: { kind: "text" as const, start, end: start + 4, ...(scope ? { scope } : {}) },
    });

  it("numbers by position in the document", () => {
    const numbers = numberFootnotes([at(90), at(3), at(40)]);
    expect(numbers.get("fn-x-3")).toBe(1);
    expect(numbers.get("fn-x-40")).toBe(2);
    expect(numbers.get("fn-x-90")).toBe(3);
  });

  it("follows page order, not page name", () => {
    // "p10" sorts before "p2" as a string; the reader sees page 2 first.
    orderScopes(["p2", "p10"]);
    const numbers = numberFootnotes([at(5, "p10"), at(5, "p2")]);
    expect(numbers.get("fn-p2-5")).toBe(1);
    expect(numbers.get("fn-p10-5")).toBe(2);
  });

  it("renumbers when one is removed, leaving no hole", () => {
    orderScopes([]);
    const all = [at(3), at(40), at(90)];
    const numbers = numberFootnotes(removeFootnote(all, "fn-x-40"));
    expect(numbers.get("fn-x-90")).toBe(2);
  });

  it("orders a region by where it sits on the page", () => {
    orderScopes([]);
    const region = footnote({
      id: "region",
      kind: "note",
      anchor: { kind: "region", x: 0, y: 5, w: 100, h: 20 },
    });
    const numbers = numberFootnotes([region, at(400)]);
    // The region's y (5) puts it before an offset of 400 in the same scope.
    expect(numbers.get("region")).toBe(1);
  });
});

describe("region anchors", () => {
  const region = (x: number, y: number) =>
    footnote({
      id: `r-${x}-${y}`,
      kind: "note" as const,
      anchor: { kind: "region" as const, x, y, w: 50, h: 20 },
    });

  it("replaces a mark of the same kind on the same rectangle", () => {
    const list = addFootnote(addFootnote([], region(10, 10)), region(10, 10));
    expect(list).toHaveLength(1);
  });

  it("ignores sub-pixel jitter between two sweeps of the same area", () => {
    const a = region(10, 10);
    const b = footnote({
      id: "b",
      kind: "note",
      anchor: { kind: "region", x: 10.2, y: 9.8, w: 50.1, h: 20.4 },
    });
    expect(addFootnote(addFootnote([], a), b)).toHaveLength(1);
  });

  it("keeps two marks in genuinely different places", () => {
    expect(addFootnote(addFootnote([], region(10, 10)), region(10, 200))).toHaveLength(2);
  });

  it("never confuses a region with a text anchor", () => {
    const list = addFootnote(addFootnote([], region(10, 10)), footnote({ id: "t", kind: "note" }));
    expect(list).toHaveLength(2);
  });
});

describe("sanitizeFootnotes migration", () => {
  it("reads an anchor written before the kind existed as a text anchor", () => {
    const kept = sanitizeFootnotes([
      { id: "old", kind: "search", anchor: { start: 4, end: 9 }, excerpt: "x", createdAt: 1 },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].anchor).toEqual({ kind: "text", start: 4, end: 9 });
  });

  it("keeps a region anchor", () => {
    const kept = sanitizeFootnotes([
      {
        id: "r",
        kind: "note",
        anchor: { kind: "region", x: 1, y: 2, w: 3, h: 4, scope: "p7" },
        excerpt: "",
        createdAt: 1,
      },
    ]);
    expect(kept[0].anchor).toEqual({ kind: "region", x: 1, y: 2, w: 3, h: 4, scope: "p7" });
  });

  it("drops a region with no area", () => {
    expect(
      sanitizeFootnotes([
        { id: "r", kind: "note", anchor: { kind: "region", x: 1, y: 2, w: 0, h: 4 } },
      ]),
    ).toEqual([]);
  });
});
