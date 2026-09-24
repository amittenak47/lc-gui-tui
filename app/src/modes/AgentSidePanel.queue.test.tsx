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
it("sends unquoted replies inside their thread and keeps independent questions in the selected session", () => {
  const send = vi.fn();
  const messages: AgentChatMessage[] = [{id: "q", role: "user", content: "Question", at: 1, sessionId: "activity"}];
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false}
    messages={messages} onSend={send} focusThread={{rootId: "q", token: 1}} />));
  const submit = () => {
    const textarea = host.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Follow up");
      textarea.dispatchEvent(new Event("input", {bubbles: true}));
    });
    act(() => host.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})));
  };
  submit();
  expect(send).toHaveBeenLastCalledWith("Follow up", expect.objectContaining({threadRootId: "q", sessionId: "activity"}), "queue");
  act(() => button("Question").click());
  submit();
  expect(send).toHaveBeenLastCalledWith("Follow up", expect.objectContaining({threadRootId: null, sessionId: "activity"}), "queue");
  act(() => button("+ New session").click());
  submit();
  const flags = send.mock.lastCall![1];
  expect(flags.sessionId).not.toBe("activity");
  expect(flags.threadRootId).toBeNull();
});
function menu() { act(() => host.querySelector(".lc-agent-turn-user")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))); }
it("offers Draw this after an Ask that did not draw", () => {
  const send = vi.fn();
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[
    { id: "q", role: "user", content: "What is SGD?", at: 1, flags: ["Ask"], requestState: "completed" },
    { id: "a", role: "assistant", content: "SGD updates the weights.", at: 2, requestState: "completed" },
  ]} onSend={send} />));
  const offer = button("Draw this");
  expect(offer).toBeTruthy();
  act(() => offer.click());
  expect(send).toHaveBeenCalledWith("Draw a diagram of what you just explained.", expect.objectContaining({ ask: true, draw: true }));
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[
    { id: "q2", role: "user", content: "Draw SGD", at: 1, flags: ["Ask", "Draw"], requestState: "completed" },
    { id: "a2", role: "assistant", content: "Drawn.", at: 2, requestState: "completed" },
  ]} onSend={send} />));
  expect(button("Draw this")).toBeUndefined();
});
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
    requestNote: "The document changed during capture.",
    flags: ["Ask", "Annotations", "Reasoning · high"],
  }]} onSend={send} onRetryMessage={retry}
    quoteSeed={{ token: 1, text: "Selected passage", attachment: { label: "Selection", png: "test", thumb: "thumb" } }} />));
  expect(send).not.toHaveBeenCalled(); expect(host.textContent).toContain("Selected passage");
  expect(host.querySelector(".lc-agent-turn-failed")).toBeTruthy();
  const flags = host.querySelector(".lc-agent-turn-footnotes.is-failed");
  expect(flags).toBeTruthy();
  expect(flags!.classList.contains("lc-agent-turn-header-flags")).toBe(false);
  expect(flags!.querySelector(".lc-agent-turn-fail")?.getAttribute("aria-label")).toBe("The document changed during capture.");
  expect(flags!.querySelector(".lc-agent-turn-fail")?.getAttribute("data-tip")).toBe("The document changed during capture.");
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
  expect(flags!.querySelector(".lc-agent-turn-fail")?.getAttribute("aria-label")).toBe("This message was not sent.");
  expect(flags!.querySelector(".lc-agent-turn-fail")?.getAttribute("data-tip")).toBe("This message was not sent.");
  expect(host.querySelector(".lc-agent-turn-header-flags")).toBeNull();
  expect(host.querySelector(".lc-agent-turn-role")?.textContent).toBe("You");
});

it("marks a stopped message in amber with a stop icon and no cancelled label", () => {
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[
    { ...message("cancelled"), content: "can u explain", requestNote: "Stopped before this was sent.", flags: ["Ask"] },
    { id: "a1", role: "assistant", content: "Cancelled", at: 2, requestState: "cancelled", requestNote: "You stopped this reply.", processEvents: [] },
  ]} onSend={() => {}} />));
  const user = host.querySelector(".lc-agent-turn-user")!;
  const agent = host.querySelector(".lc-agent-turn-assistant")!;
  expect(user.classList.contains("lc-agent-turn-cancelled")).toBe(true);
  expect(user.textContent?.toLowerCase()).not.toContain("cancelled");
  expect(user.textContent).toContain("can u explain");
  expect(user.querySelector(".lc-agent-turn-fail")?.getAttribute("data-tip")).toBe("Stopped before this was sent.");
  expect(user.querySelector(".lc-agent-turn-fail svg rect")).toBeTruthy();
  expect(agent.textContent?.toLowerCase()).not.toContain("cancelled");
  expect(agent.querySelector(".lc-agent-turn-fail")?.getAttribute("data-tip")).toBe("You stopped this reply.");
});

it("Edit on a running message aborts it and restores the text to the composer", () => {
  const abort = vi.fn();
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy messages={[message("running")]} onSend={() => {}} onAbortMessage={abort} />));
  const turn = host.querySelector(".lc-agent-turn-user")!;
  expect(turn.textContent?.toLowerCase()).not.toContain("running");
  const mark = turn.querySelector(".lc-agent-turn-fail")!;
  expect(mark.querySelector(".lc-agent-turn-run")).toBeTruthy();
  expect(mark.getAttribute("aria-label")).toBe("The agent is replying.");
  menu();
  expect(button("Retry")).toBeUndefined();
  expect(button("Abort")).toBeTruthy();
  act(() => button("Edit").click());
  expect(abort).toHaveBeenCalledWith("question");
  expect(host.querySelector("textarea")!.value).toBe("Why?");
  expect(document.querySelector('[aria-label="Edit queued message"]')).toBeNull();
});

it("replaces the running spinner with a check of the same mark once the send completes", () => {
  const props = { open: true, mode: "review" as const, onModeChange: () => {}, busy: false, onSend: () => {} };
  const sent = { ...message("running"), flags: ["Ask"] };
  act(() => root.render(<AgentSidePanel {...props} messages={[sent]} />));
  const before = host.querySelector(".lc-agent-turn-fail")!;
  expect(before.querySelector(".lc-agent-turn-run")).toBeTruthy();
  act(() => root.render(<AgentSidePanel {...props} messages={[{ ...sent, requestState: "completed" }]} />));
  const turn = host.querySelector(".lc-agent-turn-user")!;
  expect(turn.textContent?.toLowerCase()).not.toContain("running");
  expect(turn.textContent?.toLowerCase()).not.toContain("completed");
  const mark = turn.querySelector(".lc-agent-turn-footnotes.is-completed .lc-agent-turn-fail")!;
  expect(mark.querySelector(".lc-agent-turn-run")).toBeNull();
  expect(mark.querySelector("svg.lc-agent-turn-fail-icon.is-settled")).toBeTruthy();
  expect(mark.getAttribute("aria-label")).toBe("Sent.");
  expect(turn.textContent).toMatch(/Ask/);
});

it("marks an interrupted request with the stop icon and does not print the state", () => {
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[message("interrupted")]} onSend={() => {}} />));
  const turn = host.querySelector(".lc-agent-turn-user")!;
  expect(turn.textContent?.toLowerCase()).not.toContain("interrupted");
  expect(turn.classList.contains("lc-agent-turn-cancelled")).toBe(true);
  expect(turn.querySelector(".lc-agent-turn-fail svg rect")).toBeTruthy();
  expect(turn.querySelector(".lc-agent-turn-fail")?.getAttribute("data-tip")).toBe("This request was interrupted.");
});

it("lists each question as a session and shows only the selected one", () => {
  const messages: AgentChatMessage[] = [
    { id: "q1", role: "user", content: "Why is this slow?", at: 1 },
    { id: "a1", role: "assistant", content: "It scans twice.", at: 2 },
    { id: "q2", role: "user", content: "Draw the array", at: 3 },
  ];
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={messages} onSend={() => {}} />));
  const thread = () => host.querySelector(".lc-agent-messages")!;
  expect(host.querySelector(".lc-agent-session.is-active")?.textContent).toBe("Draw the array");
  expect(thread().textContent).toContain("Draw the array");
  expect(thread().textContent).not.toContain("Why is this slow?");
  act(() => button("Why is this slow?").click());
  expect(thread().textContent).toContain("It scans twice.");
  expect(thread().textContent).not.toContain("Draw the array");
});

it("offers Delete for a message", () => {
  const remove = vi.fn();
  act(() => root.render(<AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[message("completed")]} onSend={() => {}} onDeleteMessage={remove} />));
  menu();
  act(() => button("Delete").click());
  expect(remove).toHaveBeenCalledWith("question");
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
