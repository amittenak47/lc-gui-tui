import { describe, expect, it } from "vitest";

import { shouldWriteTier } from "./padSnapshotStore";

const HOUR = 60 * 60 * 1000;

describe("shouldWriteTier", () => {
  it("writes when the slot is empty", () => {
    expect(shouldWriteTier(null, 1_000, 2 * HOUR)).toBe(true);
    expect(shouldWriteTier(undefined, 1_000, 2 * HOUR)).toBe(true);
  });

  it("holds the slot until the window elapses", () => {
    const written = 10_000;
    expect(shouldWriteTier(written, written + 2 * HOUR - 1, 2 * HOUR)).toBe(false);
    expect(shouldWriteTier(written, written + 2 * HOUR, 2 * HOUR)).toBe(true);
  });
});
