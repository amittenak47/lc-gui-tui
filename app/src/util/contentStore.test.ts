/**
 * What happens when IndexedDB is not there.
 *
 * The node test environment has no IndexedDB at all, which makes it exactly the
 * device this fallback exists for — Safari private browsing, a WebView with
 * storage switched off, a tab blocking a version upgrade. If the spill path is
 * wrong, annotations are lost on those devices and nowhere else, which is the
 * hardest kind of loss to ever hear about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteContent, getContent, getManyContent, putContent } from "./contentStore";
import { StorageFullError } from "./storageQuota";

let store: Map<string, string>;

/** Spilled entries only — the store also holds the spill-only flag. */
function contentKeys(): string[] {
  return [...store.keys()].filter((key) => key.startsWith("whiteboard.content.v1."));
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

describe("with no IndexedDB", () => {
  it("still round-trips content", async () => {
    await putContent("mdink-1", { board: { v: 1 }, source: "# Notes" });
    expect(await getContent("mdink-1")).toEqual({ board: { v: 1 }, source: "# Notes" });
  });

  it("spills under a per-entry key, not one key for the library", async () => {
    // Per-entry matters even in the fallback: a whole-library key would put the
    // write amplification straight back, which is half of why any of this
    // moved.
    await putContent("a", { n: 1 });
    await putContent("b", { n: 2 });
    const keys = [...store.keys()].filter((key) =>
      key.startsWith("whiteboard.content.v1."),
    );
    expect(keys).toEqual([
      "whiteboard.content.v1.a",
      "whiteboard.content.v1.b",
    ]);
  });

  it("overwrites rather than accumulating", async () => {
    await putContent("a", { n: 1 });
    await putContent("a", { n: 2 });
    expect(contentKeys()).toHaveLength(1);
    expect(await getContent("a")).toEqual({ n: 2 });
  });

  it("returns null for content that was never written", async () => {
    expect(await getContent("missing")).toBeNull();
  });

  it("deletes", async () => {
    await putContent("a", { n: 1 });
    await deleteContent("a");
    expect(await getContent("a")).toBeNull();
    expect(contentKeys()).toHaveLength(0);
  });

  it("deletes every spill key that starts with a prefix", async () => {
    const { deleteContentByPrefix } = await import("./contentStore");
    await putContent("fnwb:doc-1:wb-a", { n: 1 });
    await putContent("fnwb:doc-1:wb-b", { n: 2 });
    await putContent("fnwb:doc-2:wb-a", { n: 3 });
    await deleteContentByPrefix("fnwb:doc-1:");
    expect(await getContent("fnwb:doc-1:wb-a")).toBeNull();
    expect(await getContent("fnwb:doc-1:wb-b")).toBeNull();
    expect(await getContent("fnwb:doc-2:wb-a")).toEqual({ n: 3 });
  });

  it("survives deleting something that is not there", async () => {
    await expect(deleteContent("never-existed")).resolves.toBeUndefined();
  });

  it("reports a full device rather than failing quietly", async () => {
    // Both backends refusing is the one case a caller has to hear about — it is
    // the difference between "saved somewhere else" and "not saved".
    vi.stubGlobal("localStorage", {
      length: 0,
      key: () => null,
      getItem: () => null,
      removeItem: () => {},
      setItem: () => {
        throw Object.assign(new Error("QuotaExceededError"), {
          name: "QuotaExceededError",
          code: 22,
        });
      },
    });
    await expect(putContent("a", { n: 1 })).rejects.toThrow(StorageFullError);
  });

  it("survives content that is not JSON-representable", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // Not a quota problem, so it must not be reported as one.
    await expect(putContent("a", cyclic)).rejects.not.toBeInstanceOf(StorageFullError);
  });
});

describe("getManyContent", () => {
  it("returns what exists and omits what does not", async () => {
    await putContent("a", { n: 1 });
    await putContent("c", { n: 3 });
    const found = await getManyContent(["a", "b", "c"]);
    expect([...found.keys()]).toEqual(["a", "c"]);
    expect(found.get("c")).toEqual({ n: 3 });
  });

  it("does not shift entries when one is missing", async () => {
    // A map rather than an array precisely so a hole is visible as a hole.
    await putContent("b", { n: 2 });
    const found = await getManyContent(["a", "b"]);
    expect(found.get("b")).toEqual({ n: 2 });
    expect(found.has("a")).toBe(false);
  });
});

describe("spill wins over stale IndexedDB", () => {
  afterEach(() => {
    vi.doUnmock("./idb");
    vi.resetModules();
  });

  it("returns the spill when both backends have the id", async () => {
    vi.resetModules();
    vi.doMock("./idb", () => ({
      run: async () => "old-from-idb",
      withStore: async () => {},
      STORE_CONTENT: "content",
    }));
    const { getContent } = await import("./contentStore");
    store.set("whiteboard.content.v1.entry-1", JSON.stringify({ n: "spill-new" }));
    expect(await getContent("entry-1")).toEqual({ n: "spill-new" });
  });
});

describe("spill-only signal", () => {
  it("goes up when a save lands in the fallback store", async () => {
    const { contentSpillOnly } = await import("./contentStore");
    expect(contentSpillOnly()).toBe(false);
    await putContent("a", { n: 1 });
    expect(contentSpillOnly()).toBe(true);
  });

  it("comes down when the last spilled entry is deleted", async () => {
    const { contentSpillOnly } = await import("./contentStore");
    await putContent("a", { n: 1 });
    await putContent("b", { n: 2 });
    await deleteContent("a");
    expect(contentSpillOnly()).toBe(true);
    await deleteContent("b");
    expect(contentSpillOnly()).toBe(false);
  });
});

describe("repairContentStore", () => {
  afterEach(() => {
    vi.doUnmock("./idb");
    vi.resetModules();
  });

  /** `contentStore` over an IndexedDB that behaves as `ok` says. */
  async function loadStore(ok: () => boolean) {
    const idb = new Map<string, unknown>();
    vi.resetModules();
    vi.doMock("./idb", () => ({
      run: async (
        _store: string,
        _mode: string,
        fn: (store: {
          put: (value: unknown, key: string) => void;
          get: (key: string) => unknown;
          delete: (key: string) => void;
        }) => unknown,
      ) => {
        if (!ok()) throw new Error("no IndexedDB");
        return fn({
          put: (value: unknown, key: string) => void idb.set(key, value),
          get: (key: string) => idb.get(key),
          delete: (key: string) => void idb.delete(key),
        });
      },
      withStore: async () => {},
      STORE_CONTENT: "content",
    }));
    return { mod: await import("./contentStore"), idb };
  }

  it("moves a long outage's spills across on the next launch", async () => {
    // The reader never saved these again — they belong to a document they
    // finished with. Nothing would ever have brought them back.
    store.set("whiteboard.content.v1.a", JSON.stringify({ n: 1 }));
    store.set("whiteboard.content.v1.b", JSON.stringify({ n: 2 }));
    store.set("whiteboard.storage.spillOnly", "1");
    const { mod, idb } = await loadStore(() => true);
    const result = await mod.repairContentStore();
    expect(result).toEqual({ promoted: 2, remaining: 0 });
    expect(idb.get("a")).toEqual({ n: 1 });
    expect(idb.get("b")).toEqual({ n: 2 });
    expect(mod.contentSpillOnly()).toBe(false);
  });

  it("leaves the spills alone and keeps the flag up when the database still refuses", async () => {
    store.set("whiteboard.content.v1.a", JSON.stringify({ n: 1 }));
    store.set("whiteboard.storage.spillOnly", "1");
    const { mod } = await loadStore(() => false);
    const result = await mod.repairContentStore();
    expect(result).toEqual({ promoted: 0, remaining: 1 });
    expect(store.get("whiteboard.content.v1.a")).toBeDefined();
    expect(mod.contentSpillOnly()).toBe(true);
  });

  it("sweeps once per launch", async () => {
    const { mod, idb } = await loadStore(() => true);
    store.set("whiteboard.content.v1.a", JSON.stringify({ n: 1 }));
    expect((await mod.repairContentStore()).promoted).toBe(1);
    store.set("whiteboard.content.v1.b", JSON.stringify({ n: 2 }));
    expect((await mod.repairContentStore()).promoted).toBe(0);
    expect(idb.has("b")).toBe(false);
    // The condition does not change on its own, but a caller may insist.
    expect((await mod.repairContentStore({ force: true })).promoted).toBe(1);
  });

  it("clears a stale flag on a launch with nothing spilled", async () => {
    store.set("whiteboard.storage.spillOnly", "1");
    const { mod } = await loadStore(() => true);
    expect(await mod.repairContentStore()).toEqual({ promoted: 0, remaining: 0 });
    expect(mod.contentSpillOnly()).toBe(false);
  });

  it("brings the rest across on the first save after recovery", async () => {
    // The in-memory bit is false after a reload; the durable flag is what
    // tells a healthy write there is still something stranded.
    store.set("whiteboard.content.v1.old", JSON.stringify({ n: 1 }));
    store.set("whiteboard.storage.spillOnly", "1");
    const { mod, idb } = await loadStore(() => true);
    await mod.putContent("new", { n: 2 });
    expect(idb.get("old")).toEqual({ n: 1 });
    expect(mod.contentSpillOnly()).toBe(false);
  });
});
