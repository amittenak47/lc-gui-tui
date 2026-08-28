import { describe, expect, it } from "vitest";

import { conflictFocusPage, pageFromNote, pageFromScope } from "./conflictPage";

describe("pageFromScope", () => {
  it("reads p7, page-1, and a bare number", () => {
    expect(pageFromScope("p7")).toBe(7);
    expect(pageFromScope("page-1")).toBe(1);
    expect(pageFromScope("page_2")).toBe(2);
    expect(pageFromScope("40")).toBe(40);
  });

  it("ignores chapter hrefs and empty values", () => {
    expect(pageFromScope("chapter-4.xhtml")).toBeNull();
    expect(pageFromScope("")).toBeNull();
    expect(pageFromScope(undefined)).toBeNull();
  });
});

describe("conflictFocusPage", () => {
  it("prefers the note's scope over ink", () => {
    expect(
      conflictFocusPage({
        note: {
          id: "n",
          kind: "note",
          anchor: { kind: "text", start: 0, end: 1, scope: "p4" },
          excerpt: "x",
          createdAt: 1,
        },
        inkPageId: 9,
      }),
    ).toBe(4);
  });

  it("falls back to ink, then page 1", () => {
    expect(conflictFocusPage({ inkPageId: 3 })).toBe(3);
    expect(conflictFocusPage({ ink: [{ kind: "annotate", key: "p", page_id: 8, updated_at: 1, gz: "" }] })).toBe(8);
    expect(conflictFocusPage({})).toBe(1);
  });
});

describe("pageFromNote", () => {
  it("is null when the anchor has no page scope", () => {
    expect(
      pageFromNote({
        id: "n",
        kind: "note",
        anchor: { kind: "text", start: 0, end: 1, scope: "ch1.xhtml" },
        excerpt: "x",
        createdAt: 1,
      }),
    ).toBeNull();
  });
});
