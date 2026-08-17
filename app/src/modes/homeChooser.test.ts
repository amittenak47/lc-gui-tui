import { describe, expect, it } from "vitest";

import { homeModeColumns } from "./HomeChooser";

describe("homeModeColumns", () => {
  it("halves an even count so the middle tier is two full rows", () => {
    expect(homeModeColumns(4)).toBe(2);
    expect(homeModeColumns(2)).toBe(1);
  });

  it("keeps an odd count on one row rather than orphaning a card", () => {
    expect(homeModeColumns(3)).toBe(3);
    expect(homeModeColumns(5)).toBe(5);
  });

  it("never returns zero columns", () => {
    expect(homeModeColumns(1)).toBe(1);
    expect(homeModeColumns(0)).toBe(1);
  });
});
