/** @vitest-environment jsdom */
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  board.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("annotation camera presentation", () => {
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
