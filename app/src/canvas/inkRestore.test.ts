import { describe, expect, it } from "vitest";

import { inkRestoreSource, shouldSeedInkFromBlob } from "./inkRestore";

describe("inkRestoreSource", () => {
  it("prefers shards, even when they are an empty erase", () => {
    expect(inkRestoreSource(1, 12)).toBe("shards");
    expect(inkRestoreSource(1, 0)).toBe("shards");
  });

  it("falls back to pad JSON when no shard rows exist", () => {
    expect(inkRestoreSource(0, 8)).toBe("blob");
  });

  it("is none when both stores are empty", () => {
    expect(inkRestoreSource(0, 0)).toBe("none");
  });
});

describe("shouldSeedInkFromBlob", () => {
  it("skips the empty inkC live autosave writes", () => {
    expect(shouldSeedInkFromBlob([])).toBe(false);
    expect(shouldSeedInkFromBlob(undefined)).toBe(false);
    expect(shouldSeedInkFromBlob([{ t: 1 }])).toBe(true);
  });
});
