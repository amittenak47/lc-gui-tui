/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExploreWorkspace } from "./ExploreWorkspace";

const gpu = vi.hoisted(() => ({ instances: [] as Array<{
  paint: ReturnType<typeof vi.fn>; setStyles: ReturnType<typeof vi.fn>;
  setInteraction: ReturnType<typeof vi.fn>; setReducedMotion: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}> }));
vi.mock("./exploreWebGL", () => ({ createExploreWebGL: () => {
  const renderer = { paint: vi.fn(), setStyles: vi.fn(), setInteraction: vi.fn(), setReducedMotion: vi.fn(), dispose: vi.fn() };
  gpu.instances.push(renderer); return renderer;
} }));
vi.mock("../shellContext", () => ({ useShell: () => ({ headerSlots: { boardChrome: null } }) }));
vi.mock("../util/noteLinks", async original => ({ ...await original<typeof import("../util/noteLinks")>(), listEdges: async () => [] }));

let root: Root, host: HTMLDivElement;
const frames = new Map<number, FrameRequestCallback>();
beforeEach(async () => {
  gpu.instances.length = 0; frames.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let next = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(++next, cb); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(40, 60, 600, 400));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ExploreWorkspace nodes={[
    { type: "annotate", id: "a", title: "Alpha" }, { type: "whiteboard", id: "b", title: "Beta" },
  ]} themeId="paper" onThemePick={() => {}} onOpen={() => {}} onOpenInNewTab={() => {}}
    canOpenInNewTab={() => true} active showing />));
});
afterEach(() => { act(() => root.unmount()); document.body.textContent = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function point() {
  return gpu.instances.at(-1)!.paint.mock.calls.at(-1)![0].find((p: { id: string }) => p.id === "annotate:a") as { x: number; y: number };
}
function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 40 + x, clientY: 60 + y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" } });
  act(() => host.querySelector("canvas")!.dispatchEvent(event));
}

it("taps a GPU node at its rendered position and anchors the existing sheet there", () => {
  const p = point(), canvas = host.querySelector("canvas")!; canvas.setPointerCapture = vi.fn();
  pointer("pointerdown", p.x, p.y); pointer("pointerup", p.x, p.y);
  const sheet = document.querySelector<HTMLElement>(".lc-node-sheet")!;
  expect(sheet.querySelector("input")!.value).toBe("Alpha");
  expect(parseFloat(sheet.style.getPropertyValue("--lc-morph-x"))).toBeCloseTo(40 + p.x);
  expect(host.querySelector('[data-node-key="annotate:a"]')!.getAttribute("aria-pressed")).toBe("true");
});

it("drags a GPU node without opening its sheet, then allows keyboard selection", () => {
  const p = point(), canvas = host.querySelector("canvas")!; canvas.setPointerCapture = vi.fn();
  pointer("pointerdown", p.x, p.y); pointer("pointermove", 240, 180); pointer("pointerup", 240, 180);
  expect(point()).toMatchObject({ x: 240, y: 180 });
  expect(gpu.instances.at(-1)!.paint.mock.calls.at(-1)![0].at(-1).id).toBe("annotate:a");
  expect(document.querySelector(".lc-node-sheet")).toBeNull();
  const button = host.querySelector<HTMLButtonElement>('[data-node-key="annotate:a"]')!;
  act(() => { button.focus(); button.click(); });
  expect(document.querySelector<HTMLInputElement>(".lc-node-sheet input")!.value).toBe("Alpha");
});

it("shows the DOM fallback after context loss and rebuilds GPU styling on restoration", () => {
  const canvas = host.querySelector("canvas")!, initial = gpu.instances[0];
  const loss = new Event("webglcontextlost", { cancelable: true });
  act(() => canvas.dispatchEvent(loss));
  expect(loss.defaultPrevented).toBe(true);
  expect(initial.dispose).toHaveBeenCalledOnce();
  expect(host.querySelector(".is-webgl")).toBeNull();
  expect(canvas.hidden).toBe(true);
  act(() => canvas.dispatchEvent(new Event("webglcontextrestored")));
  expect(host.querySelector(".is-webgl")).not.toBeNull();
  expect(gpu.instances.at(-1)!.setStyles.mock.calls.at(-1)![0]).toHaveLength(2);
});

it("keeps Explore usable when a GPU frame throws", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  gpu.instances[0].paint.mockImplementationOnce(() => { throw Error("GPU exhausted"); });
  const batch = [...frames.values()]; frames.clear();
  act(() => { for (const cb of batch) cb(performance.now() + 16); });
  expect(host.querySelector(".is-webgl")).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[data-node-key="annotate:a"]')!.click());
  expect(document.querySelector<HTMLInputElement>(".lc-node-sheet input")!.value).toBe("Alpha");
});
