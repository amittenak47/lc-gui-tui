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
    const keys = [...store.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.startsWith("whiteboard.content.v1."))).toBe(true);
  });

  it("overwrites rather than accumulating", async () => {
    await putContent("a", { n: 1 });
    await putContent("a", { n: 2 });
    expect(store.size).toBe(1);
    expect(await getContent("a")).toEqual({ n: 2 });
  });

  it("returns null for content that was never written", async () => {
    expect(await getContent("missing")).toBeNull();
  });

  it("deletes", async () => {
    await putContent("a", { n: 1 });
    await deleteContent("a");
    expect(await getContent("a")).toBeNull();
    expect(store.size).toBe(0);
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
