/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();

vi.mock("./idb", () => ({
  STORE_BYTES: "bytes",
  run: async (_store: string, _mode: string, work: (s: unknown) => unknown) => {
    const fake = {
      get: (key: string) => ({ result: store.get(key) }),
      put: (value: unknown, key: string) => {
        store.set(key, value);
        return { result: undefined };
      },
      delete: (key: string) => {
        store.delete(key);
        return { result: undefined };
      },
      getKey: (key: string) => ({ result: store.has(key) ? key : undefined }),
    };
    return (work(fake) as { result: unknown }).result;
  },
}));

const { hashBytes, loadBinaryDocBytes } = await import("./docBytes");

const REAL = new Uint8Array(2048).fill(7).buffer;
const HASH = hashBytes(REAL);
/*
 * What a hub answered with in place of the file. Built through Uint8Array
 * rather than TextEncoder: under vitest the latter returns a buffer from
 * another realm, which `bytesFromStoredValue` rejects on `instanceof` before
 * the check under test is ever reached.
 */
const POISON = Uint8Array.from('{"error":"no bytes"}', (c) => c.charCodeAt(0))
  .buffer as ArrayBuffer;

beforeEach(() => store.clear());

describe("a row that is not the document it is filed under", () => {
  it("is not handed back as the file", async () => {
    store.set(HASH, POISON);
    expect(await loadBinaryDocBytes(HASH)).toBeNull();
  });

  it("is deleted, so the next launch is not poisoned too", async () => {
    store.set(HASH, POISON);
    await loadBinaryDocBytes(HASH);
    expect(store.has(HASH)).toBe(false);
  });

  it("falls through to the hub, and keeps an answer that checks out", async () => {
    store.set(HASH, POISON);
    const got = await loadBinaryDocBytes(HASH, async () => REAL);
    expect(got).not.toBeNull();
    expect(got!.byteLength).toBe(2048);
    expect(store.get(HASH)).toBeDefined();
  });

  it("refuses a hub answer that is not the document either", async () => {
    store.set(HASH, POISON);
    expect(await loadBinaryDocBytes(HASH, async () => POISON)).toBeNull();
    expect(store.has(HASH)).toBe(false);
  });

  it("still returns a row that does match", async () => {
    store.set(HASH, REAL);
    const got = await loadBinaryDocBytes(HASH);
    expect(got!.byteLength).toBe(2048);
  });
});

describe("putDocBytes refuses a row that is not its key", () => {
  it("throws rather than filing bytes under the wrong hash", async () => {
    const { putDocBytes } = await import("./docBytes");
    await expect(putDocBytes(HASH, POISON)).rejects.toThrow(/not that document/);
    expect(store.has(HASH)).toBe(false);
  });

  it("stores bytes that do match", async () => {
    const { putDocBytes } = await import("./docBytes");
    await putDocBytes(HASH, REAL);
    expect(store.get(HASH)).toBeDefined();
  });

  it("takes a key this build did not write on trust", async () => {
    const { putDocBytes } = await import("./docBytes");
    await putDocBytes("legacy-key", POISON);
    expect(store.get("legacy-key")).toBeDefined();
  });
});

describe("putDocBytesVerified", () => {
  it("reads the row back after put", async () => {
    const { putDocBytesVerified, getDocBytes } = await import("./docBytes");
    await putDocBytesVerified(HASH, REAL);
    const back = await getDocBytes(HASH);
    expect(back).not.toBeNull();
    expect(back!.byteLength).toBe(2048);
  });
});
