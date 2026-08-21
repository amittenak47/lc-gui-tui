/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  announceSplitResize,
  SPLIT_RESIZE_EVENT,
  splitResizePhase,
} from "./splitResize";

afterEach(() => {
  vi.restoreAllMocks();
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
