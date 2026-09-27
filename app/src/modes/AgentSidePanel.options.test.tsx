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

it("places footnotes, Ink, Capture, reasoning and action directly in the composer", () => {
  mount({ documentPresets: true, annotationChoices: [{ id: "fn", number: 1, title: "Note" }] });
  const bar = document.querySelector('.lc-agent-composer-mid')!;
  const labels = [...bar.querySelectorAll('button')].map(node => node.getAttribute('aria-label'));
  expect(labels.slice(1,6)).toEqual(["Footnotes", "Ink", "Capture", "Reasoning: off", "Action: Ask"]);
  tap(button("Footnotes"));
  const menu = document.querySelector('[aria-label="Page footnotes"]')!;
  expect(menu.querySelectorAll('button')).toHaveLength(1);
  expect(menu.textContent).toContain("Note");
  expect(menu.textContent).not.toMatch(/Capture|Reasoning|Action|Ink/);
  tap(button("Ink"));
  expect(button("Ink").getAttribute("aria-pressed")).toBe("true");
  expect(button("Ink").className).toContain("lc-flag-active");
  expect(button("Capture").getAttribute("aria-pressed")).toBe("false");
});

it("cycles local pads through Ask, Draw, Ask even without footnotes", () => {
  mount({ agentSurface: "pad", askOnly: true, allowAnnotations: false });
  tap(button("Action: Ask"));
  tap(button("Action: Draw"));
  expect(button("Action: Ask")).toBeTruthy();
  expect(button("Footnotes")).toBeNull();
  expect(button("Ink").disabled).toBe(false);
});

it("keeps footnote selection live and sends attached notes independently of Ink", () => {
  const toggle = vi.fn();
  const send = mount({busy:true, attachedMarks:[{id:"fn",number:1,title:"Note"}],
    annotationChoices:[{id:"fn",number:1,title:"Note"}],onToggleAttached:toggle});
  tap(button("Footnotes"));
  const note = document.querySelector<HTMLButtonElement>('.lc-agent-footnote-menu .lc-footnote-chip')!;
  expect(note.getAttribute("aria-checked")).toBe("true");
  tap(note);
  expect(toggle).toHaveBeenCalledWith("fn");
  expect(button("Footnotes").getAttribute("aria-expanded")).toBe("true");
  tap(button("Send"));
  expect(send).toHaveBeenCalledWith("",expect.objectContaining({annotations:true,handwriting:false,capture:false,ask:true}),"queue");
});

it("disables the footnotes panel when the page has no marks", () => {
  mount({annotationChoices:[]});
  expect(button("Footnotes").disabled).toBe(true);
  expect(document.querySelector('[aria-label="Page footnotes"]')).toBeNull();
});

it("preserves problem actions and gates photos only for Review", () => {
  mount();
  for (const [from,to] of [["Ask","Draw"],["Draw","Review"],["Review","Lazy"],["Lazy","Ask"]]) {
    tap(button(`Action: ${from}`));
    expect(button(`Action: ${to}`)).toBeTruthy();
    expect(button("Add Photo").disabled).toBe(to === "Review");
  }
});

it("cycles and persists reasoning Off, Low, High without turning on Ink or Capture", () => {
  mount();
  for (const [from,to] of [["off","low"],["low","high"],["high","off"]]) {
    tap(button(`Reasoning: ${from}`));
    expect(button(`Reasoning: ${to}`)).toBeTruthy();
    expect(localStorage.getItem("whiteboard.agent.reasoningLevel.v1")).toBe(to);
    expect(button("Ink").getAttribute("aria-pressed")).toBe("false");
    expect(button("Capture").getAttribute("aria-pressed")).toBe("false");
  }
});

it("snapshots queued options without changing the request already in flight", () => {
  const send = mount({busy:true,documentPresets:true});
  tap(button("Capture")); tap(button("Ink")); tap(button("Action: Ask")); tap(button("Reasoning: off"));
  const preset = document.querySelector<HTMLSelectElement>('[aria-label="Ask presets"]')!;
  act(() => {preset.value="de_jargon";preset.dispatchEvent(new Event("change",{bubbles:true}));});
  tap(button("Send"));
  expect(send).toHaveBeenCalledWith("",expect.objectContaining({draw:true,ask:false,handwriting:true,capture:true,reasoning:"low",askPreset:"de_jargon"}),"queue");
  expect(button("Action: Ask")).toBeTruthy();
  expect(button("Ink").getAttribute("aria-pressed")).toBe("false");
  expect(button("Capture").getAttribute("aria-pressed")).toBe("false");
  expect(button("Reasoning: low")).toBeTruthy();
  expect(preset.value).toBe("");
});

it("keeps the footnote panel anchored to its button after resizing", () => {
  let box = new DOMRect(400,700,32,32);
  const spy = vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement) {
    return this.getAttribute("aria-label") === "Footnotes" ? box : new DOMRect(0,0,0,0);
  });
  try {
    mount({annotationChoices:[{id:"fn",number:1,title:"Note"}]});
    tap(button("Footnotes"));
    const menu = document.querySelector<HTMLElement>('[aria-label="Page footnotes"]')!;
    expect(menu.style.left).toBe("400px");
    box = new DOMRect(120,640,32,32);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(menu.style.left).toBe("120px");
  } finally {spy.mockRestore();}
});
