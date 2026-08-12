import { describe, expect, it } from "vitest";

import {
  pointerInSubMark,
  setSubMarkPointerHit,
} from "./docSelectionGesture";

describe("pointerInSubMark", () => {
  it("is false when no hit-test is registered", () => {
    setSubMarkPointerHit(null);
    expect(pointerInSubMark(10, 10)).toBe(false);
  });

  it("delegates to the registered hit-test", () => {
    setSubMarkPointerHit((x, y) => x >= 0 && x <= 50 && y >= 0 && y <= 20);
    expect(pointerInSubMark(10, 10)).toBe(true);
    expect(pointerInSubMark(80, 10)).toBe(false);
    setSubMarkPointerHit(null);
  });
});
