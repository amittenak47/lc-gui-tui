import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeInkOps, encodeInkOps } from "../canvas/inkCodec";
import { isInkConflict, mergeEncodedPages, remoteWins } from "./inkSync";
import {
  clearInkConflicts,
  inkConflictMessage,
  inkConflictsFor,
  noteInkConflicts,
  resetInkConflictsForTests,
} from "./inkConflicts";

describe("remoteWins", () => {
  it("takes a page this device has never seen", () => {
    expect(remoteWins(undefined, { updated_at: 1 })).toBe(true);
  });

  it("takes the newer copy", () => {
    expect(remoteWins({ updatedAt: 5 }, { updated_at: 9 })).toBe(true);
    expect(remoteWins({ updatedAt: 9 }, { updated_at: 5 })).toBe(false);
  });

  it("keeps what is already here on a tie", () => {
    // Two devices saving in the same millisecond. Taking the incoming copy
    // resolves by whichever pinged last, which is a coin toss, not a rule.
    expect(remoteWins({ updatedAt: 7 }, { updated_at: 7 })).toBe(false);
  });
});

describe("isInkConflict", () => {
  const since = 100;

  it("is not a conflict when only the other device drew", () => {
    // The ordinary case: this page has not been touched here since the last
    // sync, so taking the remote copy discards nothing.
    expect(isInkConflict({ updatedAt: 50 }, { updated_at: 150 }, since)).toBe(false);
  });

  it("is not a conflict when only this device drew", () => {
    expect(isInkConflict({ updatedAt: 150 }, { updated_at: 50 }, since)).toBe(false);
  });

  it("is a conflict when both drew since they last agreed", () => {
    expect(isInkConflict({ updatedAt: 150 }, { updated_at: 160 }, since)).toBe(true);
  });

  it("is not a conflict for a page this device has never seen", () => {
    expect(isInkConflict(undefined, { updated_at: 160 }, since)).toBe(false);
  });

  it("is not a conflict when the two stamps are the same page", () => {
    // Identical stamps are the same save arriving back, not two of them.
    expect(isInkConflict({ updatedAt: 160 }, { updated_at: 160 }, since)).toBe(false);
  });
});

describe("ink conflict banner", () => {
  it("names the page and where the losing copy went", () => {
    resetInkConflictsForTests();
    noteInkConflicts([
      { kind: "whiteboard", key: "w1", pageId: 3, localUpdatedAt: 2, remoteUpdatedAt: 3 },
    ]);
    const message = inkConflictMessage(inkConflictsFor("whiteboard", "w1"));
    expect(message).toContain("page 3");
    expect(message).toContain("snapshots");
    resetInkConflictsForTests();
  });

  it("lists several pages in order and does not repeat one", () => {
    resetInkConflictsForTests();
    const row = (pageId: number) => ({
      kind: "whiteboard" as const,
      key: "w1",
      pageId,
      localUpdatedAt: 2,
      remoteUpdatedAt: 3,
    });
    noteInkConflicts([row(5), row(2), row(5)]);
    expect(inkConflictsFor("whiteboard", "w1").map((c) => c.pageId)).toEqual([2, 5]);
    expect(inkConflictMessage(inkConflictsFor("whiteboard", "w1"))).toContain("pages 2 and 5");
    resetInkConflictsForTests();
  });

  it("keeps one pad's conflicts out of another's", () => {
    resetInkConflictsForTests();
    noteInkConflicts([
      { kind: "whiteboard", key: "w1", pageId: 1, localUpdatedAt: 2, remoteUpdatedAt: 3 },
      { kind: "annotate", key: "a1", pageId: 9, localUpdatedAt: 2, remoteUpdatedAt: 3 },
    ]);
    expect(inkConflictsFor("whiteboard", "w1")).toHaveLength(1);
    clearInkConflicts("whiteboard", "w1");
    expect(inkConflictsFor("whiteboard", "w1")).toHaveLength(0);
    expect(inkConflictsFor("annotate", "a1")).toHaveLength(1);
    resetInkConflictsForTests();
  });

  it("says nothing when nothing collided", () => {
    expect(inkConflictMessage([])).toBeNull();
  });
});

describe("mergeEncodedPages", () => {
  it("puts both stroke sets on a shared page, this device first", () => {
    const localOp = {
      kind: "draw" as const,
      color: "#111",
      baseWidth: 2,
      maxFullness: 0.8,
      pressureClip: 0.6,
      pressureSensitive: false,
      points: [{ x: 1, y: 1, pressure: 0.5, slowness: 0.5 }],
    };
    const serverOp = {
      kind: "draw" as const,
      color: "#222",
      baseWidth: 2,
      maxFullness: 0.8,
      pressureClip: 0.6,
      pressureSensitive: false,
      points: [{ x: 9, y: 9, pressure: 0.5, slowness: 0.5 }],
    };
    const merged = mergeEncodedPages(
      new Map([[1, encodeInkOps([localOp])]]),
      new Map([[1, encodeInkOps([serverOp])]]),
    );
    const ops = decodeInkOps(merged.get(1)!);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ color: "#111" });
    expect(ops[1]).toMatchObject({ color: "#222" });
  });

  it("keeps a page that only one side has", () => {
    const only = encodeInkOps([]);
    const merged = mergeEncodedPages(new Map([[2, only]]), new Map());
    expect(merged.get(2)).toBe(only);
  });
});

describe("applyInkChoice", () => {
  afterEach(() => {
    vi.doUnmock("./inkPageStore");
    vi.doUnmock("./idb");
    vi.resetModules();
  });

  async function loadApply(localRows: Array<{ pageId: number }>) {
    const deleteInkPages = vi.fn(async () => {});
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
    vi.doMock("./inkPageStore", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./inkPageStore")>()),
      getInkPageRecords: () =>
        Promise.resolve(
          localRows.map((row) => ({
            v: 1 as const,
            docKey: "md:p1",
            pageId: row.pageId,
            gz: new Uint8Array([1, 2, 3]),
            dirty: true,
            updatedAt: 10,
          })),
        ),
      deleteInkPages,
    }));
    const mod = await import("./inkSync");
    return { applyInkChoice: mod.applyInkChoice, deleteInkPages };
  }

  const page = (pageId: number) => ({
    kind: "annotate" as const,
    key: "p1",
    page_id: pageId,
    updated_at: 20,
    gz: "YQ==",
  });

  it("does not wipe local pages when the hub download failed", async () => {
    const { applyInkChoice, deleteInkPages } = await loadApply([{ pageId: 1 }]);
    const putInkPage = vi.fn();
    await applyInkChoice(
      { putInkPage } as never,
      "annotate",
      "p1",
      "server",
      null,
    );
    expect(deleteInkPages).not.toHaveBeenCalled();
    expect(putInkPage).not.toHaveBeenCalled();
  });

  it("empty-PUTs hub-only page ids after keep-local", async () => {
    const { applyInkChoice, deleteInkPages } = await loadApply([{ pageId: 1 }]);
    const putInkPage = vi.fn().mockResolvedValue(undefined);
    await applyInkChoice(
      { putInkPage } as never,
      "annotate",
      "p1",
      "local",
      [page(1), page(2)],
    );
    expect(deleteInkPages).not.toHaveBeenCalled();
    const hubOnly = putInkPage.mock.calls.filter((call) => call[0]?.page_id === 2);
    expect(hubOnly).toHaveLength(1);
  });

  it("replaces local pages with the hub set on keep-server", async () => {
    const { applyInkChoice, deleteInkPages } = await loadApply([{ pageId: 1 }]);
    const putInkPage = vi.fn();
    await applyInkChoice(
      { putInkPage } as never,
      "annotate",
      "p1",
      "server",
      [page(2)],
    );
    expect(deleteInkPages).toHaveBeenCalledTimes(1);
    expect(putInkPage).not.toHaveBeenCalled();
  });

  it("empty-PUTs a hub page the preview list never downloaded", async () => {
    const { applyInkChoice } = await loadApply([{ pageId: 40 }]);
    const putInkPage = vi.fn().mockResolvedValue(undefined);
    await applyInkChoice(
      { putInkPage } as never,
      "annotate",
      "p1",
      "local",
      // The stash froze only the colliding page…
      [page(40)],
      // …but the digest names every page the hub holds.
      { hubPageIds: [40, 7, 12] },
    );
    const cleared = putInkPage.mock.calls
      .map((call) => call[0]?.page_id as number)
      .filter((id) => id !== 40)
      .sort((a, b) => a - b);
    expect(cleared).toEqual([7, 12]);
  });

  it("clears hub-only pages on keep-local even when the download failed", async () => {
    const { applyInkChoice } = await loadApply([{ pageId: 1 }]);
    const putInkPage = vi.fn().mockResolvedValue(undefined);
    await applyInkChoice({ putInkPage } as never, "annotate", "p1", "local", null, {
      hubPageIds: [1, 2],
    });
    const hubOnly = putInkPage.mock.calls.filter((call) => call[0]?.page_id === 2);
    expect(hubOnly).toHaveLength(1);
  });

  it("drop-both clears every hub page the digest names, not just the frozen one", async () => {
    const { applyInkChoice, deleteInkPages } = await loadApply([{ pageId: 40 }]);
    const putInkPage = vi.fn().mockResolvedValue(undefined);
    await applyInkChoice(
      { putInkPage } as never,
      "annotate",
      "p1",
      "none",
      [page(40)],
      { hubPageIds: [40, 7] },
    );
    expect(deleteInkPages).toHaveBeenCalledTimes(1);
    const cleared = putInkPage.mock.calls
      .map((call) => call[0]?.page_id as number)
      .sort((a, b) => a - b);
    expect(cleared).toEqual([7, 40]);
  });
});

describe("previewInkPages", () => {
  it("opens on the first page this device has ink for", async () => {
    const { previewInkPages } = await import("./inkSync");
    expect(previewInkPages([7, 12, 40], [1, 7])).toEqual([7]);
  });

  it("falls back to the hub's first page when this device has none", async () => {
    const { previewInkPages } = await import("./inkSync");
    expect(previewInkPages([], [12, 40])).toEqual([12]);
  });

  it("asks for nothing when neither side has ink", async () => {
    const { previewInkPages } = await import("./inkSync");
    expect(previewInkPages([], [])).toEqual([]);
  });
});

describe("fetchHubInkPages", () => {
  const page = (pageId: number) => ({
    kind: "annotate" as const,
    key: "p1",
    page_id: pageId,
    updated_at: 20,
    gz: "YQ==",
  });

  it("asks for the pages it names and nothing else", async () => {
    const { fetchHubInkPages } = await import("./inkSync");
    const getInkPage = vi.fn(async (_k: string, _key: string, id: number) => page(id));
    const rows = await fetchHubInkPages({ getInkPage } as never, "annotate", "p1", [40, 41]);
    expect(getInkPage).toHaveBeenCalledTimes(2);
    expect(rows?.map((row) => row.page_id).sort()).toEqual([40, 41]);
  });

  it("drops a page the hub does not have, without calling that a failure", async () => {
    const { fetchHubInkPages } = await import("./inkSync");
    const getInkPage = vi.fn(async (_k: string, _key: string, id: number) =>
      id === 40 ? page(40) : null,
    );
    const rows = await fetchHubInkPages({ getInkPage } as never, "annotate", "p1", [40, 41]);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.page_id).toBe(40);
  });

  it("is null when a transfer failed — not a short list", async () => {
    const { fetchHubInkPages } = await import("./inkSync");
    const getInkPage = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(
      await fetchHubInkPages({ getInkPage } as never, "annotate", "p1", [40]),
    ).toBeNull();
  });

  it("asks for nothing when nothing is named", async () => {
    const { fetchHubInkPages } = await import("./inkSync");
    const getInkPage = vi.fn();
    expect(await fetchHubInkPages({ getInkPage } as never, "annotate", "p1", [])).toEqual([]);
    expect(getInkPage).not.toHaveBeenCalled();
  });
});

describe("applyInkChoice fetches what a choice writes", () => {
  afterEach(() => {
    vi.doUnmock("./inkPageStore");
    vi.doUnmock("./idb");
    vi.resetModules();
  });

  async function loadApply(localRows: Array<{ pageId: number }>) {
    const written: Array<{ pageId: number }> = [];
    const deleteInkPages = vi.fn(async () => {});
    vi.resetModules();
    vi.doMock("./idb", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./idb")>()),
      withStore: async (
        _store: string,
        _mode: string,
        fn: (store: { put: (row: unknown, key: string) => void }) => void,
      ) => {
        fn({
          put: (row: unknown) => {
            written.push({ pageId: (row as { pageId: number }).pageId });
          },
        });
      },
    }));
    vi.doMock("./inkPageStore", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./inkPageStore")>()),
      getInkPageRecords: () =>
        Promise.resolve(
          localRows.map((row) => ({
            v: 1 as const,
            docKey: "md:p1",
            pageId: row.pageId,
            gz: new Uint8Array([1, 2, 3]),
            dirty: true,
            updatedAt: 10,
          })),
        ),
      deleteInkPages,
    }));
    const mod = await import("./inkSync");
    return { applyInkChoice: mod.applyInkChoice, deleteInkPages, written };
  }

  const page = (pageId: number) => ({
    kind: "annotate" as const,
    key: "p1",
    page_id: pageId,
    updated_at: 20,
    gz: "YQ==",
  });

  it("keep-server writes every hub page, not just the one the split drew", async () => {
    const { applyInkChoice, written } = await loadApply([{ pageId: 40 }]);
    const fetchHubPages = vi.fn(async (ids: readonly number[]) => ids.map(page));
    await applyInkChoice(
      { putInkPage: vi.fn() } as never,
      "annotate",
      "p1",
      "server",
      // The stash holds the previewed page only.
      [page(40)],
      { hubPageIds: [7, 40, 41], fetchHubPages },
    );
    expect(fetchHubPages).toHaveBeenCalledWith([7, 40, 41]);
    expect(written.map((row) => row.pageId).sort((a, b) => a - b)).toEqual([7, 40, 41]);
  });

  it("keep-server says so when a digest page 404'd — not a short list", async () => {
    const { applyInkChoice, deleteInkPages } = await loadApply([{ pageId: 40 }]);
    await expect(
      applyInkChoice(
        { putInkPage: vi.fn() } as never,
        "annotate",
        "p1",
        "server",
        [page(40)],
        {
          hubPageIds: [40, 41],
          fetchHubPages: async () => [page(40)],
        },
      ),
    ).rejects.toThrow(/could not be read/);
    expect(deleteInkPages).not.toHaveBeenCalled();
  });

  it("keep-server says so when the hub's handwriting could not be read", async () => {
    const { applyInkChoice, deleteInkPages } = await loadApply([{ pageId: 40 }]);
    await expect(
      applyInkChoice(
        { putInkPage: vi.fn() } as never,
        "annotate",
        "p1",
        "server",
        [page(40)],
        { hubPageIds: [40], fetchHubPages: async () => null },
      ),
    ).rejects.toThrow(/could not be read/);
    // Nothing cleared — silence here reads exactly like "the hub had no ink".
    expect(deleteInkPages).not.toHaveBeenCalled();
  });

  it("merge refuses to call a half-read hub a merge", async () => {
    const { applyInkChoice } = await loadApply([{ pageId: 40 }]);
    const putInkPage = vi.fn();
    await expect(
      applyInkChoice(
        { putInkPage } as never,
        "annotate",
        "p1",
        "merged",
        [page(40)],
        { hubPageIds: [40, 41], fetchHubPages: async () => null },
      ),
    ).rejects.toThrow(/could not be read/);
    expect(putInkPage).not.toHaveBeenCalled();
  });

  it("keep-local and drop-both never ask for bytes at all", async () => {
    const { applyInkChoice } = await loadApply([{ pageId: 40 }]);
    const fetchHubPages = vi.fn(async () => [] as never[]);
    const putInkPage = vi.fn().mockResolvedValue(undefined);
    await applyInkChoice(
      { putInkPage } as never,
      "annotate",
      "p1",
      "local",
      null,
      { hubPageIds: [7, 40], fetchHubPages },
    );
    await applyInkChoice(
      { putInkPage } as never,
      "annotate",
      "p1",
      "none",
      null,
      { hubPageIds: [7, 40], fetchHubPages },
    );
    expect(fetchHubPages).not.toHaveBeenCalled();
  });
});

describe("localInkAsDtos", () => {
  afterEach(() => {
    vi.doUnmock("./inkPageStore");
    vi.resetModules();
  });

  async function loadLocal(pageIds: number[]) {
    vi.resetModules();
    vi.doMock("./inkPageStore", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./inkPageStore")>()),
      getInkPageRecords: () =>
        Promise.resolve(
          pageIds.map((pageId) => ({
            v: 1 as const,
            docKey: "md:p1",
            pageId,
            gz: new Uint8Array([1, 2, 3]),
            dirty: true,
            updatedAt: 10,
          })),
        ),
    }));
    return (await import("./inkSync")).localInkAsDtos;
  }

  it("freezes only the colliding page out of a whole read-through", async () => {
    const localInkAsDtos = await loadLocal([1, 7, 12, 40, 41, 88]);
    const pages = await localInkAsDtos("annotate", "p1", [40]);
    expect(pages.map((row) => row.page_id)).toEqual([40]);
  });

  it("still takes the lot when no page is named — a pad stop names none", async () => {
    const localInkAsDtos = await loadLocal([1, 7, 40]);
    const pages = await localInkAsDtos("annotate", "p1");
    expect(pages.map((row) => row.page_id)).toEqual([1, 7, 40]);
  });

  it("asks for a page this device does not have and gets nothing", async () => {
    const localInkAsDtos = await loadLocal([1]);
    expect(await localInkAsDtos("annotate", "p1", [40])).toEqual([]);
  });
});

describe("syncInkPages strict pull", () => {
  afterEach(() => {
    vi.doUnmock("./inkPageStore");
    vi.doUnmock("./padHub");
    vi.resetModules();
  });

  async function loadSync(opts: { hub: boolean }) {
    vi.resetModules();
    vi.doMock("./padHub", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./padHub")>()),
      loadPadHub: () => (opts.hub ? { url: "http://hub.test", token: "t" } : null),
    }));
    vi.doMock("./inkPageStore", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./inkPageStore")>()),
      getInkPageRecords: () => Promise.resolve([]),
    }));
    return import("./inkSync");
  }

  it("throws in strict mode when a digest page has no payload", async () => {
    const { syncInkPages } = await loadSync({ hub: true });
    const client = {
      getInkPages: vi.fn().mockResolvedValue([]),
      putInkPage: vi.fn(),
    };
    await expect(
      syncInkPages(
        client as never,
        [{ kind: "annotate", key: "p1", page_id: 2, updated_at: 50 }],
        [{ kind: "annotate", key: "p1" }],
        0,
        { strict: true },
      ),
    ).rejects.toThrow(/missing from the hub download/);
  });

  it("swallows a missing page when the background ping is not strict", async () => {
    const { syncInkPages } = await loadSync({ hub: true });
    const client = {
      getInkPages: vi.fn().mockResolvedValue([]),
      putInkPage: vi.fn(),
    };
    await expect(
      syncInkPages(
        client as never,
        [{ kind: "annotate", key: "p1", page_id: 2, updated_at: 50 }],
        [{ kind: "annotate", key: "p1" }],
        0,
      ),
    ).resolves.toEqual([]);
  });
});
