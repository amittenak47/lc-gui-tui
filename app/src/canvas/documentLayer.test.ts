/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { documentLayerHeight } from "./documentLayer";

describe("documentLayerHeight", () => {
  it("takes the inner document scrollHeight when the slot is still at the 1100 floor", () => {
    const slot = document.createElement("div");
    const inner = document.createElement("div");
    inner.className = "lc-md-ink-doc";
    slot.append(inner);
    Object.defineProperty(slot, "scrollHeight", { configurable: true, value: 1100 });
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 9000 });
    Object.defineProperty(inner, "offsetHeight", { configurable: true, value: 9000 });
    expect(documentLayerHeight(slot)).toBe(9000);
  });

  it("reads a code document the same way", () => {
    const slot = document.createElement("div");
    const inner = document.createElement("div");
    inner.className = "lc-code-doc";
    slot.append(inner);
    Object.defineProperty(slot, "scrollHeight", { configurable: true, value: 1100 });
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 4000 });
    Object.defineProperty(inner, "offsetHeight", { configurable: true, value: 4000 });
    expect(documentLayerHeight(slot)).toBe(4000);
  });
});
