/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { protectGestureSurface } from "./gestureExclusion";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => 2) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const releases: (() => void)[] = [];
let resizes: (() => void)[] = [];
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const surface = () => {
  const node = document.createElement("div");
  node.getBoundingClientRect = () => ({ left: 0, top: 60, width: 800, height: 1200 } as DOMRect);
  return node;
};
const protect = (node: HTMLElement, full = false) => {
  const release = protectGestureSurface(node, full); releases.push(release); return release;
};
beforeEach(() => {
  invoke.mockClear(); resizes = [];
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android tablet");
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { resizes.push(cb); } observe() {} disconnect() {} });
});
afterEach(async () => {
  releases.splice(0).forEach(release => release()); await flush();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("Android gesture guard ownership", () => {
  it("arms full page edges before the first swipe, then restores navigation", async () => {
    const release = protect(surface(), true); await flush();
    expect(invoke.mock.calls[0]).toEqual(["set_drawing_immersive", { enabled: true }]);
    expect(invoke.mock.calls[1]).toEqual(["set_gesture_exclusions", { density: 1, rects: [
      { x: 0, y: 60, width: 48, height: 1200 }, { x: 752, y: 60, width: 48, height: 1200 },
    ] }]);
    release(); await flush();
    expect(invoke.mock.calls.slice(-2)).toEqual([
      ["set_gesture_exclusions", { density: 1, rects: [] }], ["set_drawing_immersive", { enabled: false }],
    ]);
  });

  it("keeps the reader protected when another tab or drawing tool releases", async () => {
    const stopReading = protect(surface(), true);
    const stopWriting = protect(surface()); await flush();
    invoke.mockClear(); stopWriting(); await flush();
    expect(invoke.mock.calls.some(([cmd]) => cmd === "set_drawing_immersive")).toBe(false);
    const rects = invoke.mock.calls.at(-1)![1]!.rects as { height: number }[];
    expect(rects.map(r => r.height)).toEqual([1200, 1200]);
    stopReading(); await flush();
    expect(invoke).toHaveBeenLastCalledWith("set_drawing_immersive", { enabled: false });
  });

  it("updates page edges after rotation and coalesces abandoned claims", async () => {
    const node = surface(); const release = protect(node, true); await flush();
    node.getBoundingClientRect = () => ({ left: 0, top: 40, width: 1200, height: 700 } as DOMRect);
    resizes[0](); await flush();
    expect(invoke).toHaveBeenLastCalledWith("set_gesture_exclusions", { density: 1, rects: [
      { x: 0, y: 40, width: 48, height: 700 }, { x: 1152, y: 40, width: 48, height: 700 },
    ] });
    release(); await flush(); invoke.mockClear();
    const abandon = protect(surface(), true); abandon(); await flush();
    expect(invoke.mock.calls.some(([cmd]) => cmd === "set_drawing_immersive")).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("set_gesture_exclusions", { density: 1, rects: [] });
  });

  it("restores navigation if a reader closes while native immersive is still enabling", async () => {
    let finish!: (value: number) => void;
    invoke.mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    const release = protect(surface(), true); await flush();
    release();
    // A stale observer delivery must not recreate the disposed owner's claim.
    resizes[0](); finish(2); await flush();
    expect(invoke.mock.calls.slice(-2)).toEqual([
      ["set_gesture_exclusions", { density: 1, rects: [] }], ["set_drawing_immersive", { enabled: false }],
    ]);
  });

  it("does not change system navigation on desktop", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows desktop");
    protect(surface(), true); await flush(); expect(invoke).not.toHaveBeenCalled();
  });
});
