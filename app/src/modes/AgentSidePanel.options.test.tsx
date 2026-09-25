/** @vitest-environment jsdom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSidePanel } from "./AgentSidePanel";

vi.mock("../util/mobile", () => ({ useIsMobile: () => false }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  localStorage.setItem("whiteboard.agent.reasoningLevel.v1", "off");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

function mount(props: Partial<ComponentProps<typeof AgentSidePanel>> = {}) {
  const send = vi.fn();
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[]} onSend={send} {...props} />));
  return send;
}
function button(label: string) {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
function tap(node: HTMLButtonElement) {
  expect(node).toBeTruthy();
  expect(node.disabled).toBe(false);
  act(() => node.click());
}
function openOptions() { tap(button("Annotations")); }

it("keeps Ink inside Annotations and separates footnotes, actions, presets and reasoning", () => {
  mount({ documentPresets: true, annotationChoices: [{ id: "fn", number: 1, title: "Note" }] });
  expect(button("Whiteboard")).toBeNull();
  expect(document.querySelector('[aria-label="Ask presets"]')).toBeNull();
  openOptions();
  const menu = document.querySelector('[aria-label="Annotations and agent options"]')!;
  expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(4);
  expect(menu.querySelector('.lc-hold-reveal')).toBeNull();
  expect(button("Ink").getAttribute("aria-checked")).toBe("false");
  tap(button("Ink"));
  expect(button("Ink").getAttribute("aria-checked")).toBe("true");
  const text = menu.textContent!;
  expect(text.indexOf("Ink")).toBeLessThan(text.indexOf("Footnotes"));
  expect(text.indexOf("Footnotes")).toBeLessThan(text.indexOf("Action"));
  expect(text.indexOf("Action")).toBeLessThan(text.indexOf("De-jargon"));
  expect(text.indexOf("De-jargon")).toBeLessThan(text.indexOf("Reasoning"));
});

it("cycles local pads through Ask, Draw, Ask with a tap, even without footnotes", () => {
  mount({ agentSurface: "pad", askOnly: true, allowAnnotations: false });
  openOptions();
  tap(button("Action: Ask"));
  expect(button("Action: Draw")).toBeTruthy();
  tap(button("Action: Draw"));
  expect(button("Action: Ask")).toBeTruthy();
  expect(document.body.textContent).not.toContain("Footnotes");
  expect(button("Ink").disabled).toBe(false);
});

it("keeps footnote selection live in the submenu and sends attached notes independently of Ink", () => {
  const toggle = vi.fn();
  const send = mount({
    busy: true,
    attachedMarks: [{ id: "fn", number: 1, title: "Note" }],
    annotationChoices: [{ id: "fn", number: 1, title: "Note" }],
    onToggleAttached: toggle,
  });
  openOptions();
  tap(button("Footnotes"));
  const note = document.querySelector<HTMLButtonElement>('.lc-agent-footnote-menu .lc-footnote-chip')!;
  expect(note.getAttribute("aria-checked")).toBe("true");
  tap(note);
  expect(toggle).toHaveBeenCalledWith("fn");
  expect(button("Annotations").getAttribute("aria-expanded")).toBe("true");
  tap(button("Send"));
  expect(send).toHaveBeenCalledWith("", expect.objectContaining({ annotations: true, handwriting: false, ask: true }), "queue");
});

it("opens footnotes toward the page, marks the row selected, and never shows empty copy", () => {
  mount({ annotationChoices: [{ id: "fn", number: 1, title: "Note" }] });
  openOptions();
  expect(document.body.textContent).not.toContain("No marks on this page");
  expect(button("Footnotes").className).not.toContain("is-active");
  tap(button("Footnotes"));
  expect(button("Footnotes").className).toContain("is-active");
  expect(button("Footnotes").getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[aria-label="Page footnotes"]')).toBeTruthy();
  expect(document.querySelector(".lc-agent-footnote-menu .lc-footnote-chip")).toBeTruthy();
});

it("omits the footnotes row when this page has no marks", () => {
  mount({ annotationChoices: [] });
  openOptions();
  expect(button("Footnotes")).toBeNull();
  expect(document.body.textContent).not.toContain("No marks on this page");
});

it("cycles problem actions through Draw, Review, Lazy, Ask and gates photos only for Review", () => {
  mount();
  openOptions();
  for (const [from, to] of [["Ask", "Draw"], ["Draw", "Review"], ["Review", "Lazy"], ["Lazy", "Ask"]]) {
    tap(button(`Action: ${from}`));
    expect(button(`Action: ${to}`)).toBeTruthy();
    expect(button("Add Photo").disabled).toBe(to === "Review");
  }
});

it("cycles reasoning Off, Low, Medium, High and back while preserving the preference", () => {
  mount();
  openOptions();
  expect(button("Reasoning: off").className).not.toContain("is-active");
  for (const [from, to] of [["off", "low"], ["low", "medium"], ["medium", "high"], ["high", "off"]]) {
    tap(button(`Reasoning: ${from}`));
    expect(button(`Reasoning: ${to}`)).toBeTruthy();
    expect(localStorage.getItem("whiteboard.agent.reasoningLevel.v1")).toBe(to);
    if (to === "off") {
      expect(button(`Reasoning: ${to}`).className).not.toContain("is-active");
    } else {
      expect(button(`Reasoning: ${to}`).className).toContain("is-active");
    }
  }
});

it("snapshots the next queued message's options while an earlier request is busy", () => {
  const send = mount({ busy: true, documentPresets: true });
  openOptions();
  tap(button("Capture"));
  tap(button("Ink"));
  tap(button("Action: Ask"));
  tap(button("Reasoning: off"));
  const preset = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Ask presets"] button')].find(node => node.textContent === "De-jargon")!;
  tap(preset);
  expect(preset.getAttribute("aria-checked")).toBe("true");
  tap(button("Send"));
  expect(send).toHaveBeenCalledWith("", expect.objectContaining({ draw: true, ask: false, handwriting: true, capture: true, reasoning: "low", askPreset: "de_jargon" }), "queue");
  openOptions();
  expect(button("Action: Ask")).toBeTruthy();
  expect(button("Ink").getAttribute("aria-checked")).toBe("false");
  expect(button("Capture").getAttribute("aria-checked")).toBe("false");
  expect(button("Reasoning: low")).toBeTruthy();
  expect(document.querySelector('[aria-label="Ask presets"] [aria-checked="true"]')).toBeNull();
});

it("keeps the options menu and footnotes panel on the button after the window resizes", () => {
  let buttonBox = new DOMRect(400, 700, 32, 32);
  const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("aria-label") === "Annotations") return buttonBox;
    if (this.classList.contains("lc-agent-mark-menu")) {
      return new DOMRect(buttonBox.left, buttonBox.top - 220, 216, 200);
    }
    return new DOMRect(0, 0, 0, 0);
  });
  try {
    mount({ annotationChoices: [{ id: "fn", number: 1, title: "Note" }] });
    openOptions();
    tap(button("Footnotes"));
    const menu = document.querySelector<HTMLElement>(".lc-agent-mark-menu")!;
    const notes = document.querySelector<HTMLElement>(".lc-agent-footnote-menu")!;
    expect(menu.style.left).toBe("400px");
    const notesBefore = notes.style.left;
    buttonBox = new DOMRect(120, 640, 32, 32);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(menu.style.left).toBe("120px");
    expect(notes.style.left).not.toBe(notesBefore);
  } finally {
    spy.mockRestore();
  }
});
