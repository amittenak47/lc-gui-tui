import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadCoachSessionView, saveCoachSessionView, type CoachSessionView } from "./coachSessionView";

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  });
  vi.stubGlobal("window", { localStorage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const view: CoachSessionView = {
  pickedSessionId: "session-a",
  newSessionId: null,
  drafts: { "session-a": "half a question", "session-b": "" },
  threads: { "session-a": "root-1" },
  replies: { "session-a": { id: "m1", role: "assistant", excerpt: "Because" } },
  composer: { "session-a": { start: 4, end: 4, scroll: 12 } },
  scroll: {
    "thread:root-1": { top: 240, pinned: false },
    "session:session-b": { top: 0, pinned: true },
  },
};

it("round-trips a pad's place and drops empty or pinned defaults", () => {
  saveCoachSessionView("lc/two-sum", view);
  expect(loadCoachSessionView("lc/two-sum")).toEqual({
    pickedSessionId: "session-a",
    newSessionId: null,
    drafts: { "session-a": "half a question" },
    threads: { "session-a": "root-1" },
    replies: { "session-a": { id: "m1", role: "assistant", excerpt: "Because" } },
    composer: { "session-a": { start: 4, end: 4, scroll: 12 } },
    scroll: { "thread:root-1": { top: 240, pinned: false } },
  });
  expect(loadCoachSessionView("other")).toEqual({
    pickedSessionId: null,
    newSessionId: null,
    drafts: {},
    threads: {},
    replies: {},
    composer: {},
    scroll: {},
  });
});

it("ignores a damaged store and an empty scope", () => {
  memory.set("whiteboard.agent.sessionView.v1", "{");
  expect(loadCoachSessionView("lc/two-sum").drafts).toEqual({});
  saveCoachSessionView("", view);
  expect(memory.size).toBe(1);
});
