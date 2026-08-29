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
