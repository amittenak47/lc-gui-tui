/** @vitest-environment jsdom */
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkTileCache } from "./inkTiles";
import { WhiteboardInkLab, type RasterInkHandle } from "./WhiteboardInkLab";
import { paintInkTile } from "./inkLab/tilePaint";
import { invalidateBoardScrollHostLayout } from "./scrollHost";
import type { InkDrawOp, ViewportTransform } from "./rasterInk";

vi.mock("../util/cameraBusy", () => ({ yieldToInput: () => Promise.resolve() }));
vi.mock("./inkTileStore", () => ({
  inkTilePersistKey: () => "test", loadPersistedInkTiles: async () => [],
  blobFromTileSource: async () => null, persistInkTile: async () => {},
}));
const worker = vi.hoisted(() => ({ blocked: false, release: [] as Array<() => void> }));
vi.mock("./inkLab/tileRasterClient", () => ({
  rasterInkTileOffThread: async (job: Parameters<typeof paintInkTile>[1]) => {
    if (worker.blocked) await new Promise<void>(resolve => worker.release.push(resolve));
    const tile = createCanvas(416, 416);
    paintInkTile(tile.getContext("2d") as unknown as CanvasRenderingContext2D, job);
    return Object.assign(tile, { close() {} });
  },
}));

let root: Root;
let board: HTMLDivElement;
let backing: WeakMap<HTMLCanvasElement, Canvas>;
let view: ViewportTransform;
const ref = createRef<RasterInkHandle>();
const native = (canvas: HTMLCanvasElement) => {
  let c = backing.get(canvas);
  if (!c) { c = createCanvas(canvas.width, canvas.height); backing.set(canvas, c); }
  if (c.width !== canvas.width) c.width = canvas.width;
  if (c.height !== canvas.height) c.height = canvas.height;
  return c;
};
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} });
const stroke = (y: number, hostKey?: number): InkDrawOp => ({
  kind: "draw", color: "#ff0000", baseWidth: 4, maxFullness: 1,
  pressureClip: 1, pressureSensitive: false, hostKey, scrollLeftAtDraw: 0,
  points: [{ x: 80, y, pressure: .5 }, { x: 140, y, pressure: .5 }],
});
const surface = () => board.querySelector<HTMLCanvasElement>(".lc-ink-lab-canvas")!;
const alpha = (x: number, y: number) => native(surface()).getContext("2d").getImageData(x, y, 1, 1).data[3];
async function frames(count = 40) {
  await act(async () => { for (let i = 0; i < count; i++) await vi.advanceTimersByTimeAsync(17); });
}
async function mount(tool: "pen" | null = null) {
  await act(async () => root.render(<WhiteboardInkLab ref={ref} enabled preparing tool={tool}
    strokeWidth={3} inkColor="#ff0000" pressureClip={1} pressureSensitive={false}
    getViewport={() => view} />));
}
async function ready(ops: InkDrawOp[], tool: "pen" | null = null) {
  await mount(tool);
  ref.current!.setOps(ops, { paint: false });
  const prime = ref.current!.primeSnap();
  await frames(); await prime;
  await act(async () => root.render(<WhiteboardInkLab ref={ref} enabled tool={tool}
    strokeWidth={3} inkColor="#ff0000" pressureClip={1} pressureSensitive={false}
    getViewport={() => view} />));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  backing = new WeakMap();
  worker.blocked = false; worker.release = [];
  view = { zoom: 1, scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0, width: 400, height: 240 };
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return parseFloat((this as HTMLElement).style.width) || 400;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return parseFloat((this as HTMLElement).style.height) || 240;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const el = this as HTMLElement;
    if (el.tagName === "PRE") return rect(20, 400 + view.scrollY, 350, 120);
    const ride = /translate3d\(0px, (-?[\d.]+)px/.exec(el.style.transform);
    return rect(0, (parseFloat(el.style.top) || 0) + Number(ride?.[1] ?? 0), el.clientWidth, el.clientHeight);
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind !== "2d") return null;
    const ctx = native(this as HTMLCanvasElement).getContext("2d");
    return new Proxy(ctx, { get(target, key) {
      if (key === "drawImage") return (source: unknown, ...args: number[]) =>
        (target.drawImage as Function)(source instanceof HTMLCanvasElement ? native(source) : source, ...args);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    }, set(target, key, value) { return Reflect.set(target, key, value); } }) as unknown as CanvasRenderingContext2D;
  } as never);
  board = document.createElement("div"); board.className = "lc-board";
  const doc = document.createElement("div"); doc.className = "lc-md-ink-doc";
  const pre = document.createElement("pre"); pre.style.overflowX = "auto";
  Object.defineProperty(pre, "scrollWidth", { value: 800 });
  doc.append(pre); board.append(doc);
  const container = document.createElement("div"); board.append(container);
  document.body.append(board); root = createRoot(container);
});
afterEach(async () => {
  worker.blocked = false; worker.release.splice(0).forEach(resolve => resolve());
  await act(async () => root.unmount());
  delete document.body.dataset.lcPanelMotion;
  board.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("annotation camera presentation", () => {
  it("keeps highlights on their text when writing before a scroll rebase settles", async () => {
    await ready([stroke(100)]);
    await act(async () => root.render(<WhiteboardInkLab ref={ref} enabled tool="highlighter"
      strokeWidth={3} inkColor="#ffe500" pressureClip={1} pressureSensitive={false}
      getViewport={() => view} />));
    view = { ...view, scrollY: -60 };
    expect(ref.current!.setPanOffset(view)).toBe(true);
    const event = (type: string, x: number, y: number) => {
      const e = new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true });
      Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: "pen" }, pressure: { value: .5 } });
      surface().dispatchEvent(e);
    };
    for (const y of [60, 100, 140]) {
      await act(async () => { event("pointerdown", 80, y); event("pointermove", 140, y); event("pointerup", 140, y); });
    }
    const highlights = ref.current!.getOps().filter(op => op.kind === "draw" && op.highlight);
    expect(highlights).toHaveLength(3);
    expect(highlights.map(op => op.points[0].y)).toEqual([120, 160, 200]);
    const pending = ref.current!.syncCamera();
    await frames(); await pending;
    for (const y of [60, 100, 140]) expect(alpha(110, y + 180)).toBeGreaterThan(0);
    const saved = ref.current!.snapshotInkPages();
    ref.current!.clear();
    ref.current!.ingestInkPages(saved, {paint:false});
    const reopened = ref.current!.primeSnap();
    await frames(); await reopened;
    expect(ref.current!.getOps().filter(op => op.kind === "draw" && op.highlight)).toHaveLength(3);
    for (const y of [60, 100, 140]) expect(alpha(110, y + 180)).toBeGreaterThan(0);
  });
  it("reuses the painted camera when a same-size parked tab returns", async () => {
    await ready([stroke(100)]);
    const draw = vi.spyOn(InkTileCache.prototype, "draw");
    const render = (splitPaused: boolean) => <WhiteboardInkLab ref={ref} enabled splitPaused={splitPaused} tool={null}
      strokeWidth={3} inkColor="#ff0000" pressureClip={1} pressureSensitive={false} getViewport={() => view} />;
    await act(async () => root.render(render(true)));
    await frames(10);
    await act(async () => root.render(render(false)));
    await frames(10);
    expect(draw).not.toHaveBeenCalled();
    expect(alpha(100, 280)).toBeGreaterThan(0);
    expect(surface().style.visibility).toBe("");
  });

  it("keeps an empty canvas writable after a paused split resize", async () => {
    await ready([], "pen");
    const render = (splitPaused: boolean) => <WhiteboardInkLab ref={ref} enabled splitPaused={splitPaused} tool="pen"
      strokeWidth={3} inkColor="#ff0000" pressureClip={1} pressureSensitive={false} getViewport={() => view} />;
    await act(async () => root.render(render(true)));
    surface().parentElement!.style.width = "200px";
    view = { ...view, width: 200 };
    await act(async () => root.render(render(false)));
    await frames();
    expect(surface().style.visibility).toBe("");
    expect(surface().width).toBe(200);
    const event = (type: string, x: number) => {
      const e = new MouseEvent(type, { button: 0, clientX: x, clientY: 100, bubbles: true });
      Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: "pen" }, pressure: { value: .5 } });
      surface().dispatchEvent(e);
    };
    await act(async () => { event("pointerdown", 80); event("pointermove", 140); event("pointerup", 140); });
    expect(ref.current!.getOpCount()).toBe(1);
    expect(alpha(100, 280)).toBeGreaterThan(0);
  });

  it("hides an unsafe old camera until interrupted loading lands at the latest page", async () => {
    await ready([stroke(100), stroke(850)]);
    worker.blocked = true;
    view = { ...view, scrollY: -400 };
    expect(ref.current!.setPanOffset(view)).toBe(false);
    expect(surface().style.visibility).toBe("hidden");
    const pending = ref.current!.syncCamera();
    await frames(3);
    expect(surface().style.visibility).toBe("hidden");
    view = { ...view, scrollY: -800 };
    ref.current!.setPanOffset(view);
    expect(surface().style.visibility).toBe("hidden");
    worker.blocked = false; worker.release.splice(0).forEach(resolve => resolve());
    await frames(80); await pending;
    expect(surface().style.visibility).toBe("");
    expect(surface().style.transform).toBe("");
    expect(alpha(100, 230)).toBeGreaterThan(0);
    view = { ...view, scrollY: -820 };
    expect(ref.current!.setPanOffset(view)).toBe(true);
    expect(surface().style.transform).toBe("translate3d(0px, -20px, 0)");
    // Board landing an older request must not clear this newer translation.
    ref.current!.setPanOffset(null);
    expect(surface().style.transform).toBe("translate3d(0px, -20px, 0)");
  });

  it("scales both ink axes with the camera during panel motion without reallocating", async () => {
    await ready([stroke(100)]);
    const canvas = surface(), width = canvas.width, height = canvas.height;
    const tiles = vi.spyOn(InkTileCache.prototype, "draw");
    document.body.dataset.lcPanelMotion = "true";
    for (const zoom of [.8, .5, .7, 1]) {
      view = { ...view, zoom, scrollX: 20, scrollY: 40 };
      canvas.parentElement!.style.width = `${400 * zoom}px`;
      await ref.current!.syncCamera();
      await frames(2);
      expect(canvas.width).toBe(width);
      expect(canvas.height).toBe(height);
      expect(tiles).not.toHaveBeenCalled();
      expect(canvas.style.visibility).toBe("");
      const parts = /translate3d\(([^p]+)px, ([^p]+)px, 0\) scale\(([^)]+)\)/.exec(canvas.style.transform)!;
      expect(parts).not.toBeNull();
      const [, dx, dy, scale] = parts.map(Number);
      // The original painted point is (100, 100 + overdraw). After CSS
      // transformation it must match the document's new scene projection.
      expect(100 * scale + dx).toBeCloseTo((100 + view.scrollX) * zoom);
      expect((100 + 180) * scale + dy - 180).toBeCloseTo((100 + view.scrollY) * zoom);
    }
    delete document.body.dataset.lcPanelMotion;
    const settled = ref.current!.syncCamera();
    await frames(); await settled;
    expect(canvas.style.transform).toBe("");
    expect(alpha(120, 320)).toBeGreaterThan(0);
  });

  it("keeps the right-hand ink aligned while panel settle waits for sharp tiles", async () => {
    const right = stroke(100);
    right.points = [{ x: 280, y: 100, pressure: .5 }, { x: 340, y: 100, pressure: .5 }];
    await ready([right]);
    document.body.dataset.lcPanelMotion = "true";
    view = { ...view, zoom: .5, width: 200 };
    surface().parentElement!.style.width = "200px";
    await ref.current!.syncCamera();
    worker.blocked = true;
    delete document.body.dataset.lcPanelMotion;
    const settled = ref.current!.syncCamera();
    await frames(3);
    expect(surface().style.visibility).toBe("");
    expect(surface().width).toBe(200);
    // The original x=300 is beyond the new backing width; preserve it at
    // x=150 rather than clipping it before scaling or stretching just X.
    expect(alpha(150, 230)).toBeGreaterThan(0);
    expect(alpha(150, 280)).toBe(0);
    worker.blocked = false; worker.release.splice(0).forEach(resolve => resolve());
    await frames(80); await settled;
    expect(surface().style.transform).toBe("");
    expect(alpha(150, 230)).toBeGreaterThan(0);
  });

  it("hides ink during pinch and until the final camera tiles are ready", async () => {
    await ready([stroke(100)]);
    const canvas = surface(), bitmap = [canvas.width, canvas.height];
    const tiles = vi.spyOn(InkTileCache.prototype, "draw");
    ref.current!.setCameraZooming(true);
    expect(canvas.style.visibility).toBe("hidden");
    ref.current!.setCameraMoving(true);
    for (const zoom of [1.1, 1.4, 1.8, 2]) {
      view = { ...view, zoom, scrollX: -40, scrollY: -50 };
      ref.current!.setPanOffset(view);
      await ref.current!.syncCamera(); await frames(2);
      expect(canvas.style.visibility).toBe("hidden");
      expect([canvas.width, canvas.height]).toEqual(bitmap);
    }
    expect(tiles).not.toHaveBeenCalled();
    worker.blocked = true;
    ref.current!.setCameraZooming(false);
    ref.current!.setCameraMoving(false);
    const settled = ref.current!.syncCamera();
    await frames(10);
    expect(canvas.style.visibility).toBe("hidden");
    worker.blocked = false; worker.release.splice(0).forEach(resolve => resolve());
    await frames(80); await settled;
    expect(canvas.style.visibility).toBe("");
    expect(canvas.style.transform).toBe("");
    expect(alpha(120, 280)).toBeGreaterThan(0);
    expect(tiles).toHaveBeenCalled();
  });

  it("restores ink after a pinch with no camera movement", async () => {
    await ready([stroke(100)]);
    ref.current!.setCameraZooming(true);
    expect(surface().style.visibility).toBe("hidden");
    ref.current!.setCameraZooming(false);
    const settled = ref.current!.syncCamera(); await frames(); await settled;
    expect(surface().style.visibility).toBe("");
    expect(alpha(100, 280)).toBeGreaterThan(0);
  });

  it("does not reveal a previous pinch's tiles during a new pinch", async () => {
    await ready([stroke(100)]);
    worker.blocked = true;
    ref.current!.setCameraZooming(true);
    view = { ...view, zoom: 2 };
    ref.current!.setCameraZooming(false);
    const first = ref.current!.syncCamera(); await frames(4);
    ref.current!.setCameraZooming(true);
    view = { ...view, zoom: 1.5 };
    worker.blocked = false; worker.release.splice(0).forEach(resolve => resolve());
    await frames(20);
    expect(surface().style.visibility).toBe("hidden");
    ref.current!.setCameraZooming(false);
    const second = ref.current!.syncCamera(); await frames(80);
    await Promise.all([first, second]);
    expect(surface().style.visibility).toBe("");
    expect(alpha(150, 330)).toBeGreaterThan(0);
  });

  it("keeps freshly written unsaved ink at its scene position after pinch", async () => {
    await ready([], "pen");
    const event = (type: string, x: number) => {
      const e = new MouseEvent(type, { button: 0, clientX: x, clientY: 100, bubbles: true });
      Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: "pen" }, pressure: { value: .5 } });
      surface().dispatchEvent(e);
    };
    await act(async () => {
      event("pointerdown", 80); event("pointermove", 140); event("pointerup", 140);
    });
    const original = structuredClone(ref.current!.getOps());
    expect(original).toHaveLength(1);
    ref.current!.setCameraZooming(true);
    view = { ...view, zoom: 2, scrollX: -40, scrollY: -50 };
    ref.current!.setPanOffset(view);
    await frames(2);
    expect(surface().style.visibility).toBe("hidden");
    ref.current!.setCameraZooming(false);
    const settled = ref.current!.syncCamera(); await frames(80); await settled;
    expect(surface().style.visibility).toBe("");
    expect(ref.current!.getOps()).toEqual(original);
    expect(alpha(120, 280)).toBeGreaterThan(0);
    expect(ref.current!.undo()).toBe(true);
    await frames(80);
    expect(ref.current!.getOpCount()).toBe(0);
    expect(alpha(120, 280)).toBe(0);
    expect(ref.current!.redo()).toBe(true);
    await frames(80);
    expect(ref.current!.getOps()).toEqual(original);
    expect(alpha(120, 280)).toBeGreaterThan(0);
  });

  it("clears the last undone stroke immediately after a camera rebase", async () => {
    await ready([], "pen");
    const event = (type: string, x: number) => {
      const e = new MouseEvent(type, { button: 0, clientX: x, clientY: 100, bubbles: true });
      Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: "pen" }, pressure: { value: .5 } });
      surface().dispatchEvent(e);
    };
    await act(async () => {
      event("pointerdown", 80); event("pointermove", 140); event("pointerup", 140);
    });
    view = { ...view, scrollY: -20 };
    const settled = ref.current!.syncCamera();
    await frames(80); await settled;
    expect(alpha(100, 260)).toBeGreaterThan(0);
    worker.blocked = true;
    expect(ref.current!.undo()).toBe(true);
    expect(ref.current!.getOpCount()).toBe(0);
    // No timer or worker completion should be needed to erase an empty page.
    expect(alpha(100, 260)).toBe(0);
    await frames(10);
    expect(alpha(100, 260)).toBe(0);
    worker.blocked = false; worker.release.splice(0).forEach(resolve => resolve());
    expect(ref.current!.redo()).toBe(true);
    await frames(80);
    expect(alpha(100, 260)).toBeGreaterThan(0);
  });

  it("does not resurrect undone ink when pinch tiles finish loading", async () => {
    await ready([], "pen");
    const event = (type: string, x: number) => {
      const e = new MouseEvent(type, { button: 0, clientX: x, clientY: 100, bubbles: true });
      Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: "pen" }, pressure: { value: .5 } });
      surface().dispatchEvent(e);
    };
    await act(async () => {
      event("pointerdown", 80); event("pointermove", 140); event("pointerup", 140);
    });
    ref.current!.setCameraZooming(true);
    view = { ...view, zoom: 2, scrollX: -40, scrollY: -50 };
    worker.blocked = true;
    ref.current!.setCameraZooming(false);
    const settled = ref.current!.syncCamera();
    await frames(4);
    expect(ref.current!.undo()).toBe(true);
    await frames(4);
    worker.blocked = false; worker.release.splice(0).forEach(resolve => resolve());
    await frames(80); await settled;
    expect(surface().style.visibility).toBe("");
    expect(ref.current!.getOpCount()).toBe(0);
    expect(alpha(120, 280)).toBe(0);
    expect(ref.current!.redo()).toBe(true);
    await frames(80);
    expect(alpha(120, 280)).toBeGreaterThan(0);
  });

  it("hides a stale zoom until an aligned replacement is presented", async () => {
    await ready([stroke(100)]);
    view = { ...view, zoom: 2 };
    ref.current!.setPanOffset(view);
    expect(surface().style.visibility).toBe("hidden");
    const pending = ref.current!.syncCamera();
    await frames(); await pending;
    expect(surface().style.visibility).toBe("");
    expect(alpha(200, 380)).toBeGreaterThan(0);
  });

  it("applies 55 rapid undos and redos while coalescing cache work beyond pixel history", async () => {
    await ready([], "pen");
    const event = (type: string, y: number) => {
      const e = new MouseEvent(type, { button: 0, clientX: 100, clientY: y, bubbles: true });
      Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: "pen" }, pressure: { value: .5 } });
      surface().dispatchEvent(e);
    };
    for (let i = 0; i < 60; i++) {
      await act(async () => { event("pointerdown", 40 + i * 2); event("pointerup", 41 + i * 2); });
    }
    expect(ref.current!.getOpCount()).toBe(60);
    const sync = vi.spyOn(InkTileCache.prototype, "syncHistoryDeferred");
    await act(async () => { for (let i = 0; i < 55; i++) expect(ref.current!.undo()).toBe(true); });
    expect(ref.current!.getOpCount()).toBe(5); expect(sync).not.toHaveBeenCalled();
    await frames(30); expect(sync).toHaveBeenCalledTimes(1);
    await act(async () => { for (let i = 0; i < 55; i++) expect(ref.current!.redo()).toBe(true); });
    expect(ref.current!.getOpCount()).toBe(60);
    await frames(30); expect(sync).toHaveBeenCalledTimes(2);
    expect(alpha(100, 180 + 40)).toBeGreaterThan(0);
  });
  it("keeps page and nested ink visible through a translated camera rebase and back", async () => {
    await ready([stroke(100), stroke(450, 0)]);
    expect(alpha(100, 280)).toBeGreaterThan(0); // 180px overdraw margin
    for (const y of [-300, 0, -300]) {
      view = { ...view, scrollY: y };
      surface().style.transform = `translate3d(0px, ${y}px, 0)`;
      invalidateBoardScrollHostLayout(board);
      const committed = ref.current!.syncCamera();
      await frames(); await committed;
      expect(alpha(100, y === 0 ? 280 : 330)).toBeGreaterThan(0);
    }
    // A page gesture's bookkeeping may still be active when a fence scrolls.
    ref.current!.setCameraMoving(true);
    const pre = board.querySelector("pre")!; pre.scrollLeft = 40;
    pre.dispatchEvent(new Event("scroll"));
    await frames();
    expect(alpha(50, 330)).toBeGreaterThan(0);
    expect(alpha(130, 330)).toBe(0);
  });

  it("does not acknowledge an interrupted camera until the post-writing retry presents", async () => {
    await ready([stroke(100), stroke(900)], "pen");
    worker.blocked = true;
    view = { ...view, scrollY: -700 };
    surface().style.transform = "translate3d(0px, -700px, 0)";
    invalidateBoardScrollHostLayout(board);
    let settled = false;
    void Promise.resolve(ref.current!.syncCamera()).then(() => { settled = true; });
    await frames(2);
    const event = (type: string) => {
      const e = new MouseEvent(type, { button: 0, clientX: 200, clientY: 100, bubbles: true });
      Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: "pen" }, pressure: { value: .5 } });
      surface().dispatchEvent(e);
    };
    await act(async () => event("pointerdown"));
    await frames(2);
    expect(settled).toBe(false);
    expect(surface().style.transform).not.toBe("");
    await act(async () => event("pointerup"));
    worker.blocked = false; worker.release.splice(0).forEach(resolve => resolve());
    await frames(80);
    expect(settled).toBe(true);
    expect(alpha(100, 380)).toBeGreaterThan(0);
  });
});
