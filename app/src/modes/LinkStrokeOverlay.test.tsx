/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LinkStrokeOverlay, type LinkChip, type LinkStrokeOverlayProps } from "./LinkStrokeOverlay";
import { boxesOverlap, type LinkHit } from "./linkHitTest";
import type { StrokePoint } from "./linkStroke";

const target = (id: string, x: number, y: number): LinkHit => ({
  id, label: id, kind: "mark", left: x - 20, top: y - 20, width: 40, height: 40,
});
const targets = [target("first", 100, 100), target("second", 300, 100), target("third", 500, 100), target("below", 100, 300)];
let host: HTMLDivElement;
let root: Root;
let overlay: HTMLDivElement;
let props: LinkStrokeOverlayProps;
let reducedMotion: boolean;
let suggest: (chips: LinkChip[]) => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reducedMotion = false;
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: reducedMotion, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = {
    marks: [],
    onSuggest: vi.fn(() => new Promise<LinkChip[]>((resolve) => { suggest = resolve; })),
    onResolve: vi.fn((box) => targets.filter((hit) => boxesOverlap(box, hit))),
    onCommit: vi.fn(), onCancel: vi.fn(), onNotice: vi.fn(),
  };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  act(() => root.render(<LinkStrokeOverlay {...props} />));
  overlay = host.querySelector<HTMLDivElement>(".lc-link-overlay")!;
  overlay.setPointerCapture = vi.fn();
  overlay.hasPointerCapture = vi.fn(() => true);
  overlay.releasePointerCapture = vi.fn();
}

function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => overlay.dispatchEvent(event));
}

function stroke(path: StrokePoint[]) {
  pointer("pointerdown", path[0]!.x, path[0]!.y);
  for (const point of path.slice(1, -1)) pointer("pointermove", point.x, point.y);
  pointer("pointerup", path[path.length - 1]!.x, path[path.length - 1]!.y);
}

function circle(x: number, y: number) {
  stroke(Array.from({ length: 25 }, (_, i) => ({
    x: x + Math.cos(i * Math.PI / 12) * 30,
    y: y + Math.sin(i * Math.PI / 12) * 30,
  })));
}

function pickTwo() {
  circle(100, 100);
  circle(300, 100);
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

function pickIds() {
  return [...host.querySelectorAll<HTMLElement>(".lc-link-pick")].map((pick) => pick.dataset.pickId);
}

describe("LinkStrokeOverlay gesture feedback", () => {
  it("announces each step, mentioning suggestions only when they are visible", async () => {
    mount();
    const hint = host.querySelector(".lc-link-hint")!;
    expect(hint.getAttribute("role")).toBe("status");
    expect(hint.getAttribute("aria-live")).toBe("polite");
    expect(hint.textContent).toBe("Circle the first thing");
    circle(100, 100);
    expect(hint.textContent).toBe("Circle the second thing");
    await act(async () => suggest([{ id: "suggestion", label: "Passage", kind: "suggestion", x: 600, y: 100 }]));
    expect(host.querySelectorAll(".lc-link-chip.is-suggestion")).toHaveLength(1);
    expect(hint.textContent).toBe("Circle the second thing — or draw to a suggestion");
    circle(300, 100);
    expect(hint.textContent).toBe("Draw a line from A to B");
  });

  it("does not mention suggestions when only mark chips are visible", () => {
    props.marks = [{ id: "second", label: "second", kind: "mark", x: 300, y: 100 }];
    mount();
    circle(100, 100);
    expect(host.querySelectorAll(".lc-link-chip.is-mark")).toHaveLength(1);
    expect(host.querySelector(".lc-link-hint")!.textContent).toBe("Circle the second thing");
  });

  it("labels A and B and replaces only B on a third loop", () => {
    mount();
    pickTwo();
    expect(host.querySelector(".lc-link-pick.is-a .lc-link-badge")!.textContent).toBe("A");
    expect(host.querySelector(".lc-link-pick.is-b .lc-link-badge")!.textContent).toBe("B");
    circle(500, 100);
    expect(pickIds()).toEqual(["first", "third"]);
    expect(host.querySelector(".lc-link-pick.is-a")!.getAttribute("data-pick-id")).toBe("first");
  });

  it("shows horizontal facing dots only after both targets are picked", () => {
    mount();
    expect(host.querySelectorAll(".lc-link-dot")).toHaveLength(0);
    circle(100, 100);
    expect(host.querySelectorAll(".lc-link-dot")).toHaveLength(0);
    circle(300, 100);
    const dots = host.querySelectorAll<HTMLElement>(".lc-link-dot");
    expect(dots).toHaveLength(2);
    expect([dots[0]!.style.left, dots[0]!.style.top]).toEqual(["40px", "20px"]);
    expect([dots[1]!.style.left, dots[1]!.style.top]).toEqual(["0px", "20px"]);
  });

  it("shows vertical facing dots", () => {
    mount();
    circle(100, 100);
    circle(100, 300);
    const dots = host.querySelectorAll<HTMLElement>(".lc-link-dot");
    expect([dots[0]!.style.left, dots[0]!.style.top]).toEqual(["20px", "40px"]);
    expect([dots[1]!.style.left, dots[1]!.style.top]).toEqual(["20px", "0px"]);
  });

  it("previews a valid release, returns to neutral outside reach, and keeps the freehand path", () => {
    mount();
    pickTwo();
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 150, 120);
    expect(overlay.classList.contains("is-ready")).toBe(false);
    pointer("pointermove", 300, 100);
    expect(overlay.classList.contains("is-ready")).toBe(true);
    expect(host.querySelector(".lc-link-pick.is-b")!.classList.contains("is-target")).toBe(true);
    expect(host.querySelector("polyline")!.getAttribute("points")).toBe("100,100 150,120 300,100");
    pointer("pointermove", 600, 100);
    expect(overlay.classList.contains("is-ready")).toBe(false);
    pointer("pointerup", 600, 100);
    advance(1000);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(props.onNotice).toHaveBeenCalledWith("Circle two targets, then stroke between them.");
    stroke([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
    advance(750);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenCalledWith("first", expect.objectContaining({ id: "second" }), expect.objectContaining({ id: "first" }));
  });

  it("turns the receiving A box green when connecting from B", () => {
    mount();
    pickTwo();
    pointer("pointerdown", 300, 100);
    pointer("pointermove", 100, 100);
    expect(overlay.classList.contains("is-ready")).toBe(true);
    expect(host.querySelector(".lc-link-pick.is-a")!.classList.contains("is-target")).toBe(true);
    pointer("pointerup", 100, 100);
    advance(750);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenCalledWith("first", expect.objectContaining({ id: "second" }), expect.objectContaining({ id: "first" }));
  });

  it.each(["mark", "suggestion"] as const)("previews and commits a one-pick stroke to a %s chip", async (kind) => {
    mount();
    circle(100, 100);
    await act(async () => suggest([{ id: "chip", label: "Target", kind, x: 600, y: 100 }]));
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 600, 100);
    expect(overlay.classList.contains("is-ready")).toBe(true);
    expect(host.querySelectorAll(".lc-link-dot")).toHaveLength(2);
    expect(host.querySelector(".lc-link-pick.is-b")!.classList.contains("is-target")).toBe(true);
    pointer("pointerup", 600, 100);
    advance(750);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenCalledWith("first", expect.objectContaining({ id: "chip", kind }), expect.objectContaining({ id: "first" }));
  });

  it("uses the existing one-pick origin restriction and notice for an invalid start", () => {
    mount();
    circle(100, 100);
    pointer("pointerdown", 500, 100);
    pointer("pointermove", 300, 100);
    expect(overlay.classList.contains("is-ready")).toBe(false);
    pointer("pointerup", 300, 100);
    advance(1000);
    expect(pickIds()).toEqual(["first"]);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(props.onNotice).toHaveBeenCalledWith("Start the connecting stroke on the circled target.");
  });

  it("preserves snippet fallback when previewing and releasing on empty paper", () => {
    mount();
    circle(100, 100);
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 800, 100);
    expect(overlay.classList.contains("is-ready")).toBe(true);
    pointer("pointerup", 800, 100);
    advance(750);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCommit).toHaveBeenCalledWith("first", expect.objectContaining({ id: "snippet:776:76" }), expect.objectContaining({ id: "first" }));
  });

  it("confirms at the path-length midpoint, fades, then commits exactly once while ignoring input", () => {
    mount();
    pickTwo();
    stroke([{ x: 100, y: 100 }, { x: 150, y: 120 }, { x: 300, y: 100 }]);
    expect(overlay.classList.contains("is-confirm")).toBe(true);
    const badge = host.querySelector<HTMLElement>(".lc-link-confirm")!;
    const fraction = (Math.hypot(50, 20) + Math.hypot(150, 20)) / 2 / Math.hypot(150, 20) - Math.hypot(50, 20) / Math.hypot(150, 20);
    expect(parseFloat(badge.style.left)).toBeCloseTo(150 + fraction * 150);
    expect(parseFloat(badge.style.top)).toBeCloseTo(120 - fraction * 20);
    expect(badge.textContent).toBe("✓");
    circle(500, 100);
    pointer("pointercancel", 500, 100);
    expect(pickIds()).toEqual(["first", "second"]);
    expect(host.querySelector("polyline")!.getAttribute("points")).toBe("100,100 150,120 300,100");
    advance(449);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(overlay.classList.contains("is-fading")).toBe(false);
    advance(1);
    expect(overlay.classList.contains("is-fading")).toBe(true);
    circle(500, 100);
    advance(299);
    expect(props.onCommit).not.toHaveBeenCalled();
    advance(1);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    advance(1000);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(host.querySelector("polyline")).toBeNull();
  });

  it("flashes a missed stroke and fades it while keeping both picks", () => {
    mount();
    pickTwo();
    stroke([{ x: 100, y: 100 }, { x: 600, y: 100 }]);
    expect(overlay.classList.contains("is-miss")).toBe(true);
    advance(249);
    expect(overlay.classList.contains("is-fading")).toBe(false);
    advance(1);
    expect(overlay.classList.contains("is-fading")).toBe(true);
    advance(300);
    expect(host.querySelector("polyline")).toBeNull();
    expect(pickIds()).toEqual(["first", "second"]);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("skips the fade and commits after 450ms with reduced motion", () => {
    reducedMotion = true;
    mount();
    pickTwo();
    stroke([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
    expect(overlay.classList.contains("is-reduced-motion")).toBe(true);
    advance(449);
    expect(overlay.classList.contains("is-fading")).toBe(false);
    expect(props.onCommit).not.toHaveBeenCalled();
    advance(1);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    expect(overlay.classList.contains("is-fading")).toBe(false);
    expect(host.querySelector("polyline")).toBeNull();
  });

  it("Escape clears confirmation and prevents a delayed commit", () => {
    mount();
    pickTwo();
    stroke([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
    advance(450);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(pickIds()).toEqual([]);
    expect(host.querySelector("polyline")).toBeNull();
    expect(host.querySelector(".lc-link-confirm")).toBeNull();
    advance(1000);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("parent cancellation by unmounting clears pending commit timers", () => {
    mount();
    pickTwo();
    stroke([{ x: 100, y: 100 }, { x: 300, y: 100 }]);
    act(() => root.render(null));
    advance(1000);
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a new stroke during miss feedback clears the old fade timer", () => {
    mount();
    pickTwo();
    stroke([{ x: 100, y: 100 }, { x: 600, y: 100 }]);
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 300, 100);
    advance(550);
    expect(overlay.classList.contains("is-ready")).toBe(true);
    expect(host.querySelector("polyline")).not.toBeNull();
    pointer("pointerup", 300, 100);
    advance(750);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
  });
});
