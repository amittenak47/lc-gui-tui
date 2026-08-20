/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import {
  isDocChromeTarget,
  pointerInSubMark,
  setSubMarkPointerHit,
} from "./docSelectionGesture";

describe("isDocChromeTarget", () => {
  it("treats a colour-wheel hub as overlay chrome", () => {
    const wheel = document.createElement("div");
    wheel.className = "lc-color-wheel";
    const hub = document.createElement("button");
    hub.className = "lc-color-wheel-hub";
    wheel.append(hub);
    document.body.append(wheel);
    expect(isDocChromeTarget(hub)).toBe(true);
    wheel.remove();
  });

  it("ignores page text", () => {
    const p = document.createElement("p");
    document.body.append(p);
    expect(isDocChromeTarget(p)).toBe(false);
    p.remove();
  });
});

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
