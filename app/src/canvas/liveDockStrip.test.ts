/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";

import { DOCK_STRIP_VAR, dockStrip, trackDockStrip } from "./liveDockStrip";

describe("dockStrip", () => {
  it("rounds up so no sliver of toolbar is left under the webview", () => {
    expect(dockStrip(51.2)).toBe("52px");
    expect(dockStrip(52)).toBe("52px");
  });

  it("reserves nothing for a dock that is not there", () => {
    // A collapsed dock measures zero, and holding a default height back for it
    // would crop the page on behalf of controls nobody can see.
    expect(dockStrip(0)).toBe("0px");
    expect(dockStrip(-4)).toBe("0px");
    expect(dockStrip(Number.NaN)).toBe("0px");
  });
});

describe("trackDockStrip", () => {
  function fakeDock(height: number) {
    const node = document.createElement("div");
    node.getBoundingClientRect = () => ({ height }) as DOMRect;
    return node;
  }

  it("publishes the height it measures", () => {
    const root = document.createElement("div");
    const stop = trackDockStrip(fakeDock(180), root);
    expect(root.style.getPropertyValue(DOCK_STRIP_VAR)).toBe("180px");
    stop?.();
  });

  it("clears the variable when the dock goes", () => {
    // Left behind, the reservation would crop a live page for a dock that had
    // already unmounted — the fallback is what a pane with no dock should use.
    const root = document.createElement("div");
    const stop = trackDockStrip(fakeDock(96), root);
    stop?.();
    expect(root.style.getPropertyValue(DOCK_STRIP_VAR)).toBe("");
  });

  it("follows the dock as it grows", () => {
    const root = document.createElement("div");
    let height = 48;
    const node = document.createElement("div");
    node.getBoundingClientRect = () => ({ height }) as DOMRect;
    const observers: Array<() => void> = [];
    const real = globalThis.ResizeObserver;
    globalThis.ResizeObserver = vi.fn((cb: () => void) => {
      observers.push(cb);
      return { observe: () => {}, disconnect: () => {} };
    }) as unknown as typeof ResizeObserver;
    const stop = trackDockStrip(node, root);
    expect(root.style.getPropertyValue(DOCK_STRIP_VAR)).toBe("48px");
    height = 210;
    observers.forEach((cb) => cb());
    expect(root.style.getPropertyValue(DOCK_STRIP_VAR)).toBe("210px");
    stop?.();
    globalThis.ResizeObserver = real;
  });

  it("does nothing when React hands back a detached ref", () => {
    // The unmount call is `ref(null)`, and it arrives after the disposer has
    // already run — so there is no dock to measure and nothing left to clean up.
    expect(trackDockStrip(null)).toBeUndefined();
  });
});
