/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { NodeRef } from "../util/noteLinks";
import { ExploreWorkspace } from "./ExploreWorkspace";

vi.mock("../shellContext", () => ({ useShell: () => ({ headerSlots: { boardChrome: null } }) }));
vi.mock("../util/noteLinks", async (importOriginal) => ({
  ...await importOriginal<typeof import("../util/noteLinks")>(),
  listEdges: vi.fn(async () => []),
}));

const NODES: NodeRef[] = [
  { type: "annotate", id: "a", title: "Alpha" },
  { type: "whiteboard", id: "b", title: "Beta" },
];

let root: Root;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let id = 0;
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

function render(showing: boolean) {
  act(() => root.render(
    <ExploreWorkspace nodes={NODES} themeId="paper" onThemePick={() => {}} onOpen={() => {}}
      onOpenInNewTab={() => {}} canOpenInNewTab={() => true} active={showing} showing={showing} />,
  ));
}

/** Run every pending frame once; the loop asks for its next one as it goes. */
function frame(at: number) {
  const batch = [...frames.values()];
  frames.clear();
  act(() => { for (const cb of batch) cb(at); });
}

it("runs no drift loop while parked behind another tab, and picks it up on return", async () => {
  render(false);
  await act(async () => {}); // the edges arrive
  expect(frames.size).toBe(0);
  render(true);
  expect(frames.size).toBe(1);
  frame(performance.now() + 16);
  expect(frames.size).toBe(1);
  render(false);
  expect(frames.size).toBe(0);
  render(true);
  expect(frames.size).toBe(1);
});

/** jsdom has no PointerEvent; the loop only reads `pointerId`. */
function pointer(type: string, pointerId: number) {
  const event = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

it("slows to an idle rate once only drifting, and a press brings it back at once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    render(true);
    await act(async () => {});
    let at = performance.now();
    let ticks = 0;
    while (frames.size > 0 && ticks < 600) {
      frame((at += 16));
      ticks += 1;
    }
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(40));
    expect(frames.size).toBe(1);
    frame((at += 50));
    expect(frames.size).toBe(0);

    const stage = host.querySelector(".lc-explore-stage")!;
    act(() => { stage.dispatchEvent(pointer("pointerdown", 3)); });
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 120; i++) frame((at += 16));
    expect(frames.size).toBe(1);

    act(() => { window.dispatchEvent(pointer("pointerup", 3)); });
    for (let i = 0; i < 120; i++) frame((at += 16));
    expect(frames.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
