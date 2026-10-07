/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExploreWorkspace } from "./ExploreWorkspace";
import { saveInkMatchDisplay } from "../util/inkDisplayHzPref";
import type { NodeRef } from "../util/noteLinks";

const nodes: NodeRef[] = [
  { type: "annotate", id: "a", title: "Alpha" }, { type: "whiteboard", id: "b", title: "Beta" },
];

vi.mock("../shellContext", () => ({ useShell: () => ({ headerSlots: { boardChrome: null } }) }));
vi.mock("../util/noteLinks", async original => ({
  ...await original<typeof import("../util/noteLinks")>(), listEdges: vi.fn(async () => []),
}));
let root: Root, host: HTMLDivElement, frames: Map<number, FrameRequestCallback>, now: number;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  frames = new Map(); let id = 0; now = performance.now();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(showing = true) {
  await act(async () => root.render(<ExploreWorkspace nodes={nodes}
    themeId="paper" onThemePick={() => {}} onOpen={() => {}} onOpenInNewTab={() => {}}
    canOpenInNewTab={() => true} active={showing} showing={showing} />));
}
function tick() {
  const batch = [...frames.values()]; frames.clear(); now += 1000 / 90;
  act(() => batch.forEach(callback => callback(now)));
}
it("keeps quiet motion on every display frame when Match display is enabled", async () => {
  saveInkMatchDisplay(true); await render();
  for (let i = 0; i < 600; i++) { expect(frames.size).toBe(1); tick(); }
  expect(frames.size).toBe(1);
  await render(false); expect(frames.size).toBe(0);
});
it("wakes immediately when Match display is enabled and restores idle saving when disabled", async () => {
  await render();
  for (let i = 0; frames.size && i < 600; i++) tick();
  expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(1);
  act(() => saveInkMatchDisplay(true));
  expect(frames.size).toBe(1);
  for (let i = 0; i < 120; i++) tick();
  expect(frames.size).toBe(1);
  act(() => saveInkMatchDisplay(false));
  for (let i = 0; frames.size && i < 600; i++) tick();
  expect(frames.size).toBe(0);
  act(() => vi.advanceTimersByTime(40));
  expect(frames.size).toBe(1);
});
