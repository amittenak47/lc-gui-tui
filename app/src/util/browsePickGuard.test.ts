import { describe, expect, it } from "vitest";

import { BROWSE_PICK_QUIET_MS, browsePickBlocked } from "./browsePickGuard";

describe("browsePickBlocked", () => {
  it("blocks while a pad open is in flight", () => {
    expect(browsePickBlocked(true, 0, 1_000)).toBe(true);
  });

  it("blocks during the quiet window after the menu closes", () => {
    expect(browsePickBlocked(false, 1_000 + BROWSE_PICK_QUIET_MS, 1_000)).toBe(true);
  });

  it("allows a later deliberate pick", () => {
    expect(browsePickBlocked(false, 1_000, 1_000 + BROWSE_PICK_QUIET_MS)).toBe(false);
  });
});
