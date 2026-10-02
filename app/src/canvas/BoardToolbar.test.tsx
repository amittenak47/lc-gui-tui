/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AnimatePresence } from "motion/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoardToolbar, type BoardToolbarProps } from "./BoardToolbar";

vi.mock("motion/react", async importOriginal => ({
  ...await importOriginal<typeof import("motion/react")>(), useReducedMotion: () => false,
}));
const noop = () => {};
const props: BoardToolbarProps = {
  markdown: true, active: "freedraw", onPick: noop, themeId: "paper", inkColor: "#222", onInk: noop,
  handedness: "right", strokeWidth: 2, onStrokeWidth: noop, inkFullness: 1, onInkFullness: noop,
  pressureSensitive: true, onPressureSensitive: noop, textMode: "plain", onTextMode: noop,
  shapesOpen: false, onToggleShapes: noop, onStamp: noop, onPickImage: noop, captureMenuOpen: false,
  onToggleCaptureMenu: noop, onCaptureEntire: noop, onCaptureRegion: noop, onReset: noop, onUndo: noop, onRedo: noop,
};
let host: HTMLDivElement;
let root: Root;
let reduced: boolean;
type StubAnimation = { playState: string; onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn>; finish: () => void };
let animations: StubAnimation[];
const originalAnimate = Element.prototype.animate;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  reduced = false;
  animations = [];
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: noop });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addListener: noop, removeListener: noop }));
  Object.defineProperty(Element.prototype, "animate", { configurable: true, writable: true, value: vi.fn(() => {
    const animation: StubAnimation = { playState: "running", onfinish: null, cancel: vi.fn(), finish() { this.playState = "finished"; this.onfinish?.(); } };
    animations.push(animation);
    return animation;
  }) });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
  if (originalAnimate) Element.prototype.animate = originalAnimate;
  else Reflect.deleteProperty(Element.prototype, "animate");
});
const render = async (open: boolean) => { await act(async () => root.render(<AnimatePresence>{open && <div key="tools"><BoardToolbar {...props} /></div>}</AnimatePresence>)); };
const toolbar = () => host.querySelector(".lc-toolbar");

it("keeps the closing toolbar inert until its exit animation finishes", async () => {
  await render(true);
  act(() => animations[0].finish());
  await render(false);
  expect(toolbar()?.hasAttribute("inert")).toBe(true);
  act(() => animations.at(-1)!.finish());
  expect(toolbar()).toBeNull();
});

it("cancels an interrupted exit and keeps the reopened toolbar usable", async () => {
  await render(true);
  act(() => animations[0].finish());
  await render(false);
  const exit = animations.at(-1)!;
  await render(true);
  expect(exit.cancel).toHaveBeenCalled();
  expect(host.querySelectorAll(".lc-toolbar")).toHaveLength(1);
  expect(toolbar()?.hasAttribute("inert")).toBe(false);
});

it("completes a reduced-motion exit after the presence commit", async () => {
  reduced = true;
  await render(true);
  await render(false);
  expect(animations).toHaveLength(0);
  expect(toolbar()).toBeNull();
});
