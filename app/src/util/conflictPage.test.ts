import { describe, expect, it } from "vitest";

import { conflictFocusPage, pageFromNote, pageFromScope, mergeInkDtos } from "./conflictPage";

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

describe("mergeInkDtos", () => {
  it("adds a fetched page without replacing the freeze preview", () => {
    const freeze = [{ kind: "annotate" as const, key: "p", page_id: 12, updated_at: 1, gz: "a" }];
    const extra = [{ kind: "annotate" as const, key: "p", page_id: 40, updated_at: 2, gz: "b" }];
    const merged = mergeInkDtos(freeze, extra);
    expect(merged.map((row) => row.page_id).sort((a, b) => a - b)).toEqual([12, 40]);
    expect(merged.find((row) => row.page_id === 12)?.gz).toBe("a");
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
