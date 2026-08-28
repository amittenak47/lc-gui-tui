import { describe, expect, it } from "vitest";

import { LEGACY_THEME_KEY, MIGRATED_MARKER, THEME_KEY, remapLcKey } from "./storageKeys";
import {
  migrateLocalStorageKeys,
  migrationBatchIsFull,
  migrationRowSize,
  remapCoachStorageKeys,
} from "./storageMigration";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

describe("remapLcKey", () => {
  it("maps notebook, annotate, coach, generic lc.*, and the legacy theme key", () => {
    expect(remapLcKey("lc.scratchpad.index.v1")).toBe("whiteboard.notebook.index.v1");
    expect(remapLcKey("lc.scratchpad.library.v1")).toBe("whiteboard.notebook.library.v1");
    expect(remapLcKey("lc.md-ink.index.v1")).toBe("whiteboard.annotate.index.v1");
    expect(remapLcKey("lc.md-ink.library.v1")).toBe("whiteboard.annotate.library.v1");
    expect(remapLcKey("lc.pairing")).toBe("whiteboard.pairing");
    expect(remapLcKey("lc.coach.forwardFailures.v1")).toBe("whiteboard.agent.forwardFailures.v1");
    expect(remapLcKey("whiteboard.coach.forwardFailures.v1")).toBe(
      "whiteboard.agent.forwardFailures.v1",
    );
    expect(remapLcKey("lc.content.v1.abc")).toBe("whiteboard.content.v1.abc");
    expect(remapLcKey(LEGACY_THEME_KEY)).toBe(THEME_KEY);
  });

  it("leaves already-migrated and unrelated keys alone", () => {
    expect(remapLcKey(THEME_KEY)).toBeNull();
    expect(remapLcKey(MIGRATED_MARKER)).toBeNull();
    expect(remapLcKey("theme-other")).toBeNull();
  });
});

describe("migrateLocalStorageKeys", () => {
  it("copies old keys without clobbering a newer dest", () => {
    const storage = memoryStorage();
    storage.setItem("lc.pairing", "old-pair");
    storage.setItem("lc.scratchpad.index.v1", "[]");
    storage.setItem("lc-app-theme", "blue");
    storage.setItem("whiteboard.pairing", "kept");

    migrateLocalStorageKeys(storage);

    expect(storage.getItem("whiteboard.pairing")).toBe("kept");
    expect(storage.getItem("whiteboard.notebook.index.v1")).toBe("[]");
    expect(storage.getItem(THEME_KEY)).toBe("blue");
    expect(storage.getItem("lc.pairing")).toBe("old-pair");
  });
});

describe("remapCoachStorageKeys", () => {
  it("copies whiteboard.coach.* onto whiteboard.agent.* without clobbering dest", () => {
    const storage = memoryStorage();
    storage.setItem("whiteboard.coach.forwardFailures.v1", "1");
    storage.setItem("whiteboard.coach.sheetLock.v1", "0");
    storage.setItem("whiteboard.agent.forwardFailures.v1", "kept");

    remapCoachStorageKeys(storage);

    expect(storage.getItem("whiteboard.agent.forwardFailures.v1")).toBe("kept");
    expect(storage.getItem("whiteboard.agent.sheetLock.v1")).toBe("0");
    expect(storage.getItem("whiteboard.coach.forwardFailures.v1")).toBe("1");
  });
});

describe("IndexedDB copy batching", () => {
  it("measures a document by its bytes, not by being one row", () => {
    // The store this matters for holds whole PDFs. `getAll()` read every one
    // of them into memory at once, which is the peak that killed the launch.
    expect(migrationRowSize(new ArrayBuffer(4096))).toBe(4096);
    expect(migrationRowSize(new Uint8Array(2048))).toBe(2048);
    expect(migrationRowSize("ab")).toBe(4);
  });

  it("gives a size to rows it cannot measure, so they still bound a batch", () => {
    // Ink pages and board blobs are structured objects with no byteLength.
    // Zero would let an unbounded number of them into one batch.
    expect(migrationRowSize({ kind: "annotate", ops: [] })).toBeGreaterThan(0);
    expect(migrationRowSize(null)).toBeGreaterThan(0);
  });

  it("stops on whichever limit is reached first", () => {
    // Small and numerous: the row count is what ends the batch.
    expect(migrationBatchIsFull(63, 1024)).toBe(false);
    expect(migrationBatchIsFull(64, 1024)).toBe(true);
    // Large and few: the byte budget is.
    expect(migrationBatchIsFull(2, 8 * 1024 * 1024)).toBe(true);
    expect(migrationBatchIsFull(2, 4 * 1024 * 1024)).toBe(false);
  });

  it("does not stop an empty batch, so the copy can finish", () => {
    expect(migrationBatchIsFull(0, 0)).toBe(false);
  });
});
