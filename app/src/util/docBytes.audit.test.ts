/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();

vi.mock("./idb", () => ({
  STORE_BYTES: "bytes",
  run: async (_s: string, _m: string, work: (s: unknown) => unknown) => {
    const fake = {
      get: (k: string) => ({ result: store.get(k) }),
      put: (v: unknown, k: string) => { store.set(k, v); return { result: undefined }; },
      delete: (k: string) => { store.delete(k); return { result: undefined }; },
      getKey: (k: string) => ({ result: store.has(k) ? k : undefined }),
      getAllKeys: () => ({ result: [...store.keys()] }),
      clear: () => { store.clear(); return { result: undefined }; },
    };
    return (work(fake) as { result: unknown }).result;
  },
}));

const { auditDocBytes, clearDocBytes, hashBytes } = await import("./docBytes");

const GOOD = new Uint8Array(4096).fill(3).buffer;
const GOOD_HASH = hashBytes(GOOD);
const OTHER = new Uint8Array(128).fill(9).buffer;
const OTHER_HASH = hashBytes(OTHER);
/* A hub error body filed under a real document's key. */
const POISON = Uint8Array.from('{"error":"no bytes"}', (c) => c.charCodeAt(0))
  .buffer as ArrayBuffer;

beforeEach(() => {
  store.clear();
  store.set(GOOD_HASH, GOOD);
  store.set(OTHER_HASH, POISON);
});

describe("auditDocBytes", () => {
  it("counts the rows that no longer match their key", async () => {
    const audit = await auditDocBytes();
    expect(audit.rows).toBe(2);
    expect(audit.bad).toBe(1);
  });

  it("changes nothing without repair", async () => {
    await auditDocBytes();
    expect(store.size).toBe(2);
  });

  it("drops only the bad row when repairing", async () => {
    const audit = await auditDocBytes({ repair: true });
    expect(audit.removed).toBe(1);
    expect(store.has(GOOD_HASH)).toBe(true);
    expect(store.has(OTHER_HASH)).toBe(false);
  });

  it("reports a clean store as clean", async () => {
    store.delete(OTHER_HASH);
    const audit = await auditDocBytes({ repair: true });
    expect(audit.bad).toBe(0);
    expect(audit.removed).toBe(0);
    expect(store.size).toBe(1);
  });

  it("totals the bytes it holds", async () => {
    const audit = await auditDocBytes();
    expect(audit.bytes).toBe(4096 + POISON.byteLength);
  });
});

describe("clearDocBytes", () => {
  it("empties the store and reports what it freed", async () => {
    const audit = await clearDocBytes();
    expect(audit.removed).toBe(2);
    expect(audit.freed).toBe(4096 + POISON.byteLength);
    expect(store.size).toBe(0);
  });
});

describe("an empty store is not a healthy one", () => {
  it("reports zero rows rather than zero bad rows", async () => {
    store.clear();
    const audit = await auditDocBytes();
    expect(audit.rows).toBe(0);
    expect(audit.bad).toBe(0);
    // The caller has to tell these apart: `bad === 0` is true for a healthy
    // store and for a store that has never held anything.
    expect(audit.bytes).toBe(0);
  });
});
