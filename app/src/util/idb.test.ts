/**
 * The one behaviour worth a fake database: a transaction that aborts *after*
 * its request succeeded.
 *
 * That is exactly how IndexedDB reports running out of quota, and the previous
 * version of `run` resolved on `request.onsuccess` alone — so a write that
 * never landed came back as a success. Every silent-loss path in this app has
 * had that shape.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "./idb";

type Handler = ((...args: unknown[]) => void) | null;

interface FakeRequest {
  result: unknown;
  error: Error | null;
  onsuccess: Handler;
  onerror: Handler;
}

/**
 * Minimal IndexedDB stand-in. `after` decides what happens once the request has
 * reported success: commit, or abort the way a full disk does.
 */
function fakeIndexedDb(after: "commit" | "abort" | "request-error") {
  const store = {
    put: (): FakeRequest => request(),
    get: (): FakeRequest => request("stored"),
    delete: (): FakeRequest => request(),
  };
  const requests: FakeRequest[] = [];
  function request(result: unknown = undefined): FakeRequest {
    const req: FakeRequest = { result, error: null, onsuccess: null, onerror: null };
    requests.push(req);
    return req;
  }

  const tx = {
    error: null as Error | null,
    onabort: null as Handler,
    oncomplete: null as Handler,
    onerror: null as Handler,
    objectStore: () => store,
  };

  const db = { transaction: () => tx };

  const open = {
    result: db,
    error: null as Error | null,
    onsuccess: null as Handler,
    onerror: null as Handler,
    onupgradeneeded: null as Handler,
    onblocked: null as Handler,
  };

  vi.stubGlobal("indexedDB", {
    open: () => {
      // Timers rather than microtasks: `run` creates its request inside a
      // `.then()` on the open promise, so the request does not exist until the
      // microtask queue has drained. Firing handlers too early tests nothing.
      setTimeout(() => {
        open.onsuccess?.();
        setTimeout(() => {
          if (after === "request-error") {
            requests.forEach((req) => {
              req.error = new Error("refused");
              req.onerror?.();
            });
            tx.error = new Error("refused");
            tx.onabort?.();
            return;
          }
          requests.forEach((req) => req.onsuccess?.());
          if (after === "abort") {
            tx.error = new Error("QuotaExceededError");
            tx.onabort?.();
          } else {
            tx.oncomplete?.();
          }
        }, 0);
      }, 0);
      return open;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("run", () => {
  it("rejects when the transaction aborts after the request succeeded", async () => {
    // The bug in one line. Without `tx.onabort` this resolves, and the caller
    // records a save that does not exist.
    fakeIndexedDb("abort");
    const { run: freshRun } = await import("./idb");
    await expect(
      freshRun("content", "readwrite", (store) => store.put("value", "k") as never),
    ).rejects.toThrow();
  });

  it("resolves on a transaction that commits", async () => {
    fakeIndexedDb("commit");
    const { run: freshRun } = await import("./idb");
    await expect(
      freshRun("content", "readonly", (store) => store.get("k") as never),
    ).resolves.toBe("stored");
  });

  it("rejects when the request itself fails", async () => {
    fakeIndexedDb("request-error");
    const { run: freshRun } = await import("./idb");
    await expect(
      freshRun("content", "readwrite", (store) => store.put("value", "k") as never),
    ).rejects.toThrow();
  });

  it("rejects rather than hanging when the environment has no IndexedDB", async () => {
    // Safari private browsing, a WebView with storage off. The caller needs an
    // answer so it can fall back; a promise that never settles takes the save
    // path down with it.
    vi.stubGlobal("indexedDB", undefined);
    const { run: freshRun } = await import("./idb");
    await expect(
      freshRun("content", "readonly", (store) => store.get("k") as never),
    ).rejects.toThrow();
  });
});

describe("the exported run", () => {
  it("is the same function the stores import", () => {
    expect(typeof run).toBe("function");
  });
});
