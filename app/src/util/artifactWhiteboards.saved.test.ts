import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardBlob } from "../canvas/BoardHandle";
import type { InkPageRecord } from "./inkPageStore";
import { stageSavedFootnoteWhiteboard } from "./artifactWhiteboards";
import type { ArtifactAsset } from "./artifactAssets";

const state = vi.hoisted(() => ({
  scene: undefined as { board: BoardBlob; pageCount: number } | undefined,
  pages: [] as InkPageRecord[], spill: false, writes: [] as ArtifactAsset[],
  transactions: [] as unknown[],
}));
vi.mock("./contentStore", async (original) => ({
  ...await original<typeof import("./contentStore")>(), contentSpillOnly: () => state.spill,
}));
vi.mock("./artifactAssetStore", () => ({
  putArtifactAsset: async (asset: ArtifactAsset) => { state.writes.push(asset); },
  getArtifactAsset: async () => null,
}));
vi.mock("./inkPageStore", async (original) => ({
  ...await original<typeof import("./inkPageStore")>(), inkPageKeyRange: (key: string) => key,
}));
vi.mock("./idb", async (original) => ({
  ...await original<typeof import("./idb")>(),
  openDb: async () => ({
    transaction: (stores: string[], mode: string) => {
      state.transactions.push({ stores, mode });
      const tx = {
        oncomplete: undefined as (() => void) | undefined,
        onabort: undefined, onerror: undefined,
        objectStore: () => ({
          get: () => ({ result: state.scene }),
          getAll: () => ({ result: state.pages }),
        }),
      };
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    },
  }),
}));
beforeEach(() => {
  state.scene = {
    board: { v: 1, elements: [], appState: { scrollX: 0, scrollY: 0, zoom: 1 },
      inkC: { v: 2, ops: [] }, inkPages: { v: 1, pageIds: [0] } },
    pageCount: 1,
  };
  state.pages = [{ v: 1, docKey: "fnwb:set1:board1", pageId: 0, inkC: { v: 2, ops: [] }, dirty: true, updatedAt: 1 }];
  state.spill = false;
  state.writes = [];
  state.transactions = [];
});

describe("saved scratch attachment adapter", () => {
  it("reads scene and shards together and removes only the empty inline placeholder", async () => {
    const content = await stageSavedFootnoteWhiteboard("set1", "board1");
    expect(state.transactions).toEqual([{ stores: ["content", "ink_pages"], mode: "readonly" }]);
    expect(content.ink.map((page) => page.pageId)).toEqual([0]);
    expect(JSON.parse(state.writes[0].payload).board.inkC).toBeUndefined();
    expect(state.scene?.board.inkC).toEqual({ v: 2, ops: [] });
  });

  it("ignores only empty deleted-page rows outside the saved manifest", async () => {
    state.pages.push({ ...state.pages[0], pageId: 2 });
    const content = await stageSavedFootnoteWhiteboard("set1", "board1");
    expect(content.ink.map((page) => page.pageId)).toEqual([0]);
  });

  it("does not guess at nonempty inline ink or missing shards", async () => {
    state.scene!.board.inkC = { v: 2, ops: [{ k: "d", x0: 1, y0: 1, n: 1, xy: new Int16Array() }] };
    await expect(stageSavedFootnoteWhiteboard("set1", "board1")).rejects.toThrow("older whiteboard");
    state.scene!.board.inkC = { v: 2, ops: [] };
    state.pages = [];
    await expect(stageSavedFootnoteWhiteboard("set1", "board1")).rejects.toThrow("ink differ");
    expect(state.writes).toHaveLength(0);
  });

  it("does not attach missing scenes or stale IndexedDB content while storage is spilled", async () => {
    state.spill = true;
    await expect(stageSavedFootnoteWhiteboard("set1", "board1")).rejects.toThrow("Repair local storage");
    expect(state.transactions).toHaveLength(0);
    state.spill = false;
    state.scene = undefined;
    await expect(stageSavedFootnoteWhiteboard("set1", "board1")).rejects.toThrow("whiteboard is missing");
    expect(state.writes).toHaveLength(0);
  });
});
