import { describe, expect, it } from "vitest";

import { LEGACY_THEME_KEY, MIGRATED_MARKER, THEME_KEY, remapLcKey } from "./storageKeys";
import { migrateLocalStorageKeys } from "./storageMigration";

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
  it("maps notebook, annotate, generic lc.*, and the legacy theme key", () => {
    expect(remapLcKey("lc.scratchpad.index.v1")).toBe("whiteboard.notebook.index.v1");
    expect(remapLcKey("lc.scratchpad.library.v1")).toBe("whiteboard.notebook.library.v1");
    expect(remapLcKey("lc.md-ink.index.v1")).toBe("whiteboard.annotate.index.v1");
    expect(remapLcKey("lc.md-ink.library.v1")).toBe("whiteboard.annotate.library.v1");
    expect(remapLcKey("lc.pairing")).toBe("whiteboard.pairing");
    expect(remapLcKey("lc.coach.forwardFailures.v1")).toBe("whiteboard.coach.forwardFailures.v1");
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
