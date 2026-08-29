/**
 * Footnote scratch-board handwriting on the hub.
 *
 * The boards used to reach other devices only by being baked into the annotate
 * pad's JSON — uncompressed, inside a body the hub caps at 32 MB. They are ink
 * keys of their own now, `{padId}/fn/{wbId}`, and these are the rules that
 * makes true: where a key lives locally, which boards are worth syncing, and
 * what a resolve writes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./inkPageStore");
  vi.doUnmock("./idb");
  vi.resetModules();
});

/** `inkSync` over a fake ink store holding these doc keys. */
async function loadInkSync(docKeys: Record<string, number[]> = {}) {
  vi.resetModules();
  vi.doMock("./idb", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./idb")>()),
    withStore: async (
      _store: string,
      _mode: string,
      fn: (store: { put: (row: unknown, key: string) => void }) => void,
    ) => {
      fn({ put: () => {} });
    },
  }));
  vi.doMock("./inkPageStore", async (importOriginal) => {
    const real = await importOriginal<typeof import("./inkPageStore")>();
    return {
      ...real,
      listInkDocKeys: async (prefix: string) =>
        Object.keys(docKeys).filter((key) => key.startsWith(prefix)),
      getInkPageRecords: async (docKey: string) =>
        (docKeys[docKey] ?? []).map((pageId) => ({
          v: 1 as const,
          docKey,
          pageId,
          gz: new Uint8Array([1, 2, 3]),
          dirty: false,
          updatedAt: 10,
        })),
    };
  });
  return import("./inkSync");
}

const digest = (key: string, pageId: number, updatedAt = 20) => ({
  kind: "annotate" as const,
  key,
  page_id: pageId,
  updated_at: updatedAt,
});

describe("footnote ink hub keys", () => {
  it("names a board under the pad that owns the mark", async () => {
    const { footnoteInkHubKey, splitFootnoteInkHubKey } = await loadInkSync();
    expect(footnoteInkHubKey("pad-1", "wb7")).toBe("pad-1/fn/wb7");
    expect(splitFootnoteInkHubKey("pad-1/fn/wb7")).toEqual({
      docId: "pad-1",
      wbId: "wb7",
    });
  });

  it("leaves a plain pad key alone", async () => {
    const { splitFootnoteInkHubKey } = await loadInkSync();
    expect(splitFootnoteInkHubKey("pad-1")).toBeNull();
    expect(splitFootnoteInkHubKey("pad-1/fn/")).toBeNull();
    expect(splitFootnoteInkHubKey("/fn/wb7")).toBeNull();
  });

  it("routes each of the three key shapes to its own local store", async () => {
    const { inkDocKey } = await loadInkSync();
    expect(inkDocKey("whiteboard", "w1")).toBe("wb:w1");
    expect(inkDocKey("annotate", "pad-1")).toBe("md:pad-1");
    expect(inkDocKey("annotate", "pad-1/fn/wb7")).toBe("fnwb:pad-1:wb7");
  });
});

describe("footnoteInkKeys", () => {
  const anyBoard = async () => null;

  it("names a board this device has ink for but the hub has never seen", async () => {
    const { footnoteInkKeys } = await loadInkSync({ "fnwb:pad-1:wb7": [1] });
    expect(await footnoteInkKeys("pad-1", [], anyBoard)).toEqual(["pad-1/fn/wb7"]);
  });

  it("names a board the hub's digest has but this device does not", async () => {
    const { footnoteInkKeys } = await loadInkSync();
    expect(
      await footnoteInkKeys("pad-1", [digest("pad-1/fn/wb9", 1)], anyBoard),
    ).toEqual(["pad-1/fn/wb9"]);
  });

  it("does not confuse one pad's boards with another's", async () => {
    const { footnoteInkKeys } = await loadInkSync({
      "fnwb:pad-1:wb7": [1],
      "fnwb:pad-2:wb8": [1],
    });
    const keys = await footnoteInkKeys(
      "pad-1",
      [digest("pad-2/fn/wb9", 1), digest("pad-1", 3)],
      anyBoard,
    );
    expect(keys).toEqual(["pad-1/fn/wb7"]);
  });

  it("ignores a hub board no mark on this device points at", async () => {
    // Deleted here, still on the hub. Pulling it back is how a scratch board
    // the reader threw away comes home.
    const { footnoteInkKeys } = await loadInkSync({ "fnwb:pad-1:wb7": [1] });
    const keys = await footnoteInkKeys(
      "pad-1",
      [digest("pad-1/fn/orphan", 1)],
      async () => new Set(["wb7"]),
    );
    expect(keys).toEqual(["pad-1/fn/wb7"]);
  });

  it("syncs everything when the pointers cannot be read at all", async () => {
    // Unknown is not the same as deleted, and losing handwriting is worse than
    // a wasted transfer.
    const { footnoteInkKeys } = await loadInkSync({ "fnwb:pad-1:wb7": [1] });
    const keys = await footnoteInkKeys("pad-1", [digest("pad-1/fn/wb9", 1)], anyBoard);
    expect(keys).toEqual(["pad-1/fn/wb7", "pad-1/fn/wb9"]);
  });

  it("does not read the pointers for a pad with no scratch boards", async () => {
    // Reading them means reading the pad, and most pads have none.
    const { footnoteInkKeys } = await loadInkSync();
    const pointers = vi.fn(async () => new Set<string>());
    expect(await footnoteInkKeys("pad-1", [digest("pad-1", 3)], pointers)).toEqual([]);
    expect(pointers).not.toHaveBeenCalled();
  });
});

describe("applyFootnoteInkChoice", () => {
  const page = (key: string, pageId: number) => ({
    kind: "annotate" as const,
    key,
    page_id: pageId,
    updated_at: 20,
    gz: "YQ==",
  });

  it("keeps this device's boards and clears the hub pages it discarded", async () => {
    const { applyFootnoteInkChoice } = await loadInkSync({ "fnwb:pad-1:wb7": [1] });
    const putInkPage = vi.fn().mockResolvedValue(undefined);
    await applyFootnoteInkChoice(
      { putInkPage } as never,
      "pad-1",
      [{ wbId: "wb7", hubPageIds: [1, 2], localPageIds: [1] }],
      "local",
    );
    const keys = putInkPage.mock.calls.map((call) => [call[0].key, call[0].page_id]);
    // Page 1 is ours and goes up; page 2 is hub-only and is emptied.
    expect(keys).toContainEqual(["pad-1/fn/wb7", 1]);
    expect(keys).toContainEqual(["pad-1/fn/wb7", 2]);
  });

  it("fetches each board's bytes under that board's own key", async () => {
    const { applyFootnoteInkChoice } = await loadInkSync({ "fnwb:pad-1:wb7": [1] });
    const asked: Array<[string, readonly number[]]> = [];
    await applyFootnoteInkChoice(
      { putInkPage: vi.fn() } as never,
      "pad-1",
      [
        { wbId: "wb7", hubPageIds: [1], localPageIds: [1] },
        { wbId: "wb8", hubPageIds: [2, 3], localPageIds: [] },
      ],
      "server",
      {
        fetchHubPages: async (key, pageIds) => {
          asked.push([key, pageIds]);
          return pageIds.map((id) => page(key, id));
        },
      },
    );
    expect(asked).toEqual([
      ["pad-1/fn/wb7", [1]],
      ["pad-1/fn/wb8", [2, 3]],
    ]);
  });

  it("stops rather than half-writing a board it could not read", async () => {
    const { applyFootnoteInkChoice } = await loadInkSync({ "fnwb:pad-1:wb7": [1] });
    await expect(
      applyFootnoteInkChoice(
        { putInkPage: vi.fn() } as never,
        "pad-1",
        [{ wbId: "wb7", hubPageIds: [1], localPageIds: [1] }],
        "server",
        { fetchHubPages: async () => null },
      ),
    ).rejects.toThrow(/could not be read/);
  });

  it("does nothing at all when there are no scratch boards", async () => {
    const { applyFootnoteInkChoice } = await loadInkSync();
    const putInkPage = vi.fn();
    await applyFootnoteInkChoice({ putInkPage } as never, "pad-1", [], "local");
    expect(putInkPage).not.toHaveBeenCalled();
  });
});

describe("remintFootnoteInk", () => {
  const page = (key: string, pageId: number) => ({
    kind: "annotate" as const,
    key,
    page_id: pageId,
    updated_at: 20,
    gz: "YQ==",
  });

  it("gives the forked board the strokes of the one it was copied from", async () => {
    const { remintFootnoteInk } = await loadInkSync();
    const getInkPage = vi.fn(async (_k: string, key: string, id: number) =>
      key === "pad-1/fn/wb7" ? page(key, id) : null,
    );
    const putInkPage = vi.fn().mockResolvedValue(undefined);
    await remintFootnoteInk(
      { getInkPage, putInkPage } as never,
      "pad-1",
      "wb7",
      "wbFresh",
      [1, 2],
    );
    // Read from the board it came from, written under the id it now has.
    expect(getInkPage.mock.calls.every((call) => call[1] === "pad-1/fn/wb7")).toBe(true);
    expect(putInkPage.mock.calls.map((call) => call[0].key)).toEqual([
      "pad-1/fn/wbFresh",
      "pad-1/fn/wbFresh",
    ]);
  });

  it("is a no-op when the id did not actually move", async () => {
    const { remintFootnoteInk } = await loadInkSync();
    const getInkPage = vi.fn();
    await remintFootnoteInk({ getInkPage } as never, "pad-1", "wb7", "wb7", [1]);
    expect(getInkPage).not.toHaveBeenCalled();
  });

  it("writes nothing when the board it came from could not be read", async () => {
    const { remintFootnoteInk } = await loadInkSync();
    const putInkPage = vi.fn();
    await remintFootnoteInk(
      {
        getInkPage: async () => {
          throw new Error("offline");
        },
        putInkPage,
      } as never,
      "pad-1",
      "wb7",
      "wbFresh",
      [1],
    );
    expect(putInkPage).not.toHaveBeenCalled();
  });
});
