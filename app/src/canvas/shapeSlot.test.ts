import { describe, expect, it } from "vitest";

import { nextShapeSlot } from "./BoardToolbar";

describe("shape hold slot cycle", () => {
  it("rotates shapes → import photo → screencap → shapes", () => {
    expect(nextShapeSlot("shapes")).toBe("photos");
    expect(nextShapeSlot("photos")).toBe("capture");
    expect(nextShapeSlot("capture")).toBe("shapes");
  });
});
