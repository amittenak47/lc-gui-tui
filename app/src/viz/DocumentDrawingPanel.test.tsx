/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentDrawingPanel } from "./DocumentDrawingPanel";
import { parseVizProgram } from "./schema";
import type { AgentChatMessage } from "../modes/AgentSidePanel";

vi.mock("./DrawingPreview", () => ({
  DrawingPreview: () => <canvas aria-label="preview" />,
}));
vi.mock("motion/react", () => {
  const passthrough = (Tag: "section" | "div") => {
    function MotionTag({
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...props
    }: Record<string, unknown>) {
      return <Tag {...props} />;
    }
    return MotionTag;
  };
  return {
    AnimatePresence: ({ children }: { children: unknown }) => children,
    motion: { section: passthrough("section"), div: passthrough("div") },
    useReducedMotion: () => true,
  };
});

const program = parseVizProgram({
  id: "walk",
  viz: "array",
  title: "Walk",
  frames: [{ label: "Start", cells: [1, 2], pointers: { i: 0 } }],
})!;

function message(id: string, title = "Walk", page = 47): AgentChatMessage {
  return {
    id,
    role: "assistant",
    content: "A tree.",
    at: 1,
    drawing: {
      program: { ...program, id: `${program.id}-${id}`, title },
      expanded: true,
      frameIndex: 0,
      page,
    },
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function renderPanel(props: Partial<Parameters<typeof DocumentDrawingPanel>[0]> = {}) {
  act(() => root.render(
    <DocumentDrawingPanel
      messages={[message("a1")]}
      onHide={() => {}}
      onFrame={() => {}}
      uiHand="right"
      inkHand="right"
      currentPage={47}
      intersectingPages={[47]}
      pageCount={12}
      {...props}
    />,
  ));
}

it("enlarges only after the maximize control is pressed", () => {
  renderPanel();
  const panel = host.querySelector(".lc-document-drawing-panel")!;
  expect(panel.classList.contains("is-maximized")).toBe(false);
  expect(panel.classList.contains("is-dock-left")).toBe(true);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Enlarge drawing"]')!.click());
  expect(host.querySelector(".lc-document-drawing-panel")!.classList.contains("is-maximized")).toBe(true);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Shrink drawing"]')!.click());
  expect(host.querySelector(".lc-document-drawing-panel")!.classList.contains("is-maximized")).toBe(false);
});

it("folds and parks when the camera leaves the drawing's page, then slides back unenlarged", () => {
  renderPanel();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Enlarge drawing"]')!.click());
  expect(host.querySelector(".lc-document-drawing-panel")!.classList.contains("is-maximized")).toBe(true);
  renderPanel({ currentPage: 50, intersectingPages: [50] });
  const parked = host.querySelector(".lc-document-drawing-panel")!;
  expect(parked.classList.contains("is-parked")).toBe(true);
  expect(parked.classList.contains("is-folded")).toBe(true);
  expect(parked.classList.contains("is-maximized")).toBe(false);
  renderPanel({ currentPage: 47, intersectingPages: [47] });
  const back = host.querySelector(".lc-document-drawing-panel")!;
  expect(back.classList.contains("is-parked")).toBe(false);
  expect(back.classList.contains("is-maximized")).toBe(false);
});

it("stacks drawings on one page as tabs, and stacks beside ink when hands match", () => {
  renderPanel({
    messages: [message("a1", "Tree"), message("a2", "Cases")],
  });
  expect(host.querySelector("[aria-label='Drawings on this page']")).toBeTruthy();
  expect(host.querySelectorAll("[role='tab']")).toHaveLength(2);
  const matched = host.querySelector(".lc-document-drawing-panel")!;
  expect(matched.classList.contains("is-dock-left")).toBe(true);
  expect(matched.classList.contains("is-stacked")).toBe(true);
  renderPanel({ uiHand: "left", inkHand: "right" });
  const mixed = host.querySelector(".lc-document-drawing-panel")!;
  expect(mixed.classList.contains("is-dock-right")).toBe(true);
  expect(mixed.classList.contains("is-stacked")).toBe(false);
});

it("hides enlarge while the drawing is folded", () => {
  renderPanel();
  expect(host.querySelector('[aria-label="Enlarge drawing"]')).toBeTruthy();
  act(() => host.querySelector<HTMLButtonElement>(".lc-drawing-fold")!.click());
  expect(host.querySelector(".lc-document-drawing-panel")!.classList.contains("is-folded")).toBe(true);
  expect(host.querySelector('[aria-label="Enlarge drawing"]')).toBeNull();
});

it("binds an unscoped drawing to the live page, then parks after a scroll", () => {
  const undated = message("a1");
  delete undated.drawing!.page;
  renderPanel({ messages: [undated], currentPage: 47, intersectingPages: [47] });
  expect(host.querySelector(".lc-document-drawing-panel")!.classList.contains("is-parked")).toBe(false);
  renderPanel({ messages: [undated], currentPage: 50, intersectingPages: [50] });
  expect(host.querySelector(".lc-document-drawing-panel")!.classList.contains("is-parked")).toBe(true);
});
