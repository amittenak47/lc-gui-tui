/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

import {
  DOC_CAMERA_LIVE_CLASS,
  isDocChromeTarget,
  isDocCameraLive,
  isSubMarkDragLive,
  pointerInSubMark,
  setDocCameraLive,
  setDocPointerHeld,
  setSubMarkDragLive,
  setSubMarkPointerHit,
  subscribeDocCameraLive,
} from "./docSelectionGesture";

afterEach(() => {
  setDocPointerHeld(false);
  setDocCameraLive(false);
});

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

describe("subscribeDocCameraLive", () => {
  it("notifies every subscriber without dropping the other", () => {
    const seen: boolean[][] = [[], []];
    const unsubA = subscribeDocCameraLive((live) => seen[0].push(live));
    const unsubB = subscribeDocCameraLive((live) => seen[1].push(live));
    setDocCameraLive(true);
    setDocCameraLive(false);
    expect(seen[0]).toEqual([true, false]);
    expect(seen[1]).toEqual([true, false]);
    unsubA();
    unsubB();
  });
});

describe("pointer held freezes the paint pump", () => {
  it("counts as camera-live so idle inflate yields before pan arms", () => {
    setDocPointerHeld(false);
    setDocCameraLive(false);
    expect(isDocCameraLive()).toBe(false);
    setDocPointerHeld(true);
    expect(isDocCameraLive()).toBe(true);
    setDocCameraLive(true);
    setDocPointerHeld(false);
    expect(isDocCameraLive()).toBe(true);
    setDocCameraLive(false);
    expect(isDocCameraLive()).toBe(false);
  });

  it("notifies subscribers on the held edge even when the pulse is still false", () => {
    setDocPointerHeld(false);
    setDocCameraLive(false);
    const seen: boolean[] = [];
    const unsub = subscribeDocCameraLive((live) => seen.push(live));
    setDocPointerHeld(true);
    setDocPointerHeld(false);
    expect(seen).toEqual([true, false]);
    unsub();
  });

  it("hides overlay text on the real camera pulse, not on pointer-down", () => {
    setDocPointerHeld(false);
    setDocCameraLive(false);
    setDocPointerHeld(true);
    expect(document.documentElement.classList.contains(DOC_CAMERA_LIVE_CLASS)).toBe(
      false,
    );
    setDocCameraLive(true);
    expect(document.documentElement.classList.contains(DOC_CAMERA_LIVE_CLASS)).toBe(
      true,
    );
    setDocCameraLive(false);
    expect(document.documentElement.classList.contains(DOC_CAMERA_LIVE_CLASS)).toBe(
      false,
    );
    setDocPointerHeld(false);
  });
});

describe("sub-mark drag live", () => {
  it("defaults off", () => {
    setSubMarkDragLive(false);
    expect(isSubMarkDragLive()).toBe(false);
  });

  it("Board pan only yields while a drag is live", () => {
    setSubMarkDragLive(true);
    expect(isSubMarkDragLive()).toBe(true);
    setSubMarkDragLive(false);
    expect(isSubMarkDragLive()).toBe(false);
  });
});
