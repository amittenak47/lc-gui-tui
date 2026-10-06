import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryBookTransaction } from "./testBookTransaction";

const state = vi.hoisted(() => ({ stores: new Map<string, Map<IDBValidKey, unknown>>(),
  beforeWrite: undefined as (() => void) | undefined, abort: false }));
vi.mock("./idb", async original => ({
  ...await original<typeof import("./idb")>(),
  run: async (name: string, _mode: string, work: (store: unknown) => { result: unknown }) => {
    const rows = state.stores.get(name) ?? new Map();
    return work({ get: (id: string) => ({ result: structuredClone(rows.get(id)) }), getAll: () => ({ result: [...rows.values()] }) }).result;
  },
  withTransaction: async (_names: string[], _mode: string, work: Parameters<typeof memoryBookTransaction>[1]) => {
    const hook = state.beforeWrite; state.beforeWrite = undefined; hook?.();
    return memoryBookTransaction(state.stores, work, tx => { if (state.abort) tx.abort(); });
  },
}));
vi.mock("./artifactAssetSync", () => ({ downloadArtifactAssets: async () => {} }));

import { getAnnotateDoc, getAnnotateDocMeta, saveAnnotateDoc, setAnnotateDocLabel, setAnnotateDocLocked, trashAnnotateDoc } from "./annotateStore";
import { getWhiteboardNotebook, renameWhiteboardNotebook, saveWhiteboardNotebook } from "./whiteboardStore";
import { putProblemBoard, markProblemHubAck, type ProblemBoardRecord } from "./problemBoardStore";
import { putFootnoteWhiteboard } from "./footnoteWhiteboardStore";
import { deleteContentByPrefix, editParentContentArtifacts, getContent } from "./contentStore";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import type { SyncState } from "./syncState";

const board = { v: 1 as const, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
const rows = (name: string) => state.stores.get(name)!;
const sync = (id: string) => rows("sync_state").get(id) as SyncState;

beforeEach(() => {
  state.stores = new Map(["content", "problem_boards", "book_meta", "sync_state"].map(name => [name, new Map()]));
  state.abort = false; state.beforeWrite = undefined;
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("IDBKeyRange", { bound: (lower: string, upper: string) => ({ lower, upper }) });
  resetLocalBookStoreForTests(); resetBookCoordinatorForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe("authoritative metadata and authored sequences", () => {
  it("preserves a renamed label even when the autosave cache already refreshed", async () => {
    const old = await saveAnnotateDoc({ id: "a1", name: "Book.md", label: "Original", hash: "source", source: "text", board });
    await setAnnotateDocLabel("a1", "Renamed in another window");
    const before = sync("annotate:a1").changeSeq;
    await saveAnnotateDoc({ ...old, board: { ...board, elements: [{ id: "new" }] } });
    expect((await getAnnotateDoc("a1"))?.label).toBe("Renamed in another window");
    expect(sync("annotate:a1").changeSeq).toBeGreaterThan(before);
  });

  it("preserves a title changed after an autosave captured its metadata", async () => {
    const old = await saveWhiteboardNotebook({ id: "w1", title: "Original", pageCount: 1, board });
    state.beforeWrite = () => {
      const current = rows("book_meta").get("whiteboard:w1") as object;
      rows("book_meta").set("whiteboard:w1", { ...current, title: "Other window", locked: true });
    };
    await saveWhiteboardNotebook({ ...old, board: { ...board, elements: [{ id: "stroke" }] } });
    expect(await getWhiteboardNotebook("w1")).toMatchObject({ title: "Other window", locked: true });
    const touched = (await getWhiteboardNotebook("w1"))!.updatedAt;
    await renameWhiteboardNotebook("w1", "Explicit rename");
    expect(await getWhiteboardNotebook("w1")).toMatchObject({ title: "Explicit rename", updatedAt: touched });
  });

  it("preserves lock, unknown metadata/content and omitted transcript fields", async () => {
    await saveAnnotateDoc({ id: "a1", name: "Book.md", hash: "source", source: "text", board, agent: [{ id: "turn" }] });
    const content = rows("content").get("a1") as object;
    rows("content").set("a1", { ...content, future: { source: "authored", rev: 9 } });
    const metadata = rows("book_meta").get("annotate:a1") as object;
    rows("book_meta").set("annotate:a1", { ...metadata, unknown: "preserved" });
    await setAnnotateDocLocked("a1", true);
    await saveAnnotateDoc({ id: "a1", name: "Book.md", hash: "source", source: "new", board });
    expect(getAnnotateDocMeta("a1")).toMatchObject({ locked: true, unknown: "preserved" });
    expect(rows("content").get("a1")).toMatchObject({ agent: [{ id: "turn" }], future: { source: "authored", rev: 9 } });
    expect(await trashAnnotateDoc("a1")).toBeNull();
  });

  it("marks footnote content under its parent in the same transaction", async () => {
    await saveAnnotateDoc({ id: "a1", name: "Book.md", hash: "source", source: "text", board });
    const before = sync("annotate:a1").changeSeq;
    await putFootnoteWhiteboard("a1", "scratch", { board, pageCount: 1 });
    expect(rows("content").get("fnwb:a1:scratch")).toEqual({ board, pageCount: 1 });
    expect(sync("annotate:a1").changeSeq).toBeGreaterThan(before);
    expect(rows("content").get("a1")).toMatchObject({ source: "text" });
  });

  it("publishes a child-prefix removal with its parent's authored version", async () => {
    await saveAnnotateDoc({ id: "a1", name: "Book.md", hash: "source", source: "text", board });
    await putFootnoteWhiteboard("a1", "one", { board, pageCount: 1 });
    await putFootnoteWhiteboard("a1", "two", { board, pageCount: 1 });
    await putFootnoteWhiteboard("other", "one", { board, pageCount: 1 });
    const before = sync("annotate:a1").changeSeq;
    await deleteContentByPrefix("fnwb:a1:");
    expect(rows("content").has("fnwb:a1:one")).toBe(false);
    expect(rows("content").has("fnwb:a1:two")).toBe(false);
    expect(rows("content").get("fnwb:other:one")).toEqual({ board, pageCount: 1 });
    expect(sync("annotate:a1").changeSeq).toBeGreaterThan(before);
    expect(rows("content").get("a1")).toMatchObject({ source: "text" });
  });

  it("keeps readable durable content below a metadata-only fallback envelope", async () => {
    await saveAnnotateDoc({ id: "a1", name: "Book.md", hash: "source", source: "text", board });
    const metadata = rows("book_meta").get("annotate:a1");
    localStorage.setItem("whiteboard.content.v1.a1", JSON.stringify({ v: 2, owner: { kind: "annotate", id: "a1" },
      key: "a1", token: "metadata-edit", writerId: "other", payload: null, payloadPresent: false,
      metadata, state: sync("annotate:a1"), baseChangeSeq: sync("annotate:a1").changeSeq }));
    expect(await getContent("a1")).toMatchObject({ source: "text", board });
  });

  it("problem acknowledgements preserve current content and do not author a change", async () => {
    const row: ProblemBoardRecord = { id: "leetcode/1", dataset: "leetcode", taskId: "1", updatedAt: 1, board };
    await putProblemBoard(row);
    await putProblemBoard({ ...row, board: { ...board, elements: [{ id: "new" }] } });
    const before = sync("problem:leetcode/1").changeSeq;
    await markProblemHubAck(row.id, 20);
    expect(rows("problem_boards").get(row.id)).toMatchObject({ hubAckUpdatedAt: 20, board: { elements: [{ id: "new" }] } });
    expect(sync("problem:leetcode/1").changeSeq).toBe(before);
  });

  it("a refused guarded transaction publishes none of content, metadata or tracking", async () => {
    await saveAnnotateDoc({ id: "a1", name: "Book.md", hash: "source", source: "text", board });
    const before = structuredClone(state.stores);
    state.abort = true;
    await expect(editParentContentArtifacts({ kind: "annotate", id: "a1" }, null, {
      type: "create", id: "file", title: "Note", associations: [{ kind: "file" }],
      content: { kind: "markdown", documentId: "owned", sourceRevision: "r1" },
    }, () => {})).rejects.toThrow();
    expect(state.stores).toEqual(before);
  });
});
