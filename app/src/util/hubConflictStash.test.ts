import { afterEach, describe, expect, it } from "vitest";

import type { DocFootnote } from "./docFootnotes";
import {
  clearHubConflict,
  entrySettled,
  footnoteDiffRows,
  hubConflict,
  inkChoiceOf,
  mergeFootnotes,
  stashHubConflict,
  subscribeHubConflict,
} from "./hubConflictStash";

function note(id: string, excerpt = `quote ${id}`, extra: Partial<DocFootnote> = {}): DocFootnote {
  return {
    id,
    kind: "note",
    anchor: { page: 1, start: 0, end: 5 } as unknown as DocFootnote["anchor"],
    excerpt,
    createdAt: 1000,
    ...extra,
  };
}

afterEach(() => {
  clearHubConflict();
});

describe("footnoteDiffRows", () => {
  it("lines both sides up by id and flags the marks that exist on each", () => {
    const rows = footnoteDiffRows([note("a"), note("b")], [note("a", "quote a"), note("c")]);
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    const a = rows[0]!;
    expect(a.sameId).toBe(true);
    // Same excerpt → same body; only createdAt/anchor matter beyond that.
    expect(a.differs).toBe(false);
    expect(rows[1]!.sameId).toBe(false);
  });

  it("flags a same-id mark whose bodies are not equal", () => {
    const rows = footnoteDiffRows(
      [note("a", "one wording")],
      [note("a", "another wording")],
    );
    expect(rows[0]!.differs).toBe(true);
  });
});

describe("entrySettled", () => {
  it("is settled when either side is kept", () => {
    expect(entrySettled(true, true, { local: true })).toBe(true);
    expect(entrySettled(true, true, { server: true })).toBe(true);
  });

  it("needs ✕ on every side that has a copy before a drop counts", () => {
    expect(entrySettled(true, true, { local: false })).toBe(false);
    expect(entrySettled(true, true, { local: false, server: false })).toBe(true);
    expect(entrySettled(true, false, { local: false })).toBe(true);
  });

  it("treats an empty entry as already settled", () => {
    expect(entrySettled(false, false, undefined)).toBe(true);
  });
});

describe("mergeFootnotes (the plan's ✓ rules)", () => {
  it("keeps one copy of a side-only mark when its pane is kept, drops it otherwise", () => {
    const localOnly = [note("local-1")];
    expect(mergeFootnotes(localOnly, [], { local: true, server: false })).toHaveLength(1);
    expect(mergeFootnotes([], [note("srv-1")], { local: false, server: true })).toHaveLength(1);
    expect(mergeFootnotes([], [note("srv-1")], { local: true, server: false })).toHaveLength(0);
  });

  it("yields two notes for a same-id-different-body row ✓'d on both sides", () => {
    const merged = mergeFootnotes(
      [note("a", "here")],
      [note("a", "there")],
      { local: true, server: true },
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.excerpt).sort()).toEqual(["here", "there"]);
  });

  it("lets an explicit pick override the pane default for that mark alone", () => {
    const merged = mergeFootnotes(
      [note("a", "mine"), note("b")],
      [note("a", "theirs")],
      { local: true, server: false },
      { a: { local: false, server: true } },
    );
    expect(merged.map((row) => row.id)).toEqual(["a", "b"]);
    expect(merged[0]!.excerpt).toBe("theirs");
  });
});

describe("stash store", () => {
  it("notifies subscribers and clears to null", () => {
    let seen = hubConflict();
    const stop = subscribeHubConflict(() => {
      seen = hubConflict();
    });
    expect(seen).toBeNull();

    stashHubConflict({
      kind: "annotate",
      id: "p1",
      stage: "pad",
      detail: "both changed",
      local: null,
      server: null,
    });
    expect(seen?.id).toBe("p1");

    clearHubConflict();
    expect(seen).toBeNull();
    stop();
  });
});

describe("inkChoiceOf", () => {
  it("follows an explicit ink field", () => {
    expect(inkChoiceOf({ pick: "local", ink: "none" })).toBe("none");
    expect(inkChoiceOf({ pick: "server", ink: "merged" })).toBe("merged");
  });

  it("follows the pane when ink was not named", () => {
    expect(inkChoiceOf({ pick: "local" })).toBe("local");
    expect(inkChoiceOf({ pick: "server" })).toBe("server");
    expect(inkChoiceOf({ pick: "merged" })).toBe("merged");
  });
});
