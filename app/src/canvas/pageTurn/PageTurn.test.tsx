/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { BoardHandle } from "../BoardHandle";
import { PageTurn } from "./PageTurn";
import { paintTurn } from "./paintTurn";

// Gesture tests inspect the frame submitted to the renderer. Actual canvas
// shading is checked separately in the browser, not by jsdom's missing canvas.
vi.mock("./paintTurn", () => ({ paintTurn: vi.fn() }));

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
  jumpToPageFrame: vi.fn(() => true),
  // Scene y maps straight to client y minus the view's top.
  sceneToClient: vi.fn((x: number, y: number) => ({ x, y: y - view.y })),
  captureSceneFrame: vi.fn(async () => document.createElement("canvas")),
  getInkRevision: vi.fn(() => 1),
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
  // A test that fails part-way must not leave its board behind for the next.
  board.readingPageFrames.mockImplementation(() => FRAMES);
  board.jumpToPageFrame.mockImplementation(() => true);
  board.captureSceneFrame.mockImplementation(async () => document.createElement("canvas"));
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
  board.captureSceneFrame.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const ref = { current: board as unknown as BoardHandle };
  const render = (enabled: boolean) => act(() => root.render(
    <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]'
      lockActive turnEnabled={enabled} spread={false} paged fit={null} />));
  render(true);
  await act(async () => vi.advanceTimersByTimeAsync(2200));
  expect(board.captureSceneFrame).toHaveBeenCalledTimes(1);
  // Several rechecks must join this job, not start another neighbour chain.
  await act(async () => vi.advanceTimersByTimeAsync(4500));
  render(false);
  await act(async () => { finish(document.createElement("canvas")); await Promise.resolve(); });
  expect(board.captureSceneFrame).toHaveBeenCalledTimes(1);
});

function mount(turnEnabled = true, fit: number | null = null, paged = true) {
  const ref = { current: board as unknown as BoardHandle };
  act(() =>
    root.render(
      <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled={turnEnabled} spread={paged} paged={paged} fit={fit} />,
    ),
  );
  if (!host.querySelector(".lc-page-mask-hole")) {
    const mask = document.createElement("div"); mask.className = "lc-page-mask";
    const hole = document.createElement("div"); hole.className = "lc-page-mask-hole";
    hole.getBoundingClientRect = host.getBoundingClientRect;
    mask.append(hole); host.append(mask);
  }
}

function pointer(type: string, x: number, y: number, pointerType = "touch") {
  const event = new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, pointerType, isPrimary: true, button: 0, bubbles: true, cancelable: true });
  act(() => {
    host.dispatchEvent(event);
  });
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

it("never turns under the stylus, and not with the pen out", () => {
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
  const scene = (board.captureSceneFrame.mock.calls[0] as unknown[] | undefined)?.[0];
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
  await act(async () => { await Promise.resolve(); });
  frame();
  pointer("pointerup", 150, 580);
  // Back at the corner before the first sheet has finished going over.
  pointer("pointerdown", 380, 580);
  expect(board.jumpToPageFrame).toHaveBeenCalledTimes(1);
  pointer("pointermove", 150, 580);
  await act(async () => { await Promise.resolve(); });
  frame();
  pointer("pointerup", 150, 580);
  for (let i = 0; i < 4; i += 1) frame(1000);
  const landed = (board.jumpToPageFrame.mock.calls as unknown as [{ pageId: number }][]).map((call) => call[0].pageId);
  expect(landed).toEqual([2, 3]);
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


it("leaves the page body and middle of each edge available to scroll", async () => {
  mount();
  for (const x of [20, 200, 380]) {
    pointer("pointerdown", x, 300);
    pointer("pointermove", x - 160, 305);
    pointer("pointerup", x - 160, 305);
  }
  await settle();
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
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

it("drops queued turns when a caught sheet is cancelled", async () => {
  const frame = manualFrames();
  mount();
  const key = () => act(() => window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
  ));
  key();
  await act(async () => { await Promise.resolve(); });
  frame(60);
  key(); // another turn waiting behind the one being caught
  pointer("pointerdown", 200, 300);
  pointer("pointercancel", 200, 300);
  for (let i = 0; i < 5; i++) frame(1000);
  expect(board.jumpToPageFrame).not.toHaveBeenCalled();
  expect(document.querySelector(".lc-page-turn")).toBeNull();
});
