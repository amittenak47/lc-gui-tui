/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

import {
  DOC_CAMERA_LIVE_CLASS,
  isDocChromeTarget,
  isDocCameraLive,
  isSubMarkDragLive,
  makeDocFlagHolds,
  pointerInSubMark,
  resetDocCameraForTests,
  setDocCameraLive,
  setDocPointerHeld,
  setSubMarkDragLive,
  setSubMarkPointerHit,
  subscribeDocCameraLive,
} from "./docSelectionGesture";

afterEach(() => {
  resetDocCameraForTests();
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

describe("two surfaces share the flags", () => {
  it("stays live until the second camera lets go", () => {
    setDocCameraLive(true);
    setDocCameraLive(true);
    setDocCameraLive(false);
    // The Local pane settled; Server is still flicking.
    expect(isDocCameraLive()).toBe(true);
    setDocCameraLive(false);
    expect(isDocCameraLive()).toBe(false);
  });

  it("keeps the finger down until the second pointer lifts", () => {
    setDocPointerHeld(true);
    setDocPointerHeld(true);
    setDocPointerHeld(false);
    expect(isDocCameraLive()).toBe(true);
    setDocPointerHeld(false);
    expect(isDocCameraLive()).toBe(false);
  });

  it("keeps the overlay-text class up while any camera is live", () => {
    setDocCameraLive(true);
    setDocCameraLive(true);
    setDocCameraLive(false);
    expect(document.documentElement.classList.contains(DOC_CAMERA_LIVE_CLASS)).toBe(
      true,
    );
    setDocCameraLive(false);
    expect(document.documentElement.classList.contains(DOC_CAMERA_LIVE_CLASS)).toBe(
      false,
    );
  });

  it("publishes one edge per transition, not one per share", () => {
    const seen: boolean[] = [];
    const unsub = subscribeDocCameraLive((live) => seen.push(live));
    setDocCameraLive(true);
    setDocCameraLive(true);
    setDocCameraLive(false);
    setDocCameraLive(false);
    expect(seen).toEqual([true, false]);
    unsub();
  });

  it("a stray release cannot go negative and strand the next gesture", () => {
    setDocPointerHeld(false);
    setDocPointerHeld(false);
    setDocPointerHeld(true);
    expect(isDocCameraLive()).toBe(true);
    setDocPointerHeld(false);
    expect(isDocCameraLive()).toBe(false);
  });
});

describe("makeDocFlagHolds", () => {
  it("counts one share however many times a surface pulses", () => {
    const local = makeDocFlagHolds();
    const server = makeDocFlagHolds();
    // Local flicks: every scroll event pulses.
    local.camera(true);
    local.camera(true);
    local.camera(true);
    server.camera(true);
    local.camera(false);
    expect(isDocCameraLive()).toBe(true);
    server.camera(false);
    expect(isDocCameraLive()).toBe(false);
  });

  it("ignores a teardown from a surface that was never holding", () => {
    const local = makeDocFlagHolds();
    const server = makeDocFlagHolds();
    local.pointer(true);
    // Server unmounts without ever having had a finger on it.
    server.pointer(false);
    server.camera(false);
    expect(isDocCameraLive()).toBe(true);
    local.pointer(false);
    expect(isDocCameraLive()).toBe(false);
  });

  it("does not let one pane's unmount drop the other's finger", () => {
    const local = makeDocFlagHolds();
    const server = makeDocFlagHolds();
    local.pointer(true);
    server.pointer(true);
    server.pointer(false);
    server.camera(false);
    expect(isDocCameraLive()).toBe(true);
    local.pointer(false);
    expect(isDocCameraLive()).toBe(false);
  });

  it("resetDocCameraForTests drops every share", () => {
    const local = makeDocFlagHolds();
    local.camera(true);
    local.pointer(true);
    resetDocCameraForTests();
    expect(isDocCameraLive()).toBe(false);
    expect(document.documentElement.classList.contains(DOC_CAMERA_LIVE_CLASS)).toBe(
      false,
    );
  });
});
