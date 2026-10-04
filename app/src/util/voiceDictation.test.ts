/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendSegment,
  onVoiceEvent,
  spliceDictation,
  cancelVoiceDictation,
  cleanupDictation,
  startVoiceDictation,
  stopVoiceDictation,
  VOICE_EVENT,
  voiceDictationAvailable,
  type VoiceEvent,
} from "./voiceDictation";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

beforeEach(() => {
  invoke.mockReset();
});

function dispatch(detail: unknown): void {
  window.dispatchEvent(new CustomEvent(VOICE_EVENT, { detail }));
}

describe("appendSegment", () => {
  it("returns a trimmed segment when nothing is committed yet", () => {
    expect(appendSegment("", "hello")).toBe("hello");
    expect(appendSegment("", "  hello  ")).toBe("hello");
  });

  it("trims both sides and joins them with one space", () => {
    expect(appendSegment("hello", "world")).toBe("hello world");
    expect(appendSegment("  hello  ", "  world  ")).toBe("hello world");
  });

  it("ignores a blank segment", () => {
    expect(appendSegment("hello", "")).toBe("hello");
    expect(appendSegment("hello", "   ")).toBe("hello");
    expect(appendSegment("hello ", "\n")).toBe("hello ");
  });
});

describe("spliceDictation", () => {
  it("fills an empty composer", () => {
    expect(spliceDictation({ before: "", after: "" }, "", "hello")).toEqual({
      text: "hello",
      caret: 5,
    });
  });

  it("inserts a space when before does not end in whitespace", () => {
    expect(spliceDictation({ before: "Hello", after: "" }, "", "world")).toEqual({
      text: "Hello world",
      caret: 11,
    });
  });

  it("keeps a trailing space on before", () => {
    expect(spliceDictation({ before: "Hello ", after: "" }, "", "world")).toEqual({
      text: "Hello world",
      caret: 11,
    });
  });

  it("keeps a trailing newline on before", () => {
    expect(spliceDictation({ before: "Hello\n", after: "" }, "", "world")).toEqual({
      text: "Hello\nworld",
      caret: 11,
    });
  });

  it("inserts a space when after has no leading whitespace", () => {
    expect(spliceDictation({ before: "", after: "there" }, "", "hello")).toEqual({
      text: "hello there",
      caret: 5,
    });
  });

  it("keeps leading whitespace on after", () => {
    expect(spliceDictation({ before: "", after: " there" }, "", "hello")).toEqual({
      text: "hello there",
      caret: 5,
    });
    expect(spliceDictation({ before: "", after: "\nthere" }, "", "hello")).toEqual({
      text: "hello\nthere",
      caret: 5,
    });
  });

  it("returns before + after and parks the caret when nothing was spoken", () => {
    expect(spliceDictation({ before: "Hi", after: "there" }, "", "   ")).toEqual({
      text: "Hithere",
      caret: 2,
    });
  });

  it("places the caret just after committed and partial together", () => {
    expect(spliceDictation({ before: "Say", after: "please." }, "hello", "world")).toEqual({
      text: "Say hello world please.",
      caret: "Say hello world".length,
    });
  });
});

describe("onVoiceEvent", () => {
  it("delivers a valid dispatched lc-voice event", () => {
    const heard: VoiceEvent[] = [];
    const stop = onVoiceEvent((event) => heard.push(event));
    dispatch({ type: "partial", text: "hi" });
    dispatch({ type: "state", listening: true });
    dispatch({ type: "final", text: "hi there" });
    dispatch({ type: "processing" });
    dispatch({ type: "error", code: "busy", message: "recognizer busy" });
    dispatch({ type: "end" });
    stop();
    expect(heard).toEqual([
      { type: "partial", text: "hi" },
      { type: "state", listening: true },
      { type: "final", text: "hi there" },
      { type: "processing" },
      { type: "error", code: "busy", message: "recognizer busy" },
      { type: "end" },
    ]);
  });

  it("ignores malformed details", () => {
    const heard: VoiceEvent[] = [];
    const stop = onVoiceEvent((event) => heard.push(event));
    dispatch({ text: "hi" });
    dispatch({ type: "result", text: "hi" });
    dispatch({ type: "partial", text: 1 });
    stop();
    expect(heard).toEqual([]);
  });

  it("stops delivery after unsubscribe", () => {
    const heard: VoiceEvent[] = [];
    const stop = onVoiceEvent((event) => heard.push(event));
    dispatch({ type: "partial", text: "hi" });
    stop();
    dispatch({ type: "final", text: "hi" });
    expect(heard).toEqual([{ type: "partial", text: "hi" }]);
  });
});

describe("voice commands", () => {
  it("resolves false off Android without calling invoke", async () => {
    Object.defineProperty(navigator, "userAgent", { value: DESKTOP, configurable: true });
    await expect(voiceDictationAvailable()).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("wraps a string rejection from voice_start", async () => {
    invoke.mockRejectedValueOnce("Microphone permission was denied");
    const caught = await startVoiceDictation().catch((err: unknown) => err);
    expect(invoke).toHaveBeenCalledWith("voice_start");
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Microphone permission was denied");
  });

  it("swallows a rejection from voice_stop", async () => {
    invoke.mockRejectedValueOnce("already stopped");
    await expect(stopVoiceDictation()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("voice_stop");
  });

  it("swallows a rejection from voice_cancel", async () => {
    invoke.mockRejectedValueOnce("already gone");
    await expect(cancelVoiceDictation()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("voice_cancel");
  });
});

describe("cleanupDictation", () => {
  it("returns the text from voice_cleanup", async () => {
    invoke.mockResolvedValueOnce("Hello.");
    await expect(cleanupDictation("hello")).resolves.toBe("Hello.");
    expect(invoke).toHaveBeenCalledWith("voice_cleanup", { text: "hello" });
  });

  it("resolves to the original text when voice_cleanup rejects", async () => {
    invoke.mockRejectedValueOnce("llm down");
    await expect(cleanupDictation("hello")).resolves.toBe("hello");
    expect(invoke).toHaveBeenCalledWith("voice_cleanup", { text: "hello" });
  });
});
