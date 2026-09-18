/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateChromeControl,
  chromeControlAtPoint,
  chromeSurfaceAtPoint,
  pointInDomRect,
} from "./chromeHit";

function box(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
) {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right,
    bottom,
    toJSON: () => ({}),
  } as DOMRect);
}

function mountChrome(opts?: { inSlot?: boolean; collapsedToggle?: boolean }) {
  const controls = document.createElement("div");
  controls.className = "lc-map-controls";
  const left = document.createElement("div");
  left.className = "lc-map-chrome-left";
  const toggle = document.createElement("button");
  toggle.setAttribute("aria-label", "Show toolbar");
  toggle.className = "lc-lined-toggle";
  left.append(toggle);
  const dock = document.createElement("div");
  dock.className = "lc-board-dock";
  controls.append(left, dock);
  box(left, { left: 10, top: 700, width: 36, height: 36 });
  box(dock, { left: 80, top: 680, width: 200, height: 56 });
  if (opts?.collapsedToggle) {
    box(toggle, { left: 10, top: 700, width: 0, height: 0 });
  } else {
    box(toggle, { left: 10, top: 700, width: 36, height: 36 });
  }
  if (opts?.inSlot) {
    const slot = document.createElement("span");
    slot.className = "lc-board-chrome-slot";
    slot.append(controls);
    document.body.append(slot);
  } else {
    document.body.append(controls);
  }
  return { controls, left, toggle, dock };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("pointInDomRect", () => {
  it("rejects collapsed boxes so a faded tray is not a hit", () => {
    expect(
      pointInDomRect(12, 702, {
        left: 10,
        top: 700,
        right: 10,
        bottom: 700,
        width: 0,
        height: 0,
      }),
    ).toBe(false);
  });
});

describe("chromeControlAtPoint", () => {
  it("finds the annotate toggle in the chrome slot by box, not event.target", () => {
    const { toggle } = mountChrome({ inSlot: true });
    expect(chromeControlAtPoint(18, 712)).toBe(toggle);
    expect(chromeControlAtPoint(400, 400)).toBeNull();
  });

  it("finds in-board map controls when the slot is empty", () => {
    const { toggle } = mountChrome({ inSlot: false });
    expect(chromeControlAtPoint(18, 712)).toBe(toggle);
  });

  it("skips a collapsed annotate button", () => {
    mountChrome({ inSlot: true, collapsedToggle: true });
    expect(chromeControlAtPoint(18, 712)).toBeNull();
  });

  it("prefers the smaller control when boxes overlap", () => {
    const { toggle, left } = mountChrome({ inSlot: true });
    left.append(toggle);
    const inner = document.createElement("button");
    inner.setAttribute("aria-label", "inner");
    toggle.append(inner);
    box(inner, { left: 14, top: 704, width: 20, height: 20 });
    expect(chromeControlAtPoint(18, 712)).toBe(inner);
  });
});

describe("chromeHitAtPoint", () => {
  it("skips the rect walk for a tap in the middle of the page", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(400);
    const { toggle } = mountChrome({ inSlot: true });
    box(toggle, { left: 200, top: 200, width: 36, height: 36 });
    expect(chromeControlAtPoint(218, 218)).toBeNull();
  });
});

describe("chromeSurfaceAtPoint", () => {
  it("treats the left cluster padding as chrome even off the button", () => {
    mountChrome({ inSlot: true, collapsedToggle: true });
    expect(chromeSurfaceAtPoint(18, 712)).toBe(true);
    expect(chromeSurfaceAtPoint(400, 400)).toBe(false);
  });
});

describe("activateChromeControl", () => {
  it("clicks an ordinary toggle", () => {
    const { toggle } = mountChrome({ inSlot: true });
    const onClick = vi.fn();
    toggle.addEventListener("click", onClick);
    activateChromeControl(toggle);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("sends pointerdown to a wake dot, which swallows click", () => {
    const wake = document.createElement("button");
    wake.className = "lc-chrome-wake lc-chrome-wake-annotate";
    const onDown = vi.fn();
    const onClick = vi.fn((event: Event) => event.preventDefault());
    wake.addEventListener("pointerdown", onDown);
    wake.addEventListener("click", onClick);
    document.body.append(wake);
    activateChromeControl(wake);
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
