/**
 * Stage F over a pad that has footnote scratch boards.
 *
 * The document's own pages and each board's pages are separate hub keys, and
 * the walk has to carry all of them: a board that only exists here has no
 * digest row, so nothing would ever push it, and a board only the hub has must
 * come down without the reader opening it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LcClient } from "../api/client";
import type { WalkPad, WalkSnapshot } from "./hubWalk";

/** Local ink, keyed the way the ink page store keys it. */
let localPages: Record<string, Array<{ pageId: number; updatedAt: number }>> = {};
/** Which scratch boards this device's copy of the pad points at. */
let pointers: Set<string> | null = null;

vi.mock("./idb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./idb")>()),
  withStore: async (
    _store: string,
    _mode: string,
    fn: (store: { put: (row: unknown, key: string) => void }) => void,
  ) => {
    fn({ put: () => {} });
  },
}));

vi.mock("./inkPageStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("./inkPageStore")>();
  return {
    ...real,
    listInkDocKeys: async (prefix: string) =>
      Object.keys(localPages).filter((key) => key.startsWith(prefix)),
    getInkPageRecords: async (docKey: string) =>
      (localPages[docKey] ?? []).map((row) => ({
        v: 1 as const,
        docKey,
        pageId: row.pageId,
        gz: new Uint8Array([1, 2, 3]),
        dirty: false,
        updatedAt: row.updatedAt,
      })),
  };
});

vi.mock("./annotateStore", () => ({
  localFootnoteBoardIds: async () => pointers,
}));

vi.mock("./padHub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./padHub")>()),
  loadPadHub: () => ({ baseUrl: "http://hub", token: "t" }),
}));

const { walkSyncInk } = await import("./hubWalk");

function pad(): WalkPad {
  return {
    kind: "annotate",
    id: "pad-1",
    hubAckUpdatedAt: () => 500,
    buildBody: () => ({ id: "pad-1", updated_at: 600 }) as never,
    markHubAck: () => {},
  };
}

function snapshot(ink: WalkSnapshot["inkDigests"]): WalkSnapshot {
  return {
    annotateRows: [],
    whiteboardRows: [],
    inkDigests: ink,
    edges: [],
    goneEdges: [],
  };
}

const digest = (key: string, pageId: number, updatedAt: number) => ({
  kind: "annotate" as const,
  key,
  page_id: pageId,
  updated_at: updatedAt,
});

type FakeClient = LcClient & Record<string, ReturnType<typeof vi.fn>>;

function fakeClient(overrides: Record<string, unknown> = {}): FakeClient {
  return {
    getInkPages: vi.fn().mockResolvedValue([]),
    putInkPage: vi.fn().mockResolvedValue({ applied: true, seq: 1 }),
    ...overrides,
  } as unknown as FakeClient;
}

/** The fake's call log, past the real signature. */
function calls(fn: unknown): Array<Array<Record<string, unknown>>> {
  return (fn as { mock: { calls: Array<Array<Record<string, unknown>>> } }).mock.calls;
}

beforeEach(() => {
  localPages = {};
  pointers = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("walkSyncInk with scratch boards", () => {
  it("pushes a board that only exists on this device", async () => {
    localPages["fnwb:pad-1:wb7"] = [{ pageId: 1, updatedAt: 900 }];
    pointers = new Set(["wb7"]);
    const client = fakeClient();
    const result = await walkSyncInk(client, pad(), snapshot([]), 100);
    expect(result.outcome).toBe("ok");
    expect(client.putInkPage).toHaveBeenCalledTimes(1);
    expect(calls(client.putInkPage)[0][0]).toMatchObject({
      kind: "annotate",
      key: "pad-1/fn/wb7",
      page_id: 1,
    });
  });

  it("pulls a board only the hub has, without the reader opening it", async () => {
    pointers = new Set(["wb9"]);
    const client = fakeClient({
      getInkPages: vi.fn(async (_kind: string, key: string) =>
        key === "pad-1/fn/wb9"
          ? [{ kind: "annotate", key, page_id: 1, updated_at: 900, gz: "YQ==" }]
          : [],
      ),
    });
    const result = await walkSyncInk(
      client,
      pad(),
      snapshot([digest("pad-1/fn/wb9", 1, 900)]),
      100,
    );
    expect(result.outcome).toBe("ok");
    expect(client.getInkPages).toHaveBeenCalledWith("annotate", "pad-1/fn/wb9");
  });

  it("keeps a board's pages apart from the document's own", async () => {
    // Page 1 of the PDF and page 1 of a scratch board are different paper.
    localPages["md:pad-1"] = [{ pageId: 1, updatedAt: 900 }];
    localPages["fnwb:pad-1:wb7"] = [{ pageId: 1, updatedAt: 900 }];
    pointers = new Set(["wb7"]);
    const client = fakeClient();
    await walkSyncInk(client, pad(), snapshot([]), 100);
    const keys = calls(client.putInkPage).map((call) => call[0].key).sort();
    expect(keys).toEqual(["pad-1", "pad-1/fn/wb7"]);
  });

  it("names the board when a scratch page changed on both sides", async () => {
    localPages["fnwb:pad-1:wb7"] = [{ pageId: 2, updatedAt: 900 }];
    pointers = new Set(["wb7"]);
    const result = await walkSyncInk(
      fakeClient(),
      pad(),
      snapshot([digest("pad-1/fn/wb7", 2, 800)]),
      100,
    );
    expect(result).toMatchObject({
      outcome: "conflict",
      pageId: 2,
      inkKey: "pad-1/fn/wb7",
      wbId: "wb7",
    });
  });

  it("still reports a conflict on the document's own pages the old way", async () => {
    localPages["md:pad-1"] = [{ pageId: 40, updatedAt: 900 }];
    const result = await walkSyncInk(
      fakeClient(),
      pad(),
      snapshot([digest("pad-1", 40, 800)]),
      100,
    );
    expect(result).toMatchObject({ outcome: "conflict", pageId: 40, inkKey: "pad-1" });
    expect((result as { wbId?: string }).wbId).toBeUndefined();
  });

  it("fails the walk when a board's page will not upload", async () => {
    // No rollback and no "Synced": the pad JSON is already on the hub, and the
    // pill has to park on Ink rather than claim the strokes travelled.
    localPages["fnwb:pad-1:wb7"] = [{ pageId: 1, updatedAt: 900 }];
    pointers = new Set(["wb7"]);
    const client = fakeClient({
      putInkPage: vi.fn().mockRejectedValue(new Error("hub timeout")),
    });
    await expect(walkSyncInk(client, pad(), snapshot([]), 100)).rejects.toThrow(
      "hub timeout",
    );
  });

  it("leaves a board no mark points at where it is", async () => {
    localPages["fnwb:pad-1:wb7"] = [{ pageId: 1, updatedAt: 900 }];
    pointers = new Set();
    const client = fakeClient();
    await walkSyncInk(client, pad(), snapshot([digest("pad-1/fn/wb7", 1, 800)]), 100);
    expect(client.putInkPage).not.toHaveBeenCalled();
    expect(client.getInkPages).not.toHaveBeenCalled();
  });

  it("does not go looking for boards on a whiteboard pad", async () => {
    const client = fakeClient();
    const notebook: WalkPad = { ...pad(), kind: "whiteboard", id: "w1" };
    localPages["wb:w1"] = [{ pageId: 1, updatedAt: 900 }];
    await walkSyncInk(client, notebook, snapshot([]), 100);
    expect(calls(client.putInkPage).map((call) => call[0].key)).toEqual(["w1"]);
  });
});
