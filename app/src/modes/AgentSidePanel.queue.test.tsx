/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSidePanel, type AgentChatMessage } from "./AgentSidePanel";
vi.mock("../util/mobile", () => ({ useIsMobile: () => false }));
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.textContent = ""; vi.unstubAllGlobals(); });
const message = (state: AgentChatMessage["requestState"]): AgentChatMessage => ({ id: "question", role: "user", content: "Why?", at: 1, requestState: state });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
function menu() { act(() => host.querySelector(".lc-agent-turn-user")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))); }
it("offers Abort/Edit but not Retry for queued messages and releases Cancel edit", () => {
  const edit = vi.fn(() => true), cancel = vi.fn(), abort = vi.fn();
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy messages={[message("queued")]} onSend={() => {}} onEditMessage={edit} onCancelEdit={cancel} onAbortMessage={abort} />));
  menu(); expect(button("Retry")).toBeUndefined(); expect(button("Abort")).toBeTruthy();
  act(() => button("Edit").click()); expect(edit).toHaveBeenCalledWith("question");
  expect(document.querySelector('[aria-label="Edit queued message"]')).toBeTruthy();
  act(() => button("Cancel edit").click()); expect(cancel).toHaveBeenCalledWith("question");
  menu(); act(() => button("Abort").click()); expect(abort).toHaveBeenCalledWith("question");
});
it("offers Retry only after terminal state and selection seeds a draft without sending", () => {
  const retry = vi.fn(), send = vi.fn();
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[{
    ...message("failed"),
    flags: ["Ask", "Annotations", "Reasoning · high"],
  }]} onSend={send} onRetryMessage={retry}
    quoteSeed={{ token: 1, text: "Selected passage", attachment: { label: "Selection", png: "test", thumb: "thumb" } }} />));
  expect(send).not.toHaveBeenCalled(); expect(host.textContent).toContain("Selected passage");
  expect(host.querySelector(".lc-agent-turn-failed")).toBeTruthy();
  const flags = host.querySelector(".lc-agent-turn-footnotes.is-failed");
  expect(flags).toBeTruthy();
  expect(flags!.classList.contains("lc-agent-turn-header-flags")).toBe(false);
  expect(flags!.querySelector(".lc-agent-turn-fail")?.getAttribute("aria-label")).toBe("Failed");
  expect(flags!.textContent).toMatch(/Ask/);
  expect(flags!.textContent).toMatch(/Annotations/);
  expect(host.querySelector(".lc-agent-turn-header-flags")).toBeNull();
  expect(host.querySelector(".lc-agent-turn-role-group .lc-agent-turn-fail")).toBeNull();
  expect(host.querySelector(".lc-agent-turn-user small")?.textContent).not.toBe("failed");
  menu(); expect(button("Abort")).toBeUndefined(); act(() => button("Retry").click());
  expect(retry).toHaveBeenCalledWith("question");
});
it("keeps the fail mark on the YOU flags footer when send bits never landed", () => {
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[message("failed")]} onSend={() => {}} />));
  const flags = host.querySelector(".lc-agent-turn-footnotes.is-failed");
  expect(flags).toBeTruthy();
  expect(flags!.classList.contains("lc-agent-turn-header-flags")).toBe(false);
  expect(flags!.querySelector(".lc-agent-turn-fail")?.getAttribute("aria-label")).toBe("Failed");
  expect(host.querySelector(".lc-agent-turn-header-flags")).toBeNull();
  expect(host.querySelector(".lc-agent-turn-role")?.textContent).toBe("You");
});

it("puts AGENT send flags under the message with the same rule as YOU", () => {
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[
    { id: "a1", role: "assistant", content: "Three cases.", at: 2, flags: ["Ask", "Reasoning · high"] },
  ]} onSend={() => {}} />));
  const turn = host.querySelector(".lc-agent-turn-assistant")!;
  const flags = turn.querySelector(".lc-agent-turn-footnotes")!;
  expect(flags.classList.contains("lc-agent-turn-header-flags")).toBe(false);
  expect(flags.querySelector(".lc-agent-turn-flag-rule")).toBeTruthy();
  expect(flags.textContent).toMatch(/Ask/);
  expect(flags.textContent).toMatch(/Reasoning/);
  const body = turn.querySelector(".lc-agent-turn-body");
  expect(body).toBeTruthy();
  expect(body!.compareDocumentPosition(flags) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("text-only selection keeps a typed draft and sends the frozen quote only on Send", () => {
  const send = vi.fn();
  const props = { open: true, mode: "review" as const, onModeChange: () => {}, busy: false, messages: [], onSend: send };
  act(() => root.render(<AgentSidePanel {...props} />));
  const composer = host.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "Explain this passage");
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const view = { document_hash: "book", title: "Book", format: "pdf", pages: [3], text: "Selected passage", revision: "v1",
    viewport: { x: 0, y: 0, width: 800, height: 600 }, limitation: "Selection image unavailable; use selected text only." };
  act(() => root.render(<AgentSidePanel {...props} quoteSeed={{ token: 2, text: "Selected passage", view }} />));
  expect(composer.value).toBe("Explain this passage");
  expect(send).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Attached photos"]')).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  expect(send).toHaveBeenCalledWith("Explain this passage", expect.objectContaining({ pageQuote: "Selected passage", documentView: view }), "queue");
  expect(send.mock.calls[0][1].photos).toBeUndefined();
});
