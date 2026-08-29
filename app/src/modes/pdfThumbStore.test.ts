import { afterEach, describe, expect, it, vi } from "vitest";

import { pruneStoredPdfThumbs, resetPdfThumbStoreForTests } from "./pdfThumbStore";

describe("pruneStoredPdfThumbs", () => {
  afterEach(() => {
    resetPdfThumbStoreForTests();
    vi.unstubAllGlobals();
  });

  it("deletes thumbs whose document hash is not in the keep set", async () => {
    const rows = new Map<string, string>([
      ["keep-hash\x1f1", "a"],
      ["drop-hash\x1f1", "b"],
      ["drop-hash\x1f2", "c"],
    ]);
    type Cursor = {
      key: string;
      delete: () => void;
      continue: () => void;
    };
    let walking: string[] = [];
    let index = 0;
    const open = {
      result: {
        transaction: () => {
          const tx = {
            oncomplete: null as (() => void) | null,
            onabort: null as (() => void) | null,
            onerror: null as (() => void) | null,
            objectStore: () => ({
              openCursor: () => {
                walking = [...rows.keys()];
                index = 0;
                const req: {
                  result: Cursor | null;
                  onsuccess: (() => void) | null;
                  onerror: (() => void) | null;
                } = { result: null, onsuccess: null, onerror: null };
                const step = () => {
                  const key = walking[index];
                  if (key == null) {
                    req.result = null;
                    req.onsuccess?.();
                    queueMicrotask(() => tx.oncomplete?.());
                    return;
                  }
                  req.result = {
                    key,
                    delete: () => {
                      rows.delete(key);
                    },
                    continue: () => {
                      index += 1;
                      queueMicrotask(step);
                    },
                  };
                  req.onsuccess?.();
                };
                queueMicrotask(step);
                return req;
              },
            }),
          };
          return tx;
        },
      },
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    };
    vi.stubGlobal("indexedDB", {
      open: () => {
        queueMicrotask(() => open.onsuccess?.());
        return open;
      },
    });
    await pruneStoredPdfThumbs(["keep-hash"]);
    expect([...rows.keys()]).toEqual(["keep-hash\x1f1"]);
  });
});
