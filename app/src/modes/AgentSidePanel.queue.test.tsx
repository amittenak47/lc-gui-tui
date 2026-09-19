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
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[message("failed")]} onSend={send} onRetryMessage={retry}
    quoteSeed={{ token: 1, text: "Selected passage", attachment: { label: "Selection", png: "test", thumb: "thumb" } }} />));
  expect(send).not.toHaveBeenCalled(); expect(host.textContent).toContain("Selected passage");
  menu(); expect(button("Abort")).toBeUndefined(); act(() => button("Retry").click());
  expect(retry).toHaveBeenCalledWith("question");
});
