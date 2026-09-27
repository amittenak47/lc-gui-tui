/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { BoardHandle } from "../BoardHandle";
import { PageTurn } from "./PageTurn";

// Three 600-unit pages stacked; the view shows the middle one at scale 1.
const FRAMES = [
  { pageId: 1, minY: 0, maxY: 600 },
  { pageId: 2, minY: 620, maxY: 1220 },
  { pageId: 3, minY: 1240, maxY: 1840 },
];

let root: Root;
let host: HTMLDivElement;
let view = { x: 0, y: 620, width: 400, height: 600, zoom: 1 };
const board = {
  getViewportBounds: vi.fn(() => view),
  readingPageFrames: vi.fn(() => FRAMES),
  setPageLock: vi.fn(),
  jumpToPageFrame: vi.fn(() => true),
  // Scene y maps straight to client y minus the view's top.
  sceneToClient: vi.fn((x: number, y: number) => ({ x, y: y - view.y })),
  captureSceneFrame: vi.fn(async () => document.createElement("canvas")),
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now() + 1000), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  view = { x: 0, y: 620, width: 400, height: 600, zoom: 1 };
  for (const fn of Object.values(board)) fn.mockClear();
  host = document.createElement("div");
  host.dataset.lcTab = "t1";
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} });
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

function mount(turnEnabled = true) {
  const ref = { current: board as unknown as BoardHandle };
  act(() =>
    root.render(
      <PageTurn boardRef={ref} filmScope="t1" hostSelector='[data-lc-tab="t1"]' lockActive turnEnabled={turnEnabled} spread />,
    ),
  );
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

it("turns to the next page when dragged past halfway, and lands on it", async () => {
  mount();
  const cancelled = vi.fn();
  host.addEventListener("pointercancel", cancelled);
  pointer("pointerdown", 380, 500);
  pointer("pointermove", 340, 505);
  expect(cancelled).toHaveBeenCalledTimes(1); // the board's pan was handed over
  pointer("pointermove", 150, 505);
  await settle();
  pointer("pointerup", 150, 505);
  await settle();
  expect(board.jumpToPageFrame).toHaveBeenCalledWith({ ...FRAMES[2], minY: FRAMES[2].minY });
  expect(board.setPageLock).toHaveBeenLastCalledWith(FRAMES[2]);
});

it("settles back without moving when let go short of halfway", async () => {
  mount();
  pointer("pointerdown", 380, 500);
  pointer("pointermove", 340, 505);
  pointer("pointermove", 300, 505);
  await settle();
  pointer("pointerup", 300, 505);
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
  pointer("pointerdown", 380, 500, "pen");
  pointer("pointermove", 100, 505, "pen");
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
  mount(false);
  pointer("pointerdown", 380, 500);
  pointer("pointermove", 100, 505);
  expect(board.captureSceneFrame).not.toHaveBeenCalled();
});

it("has nothing to turn back to on the first page", () => {
  view = { ...view, y: 0 };
  mount();
  pointer("pointerdown", 20, 500);
  pointer("pointermove", 200, 505);
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
