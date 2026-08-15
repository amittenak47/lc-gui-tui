import { describe, expect, it } from "vitest";

import { shouldDismissBackdrop } from "./backdropDismiss";

const backdrop = new EventTarget();
const panel = new EventTarget();

describe("shouldDismissBackdrop", () => {
  it("dismisses a press that started and ended on the backdrop", () => {
    expect(shouldDismissBackdrop(true, backdrop, backdrop)).toBe(true);
  });

  it("keeps the modal open when the press started on the panel", () => {
    expect(shouldDismissBackdrop(false, backdrop, backdrop)).toBe(false);
  });

  it("keeps the modal open when the click lands inside the panel", () => {
    expect(shouldDismissBackdrop(true, panel, backdrop)).toBe(false);
  });
});
