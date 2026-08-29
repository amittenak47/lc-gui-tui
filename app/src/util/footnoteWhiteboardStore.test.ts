import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./idb", () => ({
  run: async () => {
    throw new Error("no IndexedDB");
  },
  withStore: async () => {
    throw new Error("no IndexedDB");
  },
  STORE_CONTENT: "content",
  STORE_INK_PAGES: "ink_pages",
  STORE_SNAPSHOTS: "snapshots",
}));

import type { BoardBlob } from "../canvas/BoardHandle";
import { getContent } from "./contentStore";
import type { DocFootnote } from "./docFootnotes";
import {
  applyFootnoteBoards,
  collectFootnoteBoards,
  slimFootnoteBoard,
  deleteFootnoteWhiteboard,
  footnoteWhiteboardKey,
  forkSharedWhiteboardPointers,
  getFootnoteWhiteboard,
  putFootnoteWhiteboard,
  sweepFootnoteWhiteboards,
} from "./footnoteWhiteboardStore";

let store: Map<string, string>;

function board(mark = "a"): BoardBlob {
  return {
    v: 1,
    elements: [{ id: mark }],
    appState: { scrollX: 0, scrollY: 0, zoom: 1 },
  };
}

function mark(id: string, wbIds: string[]): DocFootnote {
  return {
    id,
    kind: "note",
    anchor: { kind: "text", start: 1, end: 2 },
    excerpt: id,
    createdAt: 1,
    whiteboards: wbIds.map((wbId) => ({ id: wbId, createdAt: 1, updatedAt: 1 })),
  };
}

beforeEach(() => {
  store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("footnoteWhiteboardStore", () => {
  it("round-trips a board blob", async () => {
    await putFootnoteWhiteboard("doc-1", "wb-1", { board: board("a"), pageCount: 1 });
    expect(await getFootnoteWhiteboard("doc-1", "wb-1")).toEqual({
      board: board("a"),
      pageCount: 1,
    });
    expect(await getContent(footnoteWhiteboardKey("doc-1", "wb-1"))).toBeTruthy();
  });

  it("deletes one board without touching another", async () => {
    await putFootnoteWhiteboard("doc-1", "wb-1", { board: board("a"), pageCount: 1 });
    await putFootnoteWhiteboard("doc-1", "wb-2", { board: board("b"), pageCount: 1 });
    expect([...store.keys()]).toEqual(
      expect.arrayContaining([
        "whiteboard.content.v1.fnwb:doc-1:wb-1",
        "whiteboard.content.v1.fnwb:doc-1:wb-2",
      ]),
    );
    await deleteFootnoteWhiteboard("doc-1", "wb-1");
    expect(await getFootnoteWhiteboard("doc-1", "wb-1")).toBeNull();
    expect(await getFootnoteWhiteboard("doc-1", "wb-2")).toEqual({
      board: board("b"),
      pageCount: 1,
    });
  });

  it("sweeps every board for a document", async () => {
    await putFootnoteWhiteboard("doc-1", "wb-1", { board: board("a"), pageCount: 1 });
    await putFootnoteWhiteboard("doc-1", "wb-2", { board: board("b"), pageCount: 1 });
    await putFootnoteWhiteboard("doc-2", "wb-1", { board: board("c"), pageCount: 1 });
    await sweepFootnoteWhiteboards("doc-1");
    expect(await getFootnoteWhiteboard("doc-1", "wb-1")).toBeNull();
    expect(await getFootnoteWhiteboard("doc-1", "wb-2")).toBeNull();
    expect(await getFootnoteWhiteboard("doc-2", "wb-1")).toEqual({
      board: board("c"),
      pageCount: 1,
    });
  });

  it("collects only boards the marks still point at", async () => {
    await putFootnoteWhiteboard("doc-1", "wb-1", { board: board("a"), pageCount: 1 });
    await putFootnoteWhiteboard("doc-1", "wb-orphan", { board: board("x"), pageCount: 1 });
    const collected = await collectFootnoteBoards("doc-1", [mark("fn-1", ["wb-1"])]);
    expect(Object.keys(collected)).toEqual(["wb-1"]);
  });

  it("applies a hub map into the store", async () => {
    await applyFootnoteBoards("doc-1", {
      "wb-1": { board: board("hub"), pageCount: 1 },
    });
    expect(await getFootnoteWhiteboard("doc-1", "wb-1")).toEqual({
      board: board("hub"),
      pageCount: 1,
    });
  });

  it("forks a shared pointer so two marks do not share a key", async () => {
    await putFootnoteWhiteboard("doc-1", "wb-1", { board: board("shared"), pageCount: 1 });
    const forked = await forkSharedWhiteboardPointers("doc-1", [
      mark("fn-local", ["wb-1"]),
      mark("fn-server", ["wb-1"]),
    ]);
    const ids = forked.flatMap((entry) => (entry.whiteboards ?? []).map((row) => row.id));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("wb-1");
    expect(ids[1]).not.toBe("wb-1");
    expect(await getFootnoteWhiteboard("doc-1", ids[1]!)).toEqual({
      board: board("shared"),
      pageCount: 1,
    });
  });

  it("keeps both blobs when a merge remints a shared pointer", async () => {
    const { applyConflictFootnoteBoards } = await import("./footnoteWhiteboardStore");
    const local = { board: board("local"), pageCount: 1 };
    const server = { board: board("hub"), pageCount: 1 };
    await applyConflictFootnoteBoards(
      "doc-1",
      { "wb-1": local },
      { "wb-1": server },
      { "wb-1": "wb-hub" },
    );
    expect(await getFootnoteWhiteboard("doc-1", "wb-1")).toEqual(local);
    expect(await getFootnoteWhiteboard("doc-1", "wb-hub")).toEqual(server);
  });
});

describe("scratch board ink stays out of the pad JSON", () => {
  function fatBoard(): BoardBlob {
    return { ...board("a"), inkC: { v: 1, ops: [] } } as unknown as BoardBlob;
  }

  it("strips the strokes for the wire and leaves the structure", () => {
    const slim = slimFootnoteBoard({ board: fatBoard(), pageCount: 1 });
    expect((slim.board as { inkC?: unknown }).inkC).toBeUndefined();
    expect(slim.board.elements).toEqual([{ id: "a" }]);
    expect(slim.pageCount).toBe(1);
  });

  it("leaves a board that never had strokes in it alone", () => {
    const content = { board: board("a"), pageCount: 2 };
    expect(slimFootnoteBoard(content)).toBe(content);
  });

  it("collects slim boards for the wire and fat ones for local use", async () => {
    await putFootnoteWhiteboard("d1", "wb1", { board: fatBoard(), pageCount: 1 });
    const notes = [mark("m1", ["wb1"])];
    const wire = await collectFootnoteBoards("d1", notes, { slim: true });
    expect((wire.wb1!.board as { inkC?: unknown }).inkC).toBeUndefined();
    const local = await collectFootnoteBoards("d1", notes);
    expect((local.wb1!.board as { inkC?: unknown }).inkC).toBeDefined();
  });

  it("a slim board from the hub does not erase a pre-split local copy", async () => {
    // The only copy of those strokes is inside the local blob. The hub's body
    // carries none, and the ink pages have not landed yet.
    await putFootnoteWhiteboard("d1", "wb1", { board: fatBoard(), pageCount: 1 });
    await applyFootnoteBoards("d1", {
      wb1: { board: board("b"), pageCount: 1 },
    });
    const after = await getFootnoteWhiteboard("d1", "wb1");
    expect(after?.board.elements).toEqual([{ id: "b" }]);
    expect((after?.board as { inkC?: unknown }).inkC).toBeDefined();
  });

  it("a fat board from an old hub still brings its strokes", async () => {
    await applyFootnoteBoards("d1", { wb2: { board: fatBoard(), pageCount: 1 } });
    const after = await getFootnoteWhiteboard("d1", "wb2");
    expect((after?.board as { inkC?: unknown }).inkC).toBeDefined();
  });
});
