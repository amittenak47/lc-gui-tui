/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  announceSplitResize,
  boardResizeDeferred,
  deferPanelRefit,
  sashDragActive,
  SPLIT_RESIZE_EVENT,
  splitResizePhase,
} from "./splitResize";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.body.dataset.lcPanelMotion;
});

it("defers board fitting through panel motion and cancels superseded toggles", () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const settle = vi.fn();
  window.addEventListener(SPLIT_RESIZE_EVENT, settle);
  const cancel = deferPanelRefit();
  expect(boardResizeDeferred()).toBe(true);
  vi.advanceTimersByTime(100);
  expect(settle).not.toHaveBeenCalled();
  cancel();
  const finish = deferPanelRefit();
  vi.advanceTimersByTime(200);
  expect(boardResizeDeferred()).toBe(true);
  expect(settle).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60);
  expect(boardResizeDeferred()).toBe(false);
  expect(settle).toHaveBeenCalledTimes(1);
  finish();
  window.removeEventListener(SPLIT_RESIZE_EVENT, settle);
});

describe("announceSplitResize", () => {
  it("carries the phase to a listener", () => {
    const seen: (string | null)[] = [];
    const listener = (event: Event) => seen.push(splitResizePhase(event));
    window.addEventListener(SPLIT_RESIZE_EVENT, listener);
    announceSplitResize("move");
    announceSplitResize("settle");
    window.removeEventListener(SPLIT_RESIZE_EVENT, listener);
    expect(seen).toEqual(["move", "settle"]);
  });
});

describe("splitResizePhase", () => {
  it("is null for an unrelated event", () => {
    // Boards listen for several things on `window`; a plain resize must not be
    // mistaken for the end of a sash drag, which forces a refit.
    expect(splitResizePhase(new Event("resize"))).toBeNull();
  });

  it("is null for a detail that is not a phase", () => {
    expect(
      splitResizePhase(new CustomEvent(SPLIT_RESIZE_EVENT, { detail: { phase: "wat" } })),
    ).toBeNull();
  });
});

describe("sashDragActive", () => {
  it("is true only while the body carries the drag flag", () => {
    expect(sashDragActive()).toBe(false);
    document.body.dataset.lcSashDrag = "vertical";
    expect(sashDragActive()).toBe(true);
    delete document.body.dataset.lcSashDrag;
    expect(sashDragActive()).toBe(false);
  });
});
