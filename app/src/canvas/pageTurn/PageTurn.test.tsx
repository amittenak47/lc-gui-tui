/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { BoardHandle } from "../BoardHandle";
import { markBootSettled } from "../../util/bootSettled";
import { glide, PageTurn, rollMs, turnPaperColor } from "./PageTurn";
import { flatSheet, paintTurn } from "./paintTurn";
import { touchPointersIn } from "../touchPointers";

// Gesture tests inspect the frame submitted to the renderer. Actual canvas
// shading is checked separately in the browser, not by jsdom's missing canvas.
vi.mock("./paintTurn", () => ({
  paintTurn: vi.fn(),
  flatSheet: vi.fn(() => [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 600 }, { x: 0, y: 600 }]),
}));

const gesture = vi.hoisted(() => ({ release: vi.fn(), protect: vi.fn() }));
vi.mock("../../util/gestureExclusion", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../util/gestureExclusion")>(),
  protectGestureSurface: gesture.protect,
}));

// Three 600-unit pages stacked; the view shows the middle one at scale 1.
const FRAMES = [
  { pageId: 1, minY: 0, maxY: 600 },
  { pageId: 2, minY: 620, maxY: 1220 },
  { pageId: 3, minY: 1240, maxY: 1840 },
];

let root: Root;
let host: HTMLDivElement;
let view = { x: 0, y: 620, width: 400, height: 600, zoom: 1 };
let pageBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
const board = {
  readingPageBox: vi.fn(() => pageBox),
  setPageFit: vi.fn(),
  setPageSpread: vi.fn(),
  getViewportBounds: vi.fn(() => view),
  readingPageFrames: vi.fn(() => FRAMES),
  setPageLock: vi.fn(),
  jumpToPageFrame: vi.fn((_frame: { pageId: number; minY: number; maxY: number }) => true),
  // Scene y maps straight to client y minus the view's top.
  sceneToClient: vi.fn((x: number, y: number) => ({ x, y: y - view.y })),
  captureSceneFrame: vi.fn(async () => document.createElement("canvas")),
  captureSceneMarks: vi.fn(async (): Promise<HTMLCanvasElement | null> => null),
  captureSceneQuick: vi.fn(async () => document.createElement("canvas")),
  livePageCopy: vi.fn((): HTMLElement | null => null),
  getInkRevision: vi.fn(() => 1),
  getActiveTool: vi.fn((): string => "hand"),
};

/** jsdom has no PointerEvent. */
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeEach(() => {
  markBootSettled();
  vi.mocked(paintTurn).mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  gesture.release.mockClear();
  gesture.protect.mockReset().mockReturnValue(gesture.release);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now() + 1000), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  view = { x: 0, y: 620, width: 400, height: 600, zoom: 1 };
  pageBox = null;
  for (const fn of Object.values(board)) fn.mockClear();
  board.getActiveTool.mockReturnValue("hand");
  // A test that fails part-way must not leave its board behind for the next.
  board.readingPageFrames.mockImplementation(() => FRAMES);
  board.jumpToPageFrame.mockImplementation(() => true);
  board.captureSceneFrame.mockImplementation(async () => document.createElement("canvas"));
  board.captureSceneQuick.mockImplementation(async () => document.createElement("canvas"));
  host = document.createElement("div");
  host.dataset.lcTab = "t1";
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} });
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  document.body.textContent = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("stops a pending page prefetch when focus leaves the pane", async () => {
  vi.useFakeTimers();
  let finish!: (canvas: HTMLCanvasElement) => void;
  board.captureSceneQuick.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const ref = { current: board as unknown as BoardHandle };
  const render = (enabled: boolean) => act(() => root.render(
    <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]'
      lockActive turnEnabled={enabled} spread={false} paged fit={null} />));
  render(true);
  await act(async () => vi.advanceTimersByTimeAsync(2200));
  expect(board.captureSceneQuick).toHaveBeenCalledTimes(1);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  // Several rechecks must join this job, not start another neighbour chain.
  await act(async () => vi.advanceTimersByTimeAsync(4500));
  render(false);
  await act(async () => { finish(document.createElement("canvas")); await Promise.resolve(); });
  expect(board.captureSceneQuick).toHaveBeenCalledTimes(1);
});

function mount(turnEnabled = true, fit: number | null = null, paged = true) {
  const ref = { current: board as unknown as BoardHandle };
  act(() =>
    root.render(
      <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled={turnEnabled} spread={paged} paged={paged} fit={fit} />,
    ),
  );
  // A PDF's pages, painted: a turn to an unpainted page holds back.
  if (paged && !host.querySelector("[data-pdf-page]")) {
    for (const f of FRAMES) {
      const slot = document.createElement("div");
      slot.dataset.pdfPage = String(f.pageId);
      slot.dataset.painted = "";
      const canvas = document.createElement("canvas");
      canvas.className = "lc-pdf-canvas";
      canvas.width = 100;
      canvas.height = 150;
      slot.append(canvas);
      host.append(slot);
    }
  }
  if (!host.querySelector(".lc-page-mask-hole")) {
    const mask = document.createElement("div"); mask.className = "lc-page-mask";
    const hole = document.createElement("div"); hole.className = "lc-page-mask-hole";
    hole.getBoundingClientRect = host.getBoundingClientRect;
    mask.append(hole); host.append(mask);
  }
}

function pointer(type: string, x: number, y: number, pointerType = "touch", timeStamp?: number) {
  const event = new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, pointerType, isPrimary: true, button: 0, bubbles: true, cancelable: true });
  if (timeStamp != null) Object.defineProperty(event, "timeStamp", { value: timeStamp });
  act(() => {
    host.dispatchEvent(event);
  });
}

/** Let a turn's pictures land: a few promise turns, not a frame. */
async function pictures() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

it("holds the camera on the page in view", () => {
  mount();
  expect(board.setPageLock).toHaveBeenLastCalledWith(FRAMES[1]);
});

it("turns to the next page when dragged past a third of the way, and lands on it", async () => {
  mount();
  const boardDown = vi.fn();
  host.addEventListener("pointerdown", boardDown);
  pointer("pointerdown", 380, 580);
  expect(boardDown).not.toHaveBeenCalled(); // the corner is the turn's, not the board's
  pointer("pointermove", 340, 585);
  pointer("pointermove", 240, 585);
  await settle();
  // The hand stops before it lets go: decided by where it is, not a throw.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  pointer("pointerup", 240, 585);
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[2], minY: FRAMES[2].minY });
  expect(board.setPageLock).toHaveBeenLastCalledWith(FRAMES[2]);
});

it("takes hold of the corner on touch, before the finger moves", async () => {
  const frame = manualFrames();
  mount();
  pointer("pointerdown", 380, 580);
  await act(async () => { await Promise.resolve(); });
  frame();
  const held = vi.mocked(paintTurn).mock.calls.at(-1)?.[1];
  expect(held).toBeDefined();
  expect(held!.corner.x).toBeLessThan(400);
  expect(held!.corner.x).toBeGreaterThan(360);
  pointer("pointerup", 380, 580);
  for (let i = 0; i < 4; i += 1) frame(1000);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
});

it("keeps a turn taken at the corner even when the drag starts out steep", async () => {
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 376, 540); // mostly upward at first
  pointer("pointermove", 200, 520);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  pointer("pointerup", 200, 520);
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[2], minY: FRAMES[2].minY });
});

it("turns on a flick whose moves a busy frame merged away", async () => {
  mount();
  pointer("pointerdown", 380, 580);
  await settle();
  pointer("pointerup", 200, 580); // no pointermove reached us: only the lift
  await settle();
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[2], minY: FRAMES[2].minY });
});

it("unravels back without moving when let go short of 35%", async () => {
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 340, 585);
  pointer("pointermove", 270, 585);
  await settle();
  // The hand stops before it lets go: no throw.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  pointer("pointerup", 270, 585);
  await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
});

it("leaves an up-and-down drag to the board", () => {
  mount();
  const cancelled = vi.fn();
  host.addEventListener("pointercancel", cancelled);
  pointer("pointerdown", 200, 300);
  pointer("pointermove", 205, 200);
  pointer("pointermove", 150, 190);
  expect(cancelled).not.toHaveBeenCalled();
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
});

it("never turns under the stylus with a pen up, nor with turning off", () => {
  board.getActiveTool.mockReturnValue("freedraw");
  mount();
  pointer("pointerdown", 380, 580, "pen");
  pointer("pointermove", 100, 585, "pen");
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  mount(false);
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 100, 585);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
});

it("has nothing to turn back to on the first page", () => {
  view = { ...view, y: 0 };
  mount();
  pointer("pointerdown", 20, 580);
  pointer("pointermove", 200, 585);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
});

it("turns with the arrow keys", async () => {
  mount();
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  });
  await settle();
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[0], minY: FRAMES[0].minY });
});

it("fits the page while pages are held, and gives the width back after", () => {
  mount(true, 0.9);
  expect(board.setPageFit).toHaveBeenLastCalledWith(0.9);
  mount(true, 1);
  expect(board.setPageFit).toHaveBeenLastCalledWith(1);
  act(() => root.render(<></>));
  expect(board.setPageFit).toHaveBeenLastCalledWith(null);
});

it("turns only the page, not the board around it", async () => {
  // A fitted page in the middle of a wider view.
  view = { x: -200, y: 600, width: 800, height: 640, zoom: 1 };
  pageBox = { minX: 0, maxX: 400, minY: 620, maxY: 1220 };
  mount(true, 1);
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 340, 585);
  await settle();
  const scene = (board.captureSceneQuick.mock.calls[0] as unknown[] | undefined)?.[0];
  expect(scene).toEqual({ x: 0, y: 620, width: 400, height: 600 });
  pointer("pointerup", 340, 585);
  await settle();
});

it("hides what lies past a text page's cut in the picture of it", async () => {
  // A text page cut at 1000 in a box a screenful high: below the cut is the
  // next page's text, which the view masks and the picture must too.
  const cutFrames = [
    { pageId: 1, minY: 0, maxY: 600 },
    { pageId: 2, minY: 620, maxY: 1000 },
    { pageId: 3, minY: 1000, maxY: 1600 },
  ];
  board.readingPageFrames.mockReturnValue(cutFrames);
  pageBox = { minX: 0, maxX: 400, minY: 620, maxY: 1220 };
  const fills: number[][] = [];
  board.captureSceneFrame.mockImplementation(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 600;
    (canvas as unknown as { getContext: () => unknown }).getContext = () => ({
      fillStyle: "",
      fillRect: (...rect: number[]) => fills.push(rect),
    });
    return canvas;
  });
  mount(true, 1, false);
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 340, 585);
  await settle();
  // This page: blank from its cut (380 of 600 down) to the bottom.
  expect(fills).toContainEqual([0, 380, 400, 220]);
  pointer("pointerup", 340, 585);
  await settle();
  board.readingPageFrames.mockReturnValue(FRAMES);
  board.captureSceneFrame.mockImplementation(async () => document.createElement("canvas"));
});

it("leaves a pinch alone: a second finger calls the turn off", async () => {
  mount();
  pointer("pointerdown", 380, 580);
  act(() => {
    host.dispatchEvent(new PointerEvent("pointerdown", { clientX: 200, clientY: 500, pointerId: 8, pointerType: "touch", isPrimary: false, button: 0, bubbles: true }));
  });
  pointer("pointermove", 300, 585);
  pointer("pointermove", 150, 585);
  pointer("pointerup", 150, 585);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(document.querySelector(".lc-page-turn")).toBeNull();
});

it("flicks through pages: a corner touched while one lands takes hold of the next", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 }; // on the first of three pages
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 150, 580);
  await pictures();
  frame();
  pointer("pointerup", 150, 580);
  // Back at the corner before the first sheet has finished going over.
  pointer("pointerdown", 380, 580);
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  pointer("pointermove", 150, 580);
  await pictures();
  frame();
  pointer("pointerup", 150, 580);
  await pictures();
  for (let i = 0; i < 4; i += 1) frame(1000);
  const landed = (board.jumpToPageFrame.mock.calls as unknown as [{ pageId: number }][]).map((call) => call[0].pageId);
  expect(landed).toEqual([2, 3]);
});

it("keeps each departing page's pictures and animation alive under rapid turns", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 };
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 150, 580);
  await pictures();
  frame();
  const first = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  pointer("pointerup", 150, 580);
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 150, 580);
  await pictures();
  frame(20);
  expect(host.querySelectorAll(".lc-page-turn")).toHaveLength(2);
  const older = vi.mocked(paintTurn).mock.calls.filter(([, f]) => f.from === first.from).at(-1)![1];
  expect(older.to).toBe(first.to);
  expect(older.sheetOnly).toBe(true);
  expect(older.corner.x).toBeLessThan(first.corner.x);
  const newer = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  expect(newer.from).toBe(first.to);
  expect(newer.to).not.toBe(first.to);
  expect(newer.sheetOnly).toBe(false);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  pointer("pointerup", 150, 580);
  for (let i = 0; i < 4; i++) frame(1000);
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => (f as { pageId: number }).pageId)).toEqual([2, 3]);
  expect(board.setPageLock).toHaveBeenLastCalledWith(FRAMES[2]);
  expect(host.querySelectorAll(".lc-page-turn")).toHaveLength(0);
});

it("retains a released turn and the following swipe until its PDF preview paints", async () => {
  vi.useFakeTimers();
  const frame = manualFrames();
  view = { ...view, y: 0 };
  mount();
  const destination = host.querySelector<HTMLElement>('[data-pdf-page="2"]')!;
  delete destination.dataset.painted;
  pointer("pointerdown", 380, 580, "touch", 1000);
  pointer("pointermove", 150, 580, "touch", 1050);
  pointer("pointerup", 150, 580, "touch", 1060);
  pointer("pointerdown", 380, 580, "touch", 1100);
  pointer("pointermove", 150, 580, "touch", 1150);
  pointer("pointerup", 150, 580, "touch", 1160);
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  await act(async () => { destination.dataset.painted = ""; await Promise.resolve(); });
  for (let i = 0; i < 8; i++) {
    frame(1000);
    await act(async () => vi.advanceTimersByTimeAsync(1));
  }
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => (f as { pageId: number }).pageId)).toEqual([2, 3]);
});

it("keeps an entire swipe burst while its first preview is pending", async () => {
  vi.useFakeTimers();
  const frame = manualFrames();
  view = { ...view, y: 0 };
  const frames = [...FRAMES, { pageId: 4, minY: 1860, maxY: 2460 }, { pageId: 5, minY: 2480, maxY: 3080 }];
  board.readingPageFrames.mockReturnValue(frames);
  mount();
  const template = host.querySelector<HTMLElement>('[data-pdf-page="3"]')!;
  for (const pageId of [4, 5]) {
    const slot = template.cloneNode(true) as HTMLElement;
    slot.dataset.pdfPage = String(pageId);
    host.append(slot);
  }
  const destination = host.querySelector<HTMLElement>('[data-pdf-page="2"]')!;
  delete destination.dataset.painted;
  for (let i = 0; i < 4; i++) {
    pointer("pointerdown", 380, 580, "touch", 1000 + i * 100);
    pointer("pointermove", 150, 580, "touch", 1050 + i * 100);
    pointer("pointerup", 150, 580, "touch", 1060 + i * 100);
  }
  await act(async () => { destination.dataset.painted = ""; await vi.advanceTimersByTimeAsync(1); });
  for (let i = 0; i < 20; i++) {
    frame(1000);
    await act(async () => vi.advanceTimersByTimeAsync(1));
  }
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => f.pageId)).toEqual([2, 3, 4, 5]);
});

it("continues backward sheets underneath the next returning sheet", async () => {
  const frame = manualFrames();
  view = { ...view, y: 1240 };
  mount();
  pointer("pointerdown", 20, 580, "touch", 1000);
  pointer("pointermove", 250, 580, "touch", 1100);
  await pictures();
  frame();
  const first = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  const olderCanvas = host.querySelector(".lc-page-turn")!;
  pointer("pointerup", 250, 580, "touch", 1110);
  pointer("pointerdown", 20, 580, "touch", 1200);
  pointer("pointermove", 250, 580, "touch", 1300);
  await pictures();
  frame(20);
  const newer = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  expect(host.querySelectorAll(".lc-page-turn")[0]).toBe(olderCanvas);
  expect(newer.to).toBe(first.from);
  expect(newer.sheetOnly).toBe(true);
  expect(vi.mocked(paintTurn).mock.calls.some(([, f]) => f.from === first.from && f.corner.x > first.corner.x)).toBe(true);
  pointer("pointerup", 250, 580, "touch", 1310);
  for (let i = 0; i < 6; i++) frame(1000);
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => f.pageId)).toEqual([2, 1]);
});

it("turns the next sheet for a caught body flick whose move events were merged", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 };
  mount();
  pointer("pointerdown", 380, 580, "touch", 1000);
  pointer("pointermove", 150, 580, "touch", 1080);
  await pictures();
  frame();
  pointer("pointerup", 150, 580, "touch", 1090);
  pointer("pointerdown", 300, 400, "touch", 1150);
  pointer("pointerup", 100, 400, "touch", 1230);
  await pictures();
  for (let i = 0; i < 6; i++) frame(1000);
  expect(board.jumpToPageFrame.mock.calls.map(([f]) => f.pageId)).toEqual([2, 3]);
});

it("cancels a pending preview when the page-turn surface leaves", async () => {
  mount();
  const destination = host.querySelector<HTMLElement>('[data-pdf-page="3"]')!;
  delete destination.dataset.painted;
  pointer("pointerdown", 380, 580);
  pointer("pointerup", 150, 580);
  mount(false);
  const captures = board.captureSceneQuick.mock.calls.length;
  await act(async () => { destination.dataset.painted = ""; await Promise.resolve(); });
  await pictures();
  expect(board.captureSceneQuick).toHaveBeenCalledTimes(captures);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(host.querySelector(".lc-page-turn")).toBeNull();
});

it("recognizes a body flick even when input only delivered its down and up", async () => {
  mount();
  pointer("pointerdown", 240, 300, "touch", 1000);
  pointer("pointerup", 120, 302, "touch", 1080);
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith(expect.objectContaining({ pageId: 3 }));
});

it("preserves a consumed first touch for pinch recognition and returns the held sheet", async () => {
  const frame = manualFrames();
  mount();
  const pairs: ReturnType<typeof touchPointersIn>[] = [];
  host.addEventListener("pointerdown", () => pairs.push(touchPointersIn(host)));
  pointer("pointerdown", 380, 580);
  expect(pairs).toHaveLength(0);
  await pictures();
  act(() => host.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 8, pointerType: "touch", isPrimary: false, button: 0,
    clientX: 100, clientY: 300, bubbles: true,
  })));
  expect(pairs[0]?.size).toBe(2);
  expect(pairs[0]?.get(7)).toEqual({ x: 380, y: 580 });
  expect(host.querySelector(".lc-page-turn")).toBeNull();
  pointer("pointermove", 100, 580);
  for (let i = 0; i < 4; i++) frame(1000);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("blur")));
});

it("retains the body-flick finger after cancelling one-finger handlers, ready for pinch", async () => {
  mount();
  pointer("pointerdown", 240, 300, "touch", 1000);
  pointer("pointermove", 180, 300, "touch", 1040);
  expect(touchPointersIn(host).get(7)).toEqual({ x: 180, y: 300 });
  act(() => host.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 8, pointerType: "touch", isPrimary: false, button: 0,
    clientX: 100, clientY: 300, bubbles: true,
  })));
  expect(touchPointersIn(host).size).toBe(2);
  await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("blur")));
});

it("flicks through pages: a sheet caught going over and pushed on lands, and the next one turns", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 }; // on the first of three pages
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 150, 580);
  await pictures();
  frame();
  pointer("pointerup", 150, 580);
  // The thumb comes back inside the page, onto the rolling sheet, not the strip.
  pointer("pointerdown", 300, 400);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  pointer("pointermove", 280, 400);
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  pointer("pointermove", 60, 400);
  await pictures();
  frame();
  // The new sheet starts from rest and moves with the hand: no jump to the finger.
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].corner.x).toBeCloseTo(400 - 220, 5);
  pointer("pointerup", 60, 400);
  await pictures();
  for (let i = 0; i < 4; i += 1) frame(1000);
  const landed = (board.jumpToPageFrame.mock.calls as unknown as [{ pageId: number }][]).map((call) => call[0].pageId);
  expect(landed).toEqual([2, 3]);
});

it("rolls a flicked sheet over quickly, and a let-go one at an easy pace", () => {
  expect(rollMs(560, 0)).toBe(400); // 1.4 px/ms, as before
  expect(rollMs(100, 0)).toBe(240); // still seen going over
  expect(rollMs(2000, 0)).toBe(520);
  // A flick keeps its pace: far quicker than a sheet let go from a stop.
  expect(rollMs(880, 3.6)).toBeCloseTo(880 / (3.6 * 1.2), 5);
  expect(rollMs(100, 6)).toBe(120);
  for (let speed = 0; speed < 8; speed += 0.25) {
    // Faster hands never roll slower.
    expect(rollMs(600, speed + 0.25)).toBeLessThanOrEqual(rollMs(600, speed));
  }
});

it("turns on a quick flick short of halfway, and still plays the turn", async () => {
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 340, 585);
  await settle(); // the pictures are in
  pointer("pointermove", 300, 585);
  pointer("pointerup", 300, 585);
  await settle();
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[2], minY: FRAMES[2].minY });
});

it("lines up another turn when a key is pressed during one", async () => {
  // The board lands where it is told, as the real one does.
  board.jumpToPageFrame.mockImplementation(((frame: { minY: number }) => {
    view = { ...view, y: frame.minY };
    return true;
  }) as never);
  const key = () =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
  view = { ...view, y: 1240 }; // on the last page, two to go back
  mount();
  key();
  await settle();
  key();
  for (let i = 0; i < 12; i += 1) await settle();
  const landed = (board.jumpToPageFrame.mock.calls as unknown as [{ pageId: number }][]).map((call) => call[0].pageId);
  board.jumpToPageFrame.mockImplementation(() => true);
  expect(landed.slice(0, 2)).toEqual([2, 1]);
});

it("shows text pages two to a spread, and turns them two at a time", async () => {
  // Four text pages; the spread (1, 2) is open, drawn in the mask's hole.
  const textFrames = [
    { pageId: 1, minY: 0, maxY: 600 },
    { pageId: 2, minY: 600, maxY: 1200 },
    { pageId: 3, minY: 1200, maxY: 1800 },
    { pageId: 4, minY: 1800, maxY: 2400 },
  ];
  board.readingPageFrames.mockReturnValue(textFrames);
  view = { x: 0, y: 0, width: 400, height: 600, zoom: 1 };
  pageBox = { minX: 0, maxX: 200, minY: 0, maxY: 600 };
  const hole = document.createElement("div");
  hole.className = "lc-page-mask-hole";
  hole.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} });
  const mask = document.createElement("div");
  mask.className = "lc-page-mask";
  mask.append(hole);
  const ref = { current: board as unknown as BoardHandle };
  act(() =>
    root.render(
      <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled spread paged={false} fit={1} />,
    ),
  );
  // After the first render: React empties its container when it mounts.
  host.append(mask);
  expect(board.setPageSpread).toHaveBeenLastCalledWith(true);
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 6; i += 1) await settle();
  // Past the facing page: the next spread opens on page 3.
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...textFrames[2], minY: textFrames[2].minY });
  board.readingPageFrames.mockReturnValue(FRAMES);
});

it("keeps the canvas frame protected when annotation takes over in Pages mode", () => {
  mount(true);
  expect(gesture.protect).toHaveBeenCalledWith(host, expect.any(Function));
  mount(false);
  expect(gesture.release).not.toHaveBeenCalled();
  expect(gesture.protect).toHaveBeenCalledTimes(1);
  expect(gesture.protect.mock.calls[0][1]()).toHaveLength(4);
  expect(host.hasAttribute("data-reading-pages")).toBe(true);
});


it("keeps PDF backs light in dark palettes, preserving text and light palettes", () => {
  expect(turnPaperColor("#101820", true)).toBe("#ffffff");
  expect(turnPaperColor("rgb(32, 36, 40)", true)).toBe("#ffffff");
  expect(turnPaperColor("#f5f0e8", true)).toBe("#f5f0e8");
  expect(turnPaperColor("#101820", false)).toBe("#101820");
});

it("turns from the middle of either side strip", async () => {
  mount();
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 160, 300);
  pointer("pointerup", 160, 300);
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalled();
});

it("holds a sheet taken by its side where the finger took it, and a corner by its corner", async () => {
  mount();
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 300, 300);
  await settle();
  const side = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  expect(side.restY).toBe(300);
  expect(side.corner.y).toBeCloseTo(300, 5);
  pointer("pointerup", 380, 300);
  await settle();
  vi.mocked(paintTurn).mockClear();
  pointer("pointerdown", 392, 592);
  pointer("pointermove", 300, 592);
  await settle();
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].restY).toBe(600);
  pointer("pointerup", 392, 592);
  await settle();
});

it("keeps a sheet held by its side from tilting with every wobble of the hand", async () => {
  mount();
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 200, 360);
  await settle();
  const frame = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  // 60 px of drift moves the held point 12: the fold stays near upright.
  expect(frame.corner.y).toBeCloseTo(312, 5);
  pointer("pointerup", 200, 360);
  await settle();
});

it("turns over plain paper while the next page is still being pictured, then shows it", async () => {
  let finish!: (canvas: HTMLCanvasElement) => void;
  const late = document.createElement("canvas");
  board.captureSceneFrame
    .mockImplementationOnce(async () => document.createElement("canvas"))
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  mount(true, null, false);
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 300, 300);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  const first = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  expect(first.to).not.toBe(late);
  await act(async () => { finish(late); await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].to).toBe(late);
  pointer("pointerup", 380, 300);
  await settle();
});

it("turns at once with the live page showing through while its picture is still being taken", async () => {
  let finish!: (canvas: HTMLCanvasElement) => void;
  const here = document.createElement("canvas");
  board.captureSceneFrame
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockImplementationOnce(async () => document.createElement("canvas"));
  mount(true, null, false);
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 300, 300);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  const first = vi.mocked(paintTurn).mock.calls.at(-1)![1];
  expect(first.from).toBeNull();
  expect(first.to).toBeInstanceOf(HTMLCanvasElement);
  await act(async () => { finish(here); await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].from).toBe(here);
  pointer("pointerup", 380, 300);
  await settle();
});

it("turns a text page over its live copy while the next page has no picture", async () => {
  const copy = document.createElement("div");
  const marks = document.createElement("canvas");
  board.livePageCopy.mockReturnValueOnce(copy);
  board.captureSceneMarks.mockResolvedValueOnce(marks);
  board.captureSceneFrame
    .mockImplementationOnce(async () => document.createElement("canvas"))
    .mockImplementationOnce(() => new Promise(() => {}));
  mount(true, null, false);
  pointer("pointerdown", 380, 300);
  pointer("pointermove", 300, 300);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  const under = host.querySelector<HTMLElement>(".lc-page-turn-under");
  expect(under?.contains(copy)).toBe(true);
  expect(under?.contains(marks)).toBe(true);
  // Nothing painted where the next page shows: the live copy is that page.
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].to).toBeNull();
  expect(vi.mocked(flatSheet)).toHaveBeenCalled();
  pointer("pointerup", 300, 300);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(document.querySelector(".lc-page-turn")).toBeNull();
  expect(host.querySelector(".lc-page-turn-under")).toBeNull();
});

it("holds a PDF on its page when the next one has nothing painted yet", async () => {
  mount();
  host.querySelector<HTMLElement>('[data-pdf-page="3"]')!.removeAttribute("data-painted");
  pointer("pointerdown", 390, 300, "touch", 1000);
  pointer("pointermove", 300, 300, "touch", 1030);
  pointer("pointermove", 150, 300, "touch", 1060);
  pointer("pointerup", 150, 300, "touch", 1070);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
});

it("leaves the page body to a slow drag and to a swipe up or down", async () => {
  mount();
  // Sideways, but slowly: a selection or a pan.
  pointer("pointerdown", 300, 300, "touch", 1000);
  pointer("pointermove", 140, 305, "touch", 1600);
  pointer("pointerup", 140, 305, "touch", 1650);
  // Quick, but mostly up the page.
  pointer("pointerdown", 200, 400, "touch", 3000);
  pointer("pointermove", 170, 300, "touch", 3060);
  pointer("pointerup", 170, 300, "touch", 3080);
  await settle();
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
});

it("turns the page for a quick sideways flick from anywhere on it", async () => {
  mount();
  pointer("pointerdown", 220, 300, "touch", 1000);
  pointer("pointermove", 180, 302, "touch", 1030);
  pointer("pointermove", 120, 304, "touch", 1060);
  pointer("pointerup", 120, 304, "touch", 1070);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith(expect.objectContaining({ pageId: 3 }));
});

it("turns back for a quick flick to the right from the middle of the page", async () => {
  mount();
  pointer("pointerdown", 160, 300, "touch", 1000);
  pointer("pointermove", 200, 302, "touch", 1030);
  pointer("pointermove", 260, 304, "touch", 1060);
  pointer("pointerup", 260, 304, "touch", 1070);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith(expect.objectContaining({ pageId: 1 }));
});

it("goes over for a short quick flick at the edge, and back for the same distance slowly", async () => {
  mount();
  pointer("pointerdown", 390, 300, "touch", 1000);
  pointer("pointermove", 370, 300, "touch", 1020);
  pointer("pointermove", 350, 300, "touch", 1040);
  pointer("pointerup", 350, 300, "touch", 1045);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  board.jumpToPageFrame.mockClear();
  pointer("pointerdown", 390, 300, "touch", 5000);
  pointer("pointermove", 370, 300, "touch", 5200);
  pointer("pointermove", 350, 300, "touch", 5400);
  pointer("pointerup", 350, 300, "touch", 5600);
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
});

it("turns with a stylus while no pen is up, and leaves it to write with one", async () => {
  mount();
  board.getActiveTool.mockReturnValue("freedraw");
  pointer("pointerdown", 390, 300, "pen");
  pointer("pointermove", 100, 300, "pen");
  pointer("pointerup", 100, 300, "pen");
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  board.getActiveTool.mockReturnValue("hand");
  pointer("pointerdown", 390, 300, "pen");
  pointer("pointermove", 100, 300, "pen");
  pointer("pointerup", 100, 300, "pen");
  for (let i = 0; i < 4; i += 1) await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
});

function manualFrames() {
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    callbacks.set(++id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => callbacks.delete(key));
  return (ahead = 0) => act(() => {
    const batch = [...callbacks.values()];
    callbacks.clear();
    for (const cb of batch) cb(performance.now() + ahead);
  });
}

it.each(["next", "prev"] as const)("catches a settling %s turn without a jump, then pulls it back", async (direction) => {
  const frame = manualFrames();
  mount();
  const start = direction === "next" ? 380 : 20;
  const dragged = direction === "next" ? 150 : 250;
  pointer("pointerdown", start, 580);
  pointer("pointermove", dragged, 580);
  await act(async () => { await Promise.resolve(); });
  frame();
  const before = { ...vi.mocked(paintTurn).mock.calls.at(-1)![1].corner };
  const captures = board.captureSceneFrame.mock.calls.length;
  pointer("pointerup", dragged, 580);
  pointer("pointerdown", 200, 300);
  // The previous animation callback must not land while the sheet is held.
  frame(1000);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  pointer("pointermove", 200, 300);
  frame();
  expect(vi.mocked(paintTurn).mock.calls.at(-1)![1].corner).toEqual(before);
  const back = direction === "next" ? 380 : 20;
  pointer("pointermove", back, 300);
  pointer("pointerup", back, 300);
  frame(1000);
  frame(1000);
  frame(1000);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(board.captureSceneFrame).toHaveBeenCalledTimes(captures);
  expect(document.querySelector(".lc-page-turn")).toBeNull();
});

it("reverses the settling direction with the opposite arrow and can finish again", async () => {
  const frame = manualFrames();
  mount();
  const key = (key: string) => act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  key("ArrowRight");
  await act(async () => { await Promise.resolve(); });
  frame(60);
  key("ArrowLeft");
  // Both callbacks are pending: only the latest animation may land.
  frame(20);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  key("ArrowRight");
  frame(1000);
  frame(1000);
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  expect(board.setPageLock).toHaveBeenLastCalledWith(FRAMES[2]);
});

it("keeps toolbar clicks and pen input available while a sheet settles", async () => {
  const frame = manualFrames();
  board.getActiveTool.mockReturnValue("freedraw");
  mount();
  pointer("pointerdown", 380, 580);
  pointer("pointermove", 150, 580);
  await act(async () => { await Promise.resolve(); });
  pointer("pointerup", 150, 580);
  const button = document.createElement("button");
  const click = vi.fn();
  button.addEventListener("click", click);
  host.append(button);
  button.click();
  expect(click).toHaveBeenCalledOnce();
  pointer("pointerdown", 200, 300, "pen");
  frame(1000);
  expect(board.jumpToPageFrame).toHaveBeenCalledOnce();
});

it("cancels the newest caught sheet while the earlier turn finishes", async () => {
  const frame = manualFrames();
  view = { ...view, y: 0 };
  mount();
  const key = () => act(() => window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
  ));
  key();
  await act(async () => { await Promise.resolve(); });
  frame(60);
  key(); // the first sheet continues while the next becomes catchable
  await pictures();
  pointer("pointerdown", 200, 300);
  pointer("pointercancel", 200, 300);
  for (let i = 0; i < 5; i++) frame(1000);
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  expect(board.jumpToPageFrame).toHaveBeenLastCalledWith(FRAMES[1]);
  expect(document.querySelector(".lc-page-turn")).toBeNull();
});

it("rolls a released sheet smoothly from the hand's pace to rest", () => {
  for (const launch of [0, 1, 2.5]) {
    expect(glide(0, launch)).toBe(0);
    expect(glide(1, launch)).toBeCloseTo(1, 10);
    let last = 0;
    for (let t = 0.05; t <= 1; t += 0.05) {
      const k = glide(t, launch);
      expect(k).toBeGreaterThanOrEqual(last - 1e-9); // never runs backwards
      expect(k).toBeLessThanOrEqual(1 + 1e-9); // never overshoots
      last = k;
    }
    // Leaves at the given multiple of its average pace, and arrives at rest.
    expect(glide(0.001, launch) / 0.001).toBeCloseTo(launch, 1);
    expect((1 - glide(0.999, launch)) / 0.001).toBeLessThan(0.05);
  }
});
