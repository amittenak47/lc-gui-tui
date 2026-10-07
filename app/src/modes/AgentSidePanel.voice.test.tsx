/** @vitest-environment jsdom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AgentSidePanel } from "./AgentSidePanel";
import {
  cancelVoiceDictation,
  cleanupDictation,
  startVoiceDictation,
  stopVoiceDictation,
  voiceDictationAvailable,
  type VoiceEvent,
} from "../util/voiceDictation";

vi.mock("../util/voiceDictation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/voiceDictation")>()),
  voiceDictationAvailable: vi.fn(() => Promise.resolve(true)),
  startVoiceDictation: vi.fn(() => Promise.resolve()),
  stopVoiceDictation: vi.fn(() => Promise.resolve()),
  cancelVoiceDictation: vi.fn(() => Promise.resolve()),
  cleanupDictation: vi.fn(async (text: string) => text),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  localStorage.setItem("whiteboard.agent.reasoningLevel.v1", "off");
  vi.mocked(voiceDictationAvailable).mockReset();
  vi.mocked(voiceDictationAvailable).mockImplementation(() => Promise.resolve(true));
  vi.mocked(startVoiceDictation).mockReset();
  vi.mocked(startVoiceDictation).mockImplementation(() => Promise.resolve());
  vi.mocked(stopVoiceDictation).mockReset();
  vi.mocked(stopVoiceDictation).mockImplementation(() => Promise.resolve());
  vi.mocked(cancelVoiceDictation).mockReset();
  vi.mocked(cancelVoiceDictation).mockImplementation(() => Promise.resolve());
  vi.mocked(cleanupDictation).mockReset();
  vi.mocked(cleanupDictation).mockImplementation(async (text: string) => text);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {});
}

async function mount(props: Partial<ComponentProps<typeof AgentSidePanel>> = {}) {
  const send = vi.fn();
  act(() => root.render(
    <AgentSidePanel open mode="review" onModeChange={() => {}} busy={false} messages={[]} onSend={send} {...props} />,
  ));
  await flush();
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

function composer() {
  return document.querySelector<HTMLTextAreaElement>(".lc-agent-composer-field textarea")!;
}

function type(text: string) {
  const el = composer();
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    el.focus();
    set.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function caretAtEnd() {
  const el = composer();
  act(() => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
}

type TestEvent<T = VoiceEvent> = T extends VoiceEvent ? Omit<T, "sessionId"> & { sessionId?: string } : never;
async function say(detail: TestEvent) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent("lc-voice", { detail: { sessionId: vi.mocked(startVoiceDictation).mock.calls.at(-1)?.[0], ...detail } }));
  });
  await act(async () => {});
}

it("places the mic in the action row immediately before Add Photo", async () => {
  await mount();
  const actions = document.querySelector(".lc-agent-composer-actions")!;
  const labels = [...actions.querySelectorAll("button")].map((node) => node.getAttribute("aria-label"));
  expect(labels).toEqual(["Voice", "Add Photo", "Send"]);
});

it("writes partials and finals at the caret until the recognizer ends", async () => {
  await mount();
  type("hello");
  caretAtEnd();
  tap(button("Voice"));
  expect(startVoiceDictation).toHaveBeenCalled();
  expect(button("Voice").getAttribute("aria-pressed")).toBe("true");
  await say({ type: "partial", text: "big" });
  expect(composer().value).toBe("hello big");
  await say({ type: "final", text: "big o" });
  expect(composer().value).toBe("hello big o");
  await say({ type: "partial", text: "notation" });
  expect(composer().value).toBe("hello big o notation");
  await say({ type: "end" });
  expect(button("Voice").getAttribute("aria-pressed")).toBe("false");
  expect(composer().value).toBe("hello big o notation");
});

it("stops the recognizer but still accepts the final that follows", async () => {
  await mount();
  type("hello");
  caretAtEnd();
  tap(button("Voice"));
  tap(button("Voice"));
  expect(stopVoiceDictation).toHaveBeenCalled();
  expect(button("Voice").getAttribute("aria-pressed")).toBe("true");
  await say({ type: "final", text: "there" });
  expect(composer().value).toBe("hello there");
  await say({ type: "end" });
  expect(button("Voice").getAttribute("aria-pressed")).toBe("false");
  expect(composer().value).toBe("hello there");
});

it("drops the session when the user types so a later partial is ignored", async () => {
  await mount();
  type("hello");
  caretAtEnd();
  tap(button("Voice"));
  type("user typed");
  expect(cancelVoiceDictation).toHaveBeenCalled();
  expect(stopVoiceDictation).not.toHaveBeenCalled();
  expect(button("Voice").getAttribute("aria-pressed")).toBe("false");
  expect(composer().value).toBe("user typed");
  await say({ type: "partial", text: "nope" });
  expect(composer().value).toBe("user typed");
});

it("shows the message when starting dictation is rejected", async () => {
  vi.mocked(startVoiceDictation).mockRejectedValueOnce(new Error("Microphone permission was denied"));
  await mount();
  tap(button("Voice"));
  await flush();
  expect(document.querySelector(".lc-warning")?.textContent).toBe("Microphone permission was denied");
  expect(button("Voice").getAttribute("aria-pressed")).toBe("false");
});

it("omits the mic when the recognizer is unavailable", async () => {
  vi.mocked(voiceDictationAvailable).mockImplementation(() => Promise.resolve(false));
  await mount();
  expect(document.querySelector('button[aria-label="Voice"]')).toBeNull();
});

it("marks the mic busy while a clip is transcribed, then inserts the final", async () => {
  await mount();
  type("hello");
  caretAtEnd();
  tap(button("Voice"));
  await say({ type: "processing" });
  const mic = button("Voice");
  expect(mic.getAttribute("aria-busy")).toBe("true");
  expect(mic.disabled).toBe(true);
  expect(mic.className).toContain("lc-agent-voice-busy");
  expect(mic.parentElement?.getAttribute("data-tip")).toBe("Transcribing…");
  expect(mic.getAttribute("aria-pressed")).toBe("false");
  await say({ type: "final", text: "there" });
  expect(composer().value).toBe("hello there");
  await say({ type: "end" });
  expect(button("Voice").disabled).toBe(false);
  expect(button("Voice").getAttribute("aria-busy")).toBeNull();
  expect(button("Voice").className).not.toContain("lc-agent-voice-busy");
  expect(button("Voice").getAttribute("aria-pressed")).toBe("false");
  expect(composer().value).toBe("hello there");
});

it("keeps a clip when the user types during processing and inserts the final at the new caret", async () => {
  await mount();
  type("hello");
  caretAtEnd();
  tap(button("Voice"));
  await say({ type: "processing" });
  type("hello there");
  caretAtEnd();
  expect(cancelVoiceDictation).not.toHaveBeenCalled();
  expect(stopVoiceDictation).not.toHaveBeenCalled();
  await say({ type: "final", text: "world" });
  expect(composer().value).toBe("hello there world");
});

it("cancels a clip being transcribed when the message is sent", async () => {
  await mount();
  type("hello");
  caretAtEnd();
  tap(button("Voice"));
  await say({ type: "processing" });
  tap(button("Send"));
  expect(cancelVoiceDictation).toHaveBeenCalled();
});

it("replaces the dictated span with the cleaned text after the recognizer ends", async () => {
  let resolveCleanup: (text: string) => void = () => {};
  vi.mocked(cleanupDictation).mockImplementation(
    () => new Promise((resolve) => { resolveCleanup = resolve; }),
  );
  await mount();
  type("hello");
  caretAtEnd();
  tap(button("Voice"));
  await say({ type: "partial", text: "big" });
  await say({ type: "final", text: "big o" });
  await say({ type: "partial", text: "notation" });
  await say({ type: "end" });
  expect(cleanupDictation).toHaveBeenCalledWith("big o notation");
  expect(button("Voice").parentElement?.getAttribute("data-tip")).toBe("Tidying…");
  expect(composer().value).toBe("hello big o notation");
  await act(async () => { resolveCleanup("Big-O notation"); });
  await flush();
  expect(composer().value).toBe("hello Big-O notation");
  expect(button("Voice").getAttribute("aria-pressed")).toBe("false");
  expect(button("Voice").disabled).toBe(false);
});

it("keeps the raw text when the user types during cleaning and ignores the late result", async () => {
  let resolveCleanup: (text: string) => void = () => {};
  vi.mocked(cleanupDictation).mockImplementation(
    () => new Promise((resolve) => { resolveCleanup = resolve; }),
  );
  await mount();
  type("hello");
  caretAtEnd();
  tap(button("Voice"));
  await say({ type: "final", text: "there" });
  await say({ type: "end" });
  expect(button("Voice").parentElement?.getAttribute("data-tip")).toBe("Tidying…");
  vi.mocked(cancelVoiceDictation).mockClear();
  type("hello there!");
  expect(cancelVoiceDictation).not.toHaveBeenCalled();
  expect(composer().value).toBe("hello there!");
  await act(async () => { resolveCleanup("Hello there, friend."); });
  await flush();
  expect(composer().value).toBe("hello there!");
  expect(button("Voice").getAttribute("aria-pressed")).toBe("false");
});

it("does not clean up a session that heard nothing", async () => {
  await mount();
  tap(button("Voice"));
  await say({ type: "end" });
  expect(cleanupDictation).not.toHaveBeenCalled();
  expect(button("Voice").getAttribute("aria-pressed")).toBe("false");
});


it("ignores transcripts and closing events from a cancelled clip after a new session starts", async () => {
  await mount();
  tap(button("Voice"));
  const oldId = vi.mocked(startVoiceDictation).mock.calls.at(-1)![0];
  await say({ type: "processing" });
  await mount({ open: false });
  expect(cancelVoiceDictation).toHaveBeenCalledWith(oldId);
  await mount();
  type("new chat");
  tap(button("Voice"));
  const currentId = vi.mocked(startVoiceDictation).mock.calls.at(-1)![0];
  expect(currentId).not.toBe(oldId);
  await say({ sessionId: oldId, type: "final", text: "old clip transcript" });
  await say({ sessionId: oldId, type: "end" });
  expect(composer().value).toBe("new chat");
  expect(button("Voice").getAttribute("aria-pressed")).toBe("true");
  await say({ sessionId: currentId, type: "final", text: "fresh transcript" });
  expect(composer().value).toBe("new chat fresh transcript");
});

it("stops and transcribes once at the recording limit and explains why", async () => {
  await mount();
  tap(button("Voice"));
  const id = vi.mocked(startVoiceDictation).mock.calls.at(-1)![0];
  await say({ type: "limit" });
  await say({ type: "limit" });
  expect(stopVoiceDictation).toHaveBeenCalledTimes(1);
  expect(stopVoiceDictation).toHaveBeenCalledWith(id);
  expect(host.textContent).toContain("15-minute limit");
  await say({ type: "final", text: "recorded words" });
  await say({ type: "end" });
  expect(composer().value).toBe("recorded words");
  expect(button("Voice")).toBeTruthy();
});
