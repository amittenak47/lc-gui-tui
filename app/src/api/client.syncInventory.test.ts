import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("./nativeHttp", async original => ({
  ...await original<typeof import("./nativeHttp")>(),
  loadInvoke: async () => invoke,
}));
vi.mock("../util/padHub", async original => ({
  ...await original<typeof import("../util/padHub")>(),
  loadPadHub: () => null,
}));

import { LcClient } from "./client";

beforeEach(() => invoke.mockReset());

it("preserves hub capabilities, book heads and item revisions in an inventory", async () => {
  const heads = [{ kind: "annotate", id: "book", rev: 42 }];
  const ink = [{ kind: "annotate", key: "book", page_id: 113, updated_at: 10,
    rev: 41, hash: "validated-page-hash" }];
  invoke.mockResolvedValue({ status: 200, body: {
    now: 10, whiteboard: [], annotate: [], snapshots: [],
    features: [], book_heads: heads, ink,
  } });
  const inventory = await new LcClient().pingPadSync(0);
  expect(inventory.features).toEqual([]);
  expect(inventory.book_heads).toEqual(heads);
  expect(inventory.ink).toEqual(ink);
  expect(invoke).toHaveBeenCalledWith("lc_pads_sync", { since: 0 });
});

it("does not infer atomic capabilities or revisions for an old hub", async () => {
  invoke.mockResolvedValue({ status: 200, body: {
    now: 10, whiteboard: [], annotate: [], snapshots: [],
  } });
  const inventory = await new LcClient().pingPadSync(0);
  expect(inventory.features).toBeUndefined();
  expect(inventory.book_heads).toBeUndefined();
});
