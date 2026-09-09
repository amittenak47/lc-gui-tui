import { afterEach, describe, expect, it } from "vitest";

import type { DocFootnote } from "./docFootnotes";
import {
  clearHubConflict,
  combineFootnotePair,
  entrySettled,
  footnoteDiffRows,
  footnotePartDiffs,
  footnotePartRowId,
  hubConflict,
  inkChoiceOf,
  mergeFootnotes,
  padInkDiffRows,
  footnoteInkDiffRows,
  stashHubConflict,
  subscribeHubConflict,
  visibleFootnoteDiffRows,
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

describe("visibleFootnoteDiffRows", () => {
  it("hides same-id marks whose bodies already match", () => {
    const rows = visibleFootnoteDiffRows(
      [note("a"), note("b")],
      [note("a"), note("c")],
    );
    expect(rows.map((row) => row.id)).toEqual(["b", "c"]);
  });
});

describe("footnotePartDiffs", () => {
  const noteEntry = (id: string, text: string) => ({
    id,
    text,
    createdAt: 1,
    updatedAt: 2,
  });

  it("names each changed piece instead of lumping the mark", () => {
    const parts = footnotePartDiffs(
      note("a", "here", {
        notes: [noteEntry("n1", "mine")],
        threads: [{ rootId: "t1", title: "Local chat", createdAt: 1 }],
        whiteboards: [{ id: "wb1", createdAt: 1, updatedAt: 2 }],
        subMarks: [
          { id: "s1", kind: "underline", excerpt: "one", start: 0, end: 1 },
        ],
      }),
      note("a", "there", {
        notes: [noteEntry("n2", "theirs")],
        threads: [{ rootId: "t2", title: "Hub chat", createdAt: 1 }],
        whiteboards: [{ id: "wb2", createdAt: 1, updatedAt: 2 }],
        subMarks: [
          { id: "s2", kind: "underline", excerpt: "two", start: 4, end: 5 },
        ],
      }),
    );
    expect(parts.map((part) => part.kind).sort()).toEqual([
      "boards",
      "boards",
      "chats",
      "chats",
      "notes",
      "notes",
      "underlines",
      "underlines",
    ]);
    expect(parts.some((part) => part.id === footnotePartRowId("a", "notes", "n1"))).toBe(
      true,
    );
  });

  it("skips pieces that already match", () => {
    const shared = [noteEntry("n1", "same")];
    expect(
      footnotePartDiffs(
        note("a", "here", { notes: shared }),
        note("a", "there", { notes: shared }),
      ),
    ).toEqual([]);
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

  it("combines a same-id-different-body row ✓'d on both sides into one mark", () => {
    /*
     * Two devices wrote on one mark. Keeping both used to ribbon the same
     * quote twice on the same words; what the reader asked for is everything
     * they wrote, not a duplicate of where they wrote it.
     */
    const merged = mergeFootnotes(
      [note("a", "here")],
      [note("a", "there")],
      { local: true, server: true },
    );
    expect(merged).toHaveLength(1);
    // The shell is the one on the device you are standing at.
    expect(merged[0]!.excerpt).toBe("here");
  });

  it("still keeps both when the two marks are different marks", () => {
    // Two ids that happen to sit on the same page are two marks, and stay two.
    const merged = mergeFootnotes(
      [note("a", "mine")],
      [note("b", "theirs")],
      { local: true, server: true },
    );
    expect(merged.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("keeps identical same-id marks even when every difference is dropped", () => {
    const merged = mergeFootnotes(
      [note("a"), note("b")],
      [note("a")],
      { local: false, server: false },
    );
    expect(merged.map((row) => row.id)).toEqual(["a"]);
  });
});

describe("combineFootnotePair", () => {
  const noteEntry = (id: string, text: string) => ({
    id,
    text,
    createdAt: 1,
    updatedAt: 2,
  });
  const board = (id: string) => ({ id, createdAt: 1, updatedAt: 2 });
  const thread = (rootId: string) => ({ rootId, title: rootId, createdAt: 1 });

  it("keeps the local shell, down to the title", () => {
    // Renaming your mark to the other device's wording would be a surprise
    // nobody asked for.
    const combined = combineFootnotePair(
      note("a", "here", { title: "Mine", color: "#111", blockText: "local block" }),
      note("a", "there", { title: "Theirs", color: "#222", blockText: "hub block" }),
    );
    expect(combined.id).toBe("a");
    expect(combined.excerpt).toBe("here");
    expect(combined.title).toBe("Mine");
    expect(combined.color).toBe("#111");
    expect(combined.blockText).toBe("local block");
  });

  it("brings across what the other device added", () => {
    const combined = combineFootnotePair(
      note("a", "here", {
        notes: [noteEntry("n1", "mine")],
        whiteboards: [board("wb1")],
        threads: [thread("t1")],
        userLinks: [{ url: "https://one.example" }],
      }),
      note("a", "there", {
        notes: [noteEntry("n2", "theirs")],
        whiteboards: [board("wb2")],
        threads: [thread("t2")],
        userLinks: [{ url: "https://two.example" }],
      }),
    );
    expect(combined.notes?.map((row) => row.id)).toEqual(["n1", "n2"]);
    // Every board id has to survive, or its blob is orphaned on the mark.
    expect(combined.whiteboards?.map((row) => row.id)).toEqual(["wb1", "wb2"]);
    expect(combined.threads?.map((row) => row.rootId)).toEqual(["t1", "t2"]);
    expect(combined.userLinks?.map((row) => row.url)).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
  });

  it("does not list the same attachment twice", () => {
    const combined = combineFootnotePair(
      note("a", "here", {
        notes: [noteEntry("n1", "mine")],
        whiteboards: [board("wb1")],
        threads: [thread("t1")],
        userLinks: [{ url: "https://one.example" }],
      }),
      note("a", "there", {
        notes: [noteEntry("n1", "same note, other device")],
        whiteboards: [board("wb1")],
        threads: [thread("t1")],
        userLinks: [{ url: "https://one.example", title: "One" }],
      }),
    );
    expect(combined.notes).toHaveLength(1);
    expect(combined.notes?.[0]!.text).toBe("mine");
    expect(combined.whiteboards).toHaveLength(2);
    expect(combined.whiteboards?.map((row) => row.id)).toContain("wb1");
    expect(combined.whiteboards?.map((row) => row.id).filter((id) => id !== "wb1")).toHaveLength(1);
    expect(combined.threads).toHaveLength(1);
    expect(combined.userLinks).toHaveLength(1);
  });

  it("remints a shared whiteboard pointer so both blobs can stay", () => {
    const remints: Record<string, string> = {};
    const combined = combineFootnotePair(
      note("a", "here", { whiteboards: [board("wb1")] }),
      note("a", "there", { whiteboards: [board("wb1")] }),
      remints,
    );
    expect(combined.whiteboards).toHaveLength(2);
    expect(combined.whiteboards?.[0]!.id).toBe("wb1");
    const fresh = combined.whiteboards?.[1]!.id;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe("wb1");
    expect(remints.wb1).toBe(fresh);
  });

  it("takes the later edit time, and invents one for neither", () => {
    expect(
      combineFootnotePair(
        note("a", "here", { updatedAt: 10 }),
        note("a", "there", { updatedAt: 40 }),
      ).updatedAt,
    ).toBe(40);
    expect(
      combineFootnotePair(note("a", "here"), note("a", "there", { updatedAt: 40 })).updatedAt,
    ).toBe(40);
    // A mark that never recorded an edit does not gain one by being merged.
    expect(combineFootnotePair(note("a"), note("a")).updatedAt).toBeUndefined();
  });

  it("takes a crop from the other side when this one has none", () => {
    // A region mark with no picture cannot say what it points at.
    expect(combineFootnotePair(note("a"), note("a", "there", { png: "hub" })).png).toBe("hub");
    expect(
      combineFootnotePair(note("a", "here", { png: "mine" }), note("a", "there", { png: "hub" }))
        .png,
    ).toBe("mine");
  });

  it("leaves underlines alone", () => {
    /*
     * `subMarks` index into `blockText` by offset. Two devices that both
     * edited the quote have two sets of offsets into two different strings, so
     * concatenating them would underline words nobody underlined.
     */
    const sub = (id: string, start: number) => ({
      id,
      kind: "underline" as const,
      excerpt: "x",
      start,
      end: start + 1,
    });
    const combined = combineFootnotePair(
      note("a", "here", { subMarks: [sub("s1", 0)] }),
      note("a", "there", { subMarks: [sub("s2", 40)] }),
    );
    expect(combined.subMarks?.map((row) => row.id)).toEqual(["s1"]);
  });

  it("reads back like a single-sided keep when there is nothing to add", () => {
    // No empty arrays where a plain ✓ would have left the field absent.
    const combined = combineFootnotePair(note("a"), note("a"));
    expect(combined).toEqual(note("a"));
    expect(Object.hasOwn(combined, "notes")).toBe(false);
    expect(Object.hasOwn(combined, "whiteboards")).toBe(false);
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

  it("lets a part pick keep the other device's notes on a local shell", () => {
    const noteEntry = (id: string, text: string) => ({
      id,
      text,
      createdAt: 1,
      updatedAt: 2,
    });
    const merged = mergeFootnotes(
      [note("a", "here", { notes: [noteEntry("n1", "mine")] })],
      [note("a", "there", { notes: [noteEntry("n2", "theirs")] })],
      { local: false, server: false },
      {
        a: { local: true, server: false },
        [footnotePartRowId("a", "notes", "n2")]: { local: false, server: true },
      },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.excerpt).toBe("here");
    expect(merged[0]!.notes?.map((row) => row.id).sort()).toEqual(["n1", "n2"]);
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

describe("padInkDiffRows", () => {
  it("omits pages whose clocks already match", () => {
    const rows = padInkDiffRows({
      kind: "annotate",
      id: "pad-1",
      stage: "pad",
      detail: "both changed",
      local: null,
      server: null,
      localInkStamps: [
        { pageId: 1, updatedAt: 10 },
        { pageId: 2, updatedAt: 20 },
      ],
      hubInkStamps: [
        { pageId: 1, updatedAt: 10 },
        { pageId: 2, updatedAt: 21 },
      ],
    });
    expect(rows.map((row) => row.pageId)).toEqual([2]);
  });

  it("keeps a page whose clocks tied but whose preview bytes did not", () => {
    const rows = padInkDiffRows({
      kind: "whiteboard",
      id: "w1",
      stage: "ink",
      detail: "page 0",
      local: null,
      server: null,
      inkPageId: 0,
      localInk: [{ kind: "whiteboard", key: "w1", page_id: 0, updated_at: 1, gz: "aaa" }],
      serverInk: [{ kind: "whiteboard", key: "w1", page_id: 0, updated_at: 1, gz: "bbb" }],
    });
    expect(rows).toEqual([{ pageId: 0, hasLocal: true, hasServer: true }]);
  });
});

describe("footnoteInkDiffRows", () => {
  it("keeps one row per mark board and page, not one handwriting lump", () => {
    const rows = footnoteInkDiffRows({
      kind: "annotate",
      id: "p1",
      stage: "pad",
      detail: "both changed",
      local: null,
      server: null,
      footnoteInk: [
        {
          wbId: "mark-a",
          localPageIds: [1],
          hubPageIds: [1],
          localPages: [{ pageId: 1, updatedAt: 1 }],
          hubPages: [{ pageId: 1, updatedAt: 2 }],
        },
        {
          wbId: "mark-b",
          localPageIds: [1, 2],
          hubPageIds: [1],
          localPages: [
            { pageId: 1, updatedAt: 3 },
            { pageId: 2, updatedAt: 4 },
          ],
          hubPages: [{ pageId: 1, updatedAt: 3 }],
        },
      ],
    });
    expect(rows).toEqual([
      { wbId: "mark-a", pageId: 1, hasLocal: true, hasServer: true },
      { wbId: "mark-b", pageId: 2, hasLocal: true, hasServer: false },
    ]);
  });
});
