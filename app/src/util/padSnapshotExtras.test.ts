import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteInkPages = vi.fn(async (_docKey?: string) => {});
const getInkPageRecords = vi.fn(async (_docKey?: string): Promise<unknown[]> => []);
const putRows = vi.fn((_row: unknown, _key?: string) => {});
const edgesFor = vi.fn(async (_node?: unknown): Promise<unknown[]> => []);
const edgeIsGone = vi.fn(async (_id?: string) => false);
const putEdge = vi.fn(async (_edge?: unknown) => {});
const getAnnotateDoc = vi.fn(async (_id?: string): Promise<unknown> => null);
const saveAnnotateDoc = vi.fn(async (_entry?: unknown) => {});

vi.mock("./inkPageStore", () => ({
  annotateDocKey: (id: string) => `md:${id}`,
  whiteboardDocKey: (id: string) => `wb:${id}`,
  inkPageKey: (docKey: string, pageId: number) => `${docKey}#${pageId}`,
  deleteInkPages: (docKey: string) => deleteInkPages(docKey),
  getInkPageRecords: (docKey: string) => getInkPageRecords(docKey),
}));

vi.mock("./idb", () => ({
  STORE_INK_PAGES: "ink",
  withStore: async (
    _name: string,
    _mode: string,
    body: (store: { put: (row: unknown, key?: string) => void }) => void,
  ) => {
    body({ put: (row, key) => putRows(row, key) });
  },
}));

vi.mock("./noteLinks", () => ({
  edgesFor: (node: unknown) => edgesFor(node),
  edgeIsGone: (id: string) => edgeIsGone(id),
  putEdge: (edge: unknown) => putEdge(edge),
}));

vi.mock("./annotateStore", () => ({
  getAnnotateDoc: (id: string) => getAnnotateDoc(id),
  saveAnnotateDoc: (entry: unknown) => saveAnnotateDoc(entry),
}));

vi.mock("./gzip", () => ({ gzipBytes: async (bytes: Uint8Array) => bytes }));
vi.mock("../canvas/inkCodec", () => ({ packEncodedInk: (ink: unknown) => ink }));

const { applyPadSnapshotExtras } = await import("./padSnapshotExtras");

const board = {
  v: 1 as const,
  elements: [] as unknown[],
  appState: { scrollX: 0, scrollY: 0, zoom: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyPadSnapshotExtras", () => {
  it("replaces the document's ink rather than merging into it", async () => {
    // Restoring to before a page existed has to take that page's strokes with
    // it. A `put` of only the pages the snapshot names leaves the rest standing.
    await applyPadSnapshotExtras("whiteboard", "w1", {
      name: "w1",
      board,
      ink: [{ pageId: 1, updatedAt: 5, gz: "YQ==" }],
    });
    expect(deleteInkPages).toHaveBeenCalledWith("wb:w1");
    expect(putRows).toHaveBeenCalledTimes(1);
    expect(putRows.mock.calls[0]?.[1]).toBe("wb:w1#1");
  });

  it("clears the ink for a snapshot taken before anything was drawn", async () => {
    await applyPadSnapshotExtras("whiteboard", "w1", { name: "w1", board });
    expect(deleteInkPages).toHaveBeenCalledWith("wb:w1");
    expect(putRows).not.toHaveBeenCalled();
  });

  it("leaves an older snapshot's strokes to the board blob", async () => {
    /*
     * A snapshot written before the board stopped carrying `inkC` has no `ink`
     * field. Writing nothing *and* leaving the store alone meant `restoreInk`
     * found today's pages and ingested those — the restore silently returned
     * the handwriting it was supposed to replace. Clearing is what hands the
     * job to the blob.
     */
    await applyPadSnapshotExtras("annotate", "a1", {
      name: "a1",
      board: { ...board, inkC: { ops: [1], raw: [] } } as never,
    });
    expect(deleteInkPages).toHaveBeenCalledWith("md:a1");
    expect(putRows).not.toHaveBeenCalled();
  });

  it("skips an edge that has since been deleted", async () => {
    edgeIsGone.mockImplementation(async (id?: string) => id === "gone-one");
    await applyPadSnapshotExtras("whiteboard", "w1", {
      name: "w1",
      board,
      edges: [
        {
          id: "gone-one",
          from: { type: "whiteboard", id: "w1" },
          to: { type: "annotate", id: "a1" },
          kind: "picker",
          createdAt: 1,
        },
        {
          id: "kept-one",
          from: { type: "whiteboard", id: "w1" },
          to: { type: "annotate", id: "a2" },
          kind: "picker",
          createdAt: 1,
        },
      ] as never,
    });
    expect(putEdge).toHaveBeenCalledTimes(1);
    expect((putEdge.mock.calls[0]?.[0] as { id: string }).id).toBe("kept-one");
  });
});
