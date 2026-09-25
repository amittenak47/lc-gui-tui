import { describe, expect, it } from "vitest";
import type { AgentChatMessage } from "./AgentSidePanel";
import { persistableAgentMessages, restoreAgentMessages } from "./agentTranscript";
import { listSessions, mergeAgentMessages, orderSessions, organizeIntoSessions, replyChainIds, sessionIdFor } from "./coachSessions";

function msg(id: string, overrides: Partial<AgentChatMessage> = {}): AgentChatMessage {
  return { id, role: "user", content: id, at: 0, ...overrides };
}

describe("organizeIntoSessions", () => {
  it("starts a session at each question and keeps the answer with it", () => {
    const next = organizeIntoSessions([
      msg("q1", { content: "Why is this slow?" }),
      msg("a1", { role: "assistant", content: "It scans twice." }),
      msg("q2", { content: "Draw the array" }),
      msg("r1", { content: "And the indexes?", replyTo: { id: "q2", role: "user", excerpt: "Draw the array" } }),
    ]);
    expect(next.map((message) => message.sessionId)).toEqual([
      sessionIdFor("q1"),
      sessionIdFor("q1"),
      sessionIdFor("q2"),
      sessionIdFor("q2"),
    ]);
    expect(listSessions(next).map((session) => session.title)).toEqual([
      "Why is this slow?",
      "Draw the array",
    ]);
  });

  it("colors a session from its latest settled turn", () => {
    const next = organizeIntoSessions([
      msg("q1", { content: "Failed ask", requestState: "completed" }),
      msg("a1", { role: "assistant", content: "No", requestState: "failed" }),
      msg("q2", { content: "Stopped", requestState: "completed" }),
      msg("a2", { role: "assistant", content: "", requestState: "cancelled" }),
      msg("q3", { content: "Done", requestState: "completed" }),
      msg("a3", { role: "assistant", content: "Yes", requestState: "completed" }),
      msg("q4", { content: "Still going", requestState: "running" }),
    ]);
    expect(listSessions(next).map((session) => session.status)).toEqual([
      "failed",
      "aborted",
      "succeeded",
      undefined,
    ]);
  });

  it("keeps a retry answer in the question's session", () => {
    const next = organizeIntoSessions([
      msg("q1", { content: "See the board?", sessionId: "board" }),
      msg("a1", { role: "assistant", content: "First", sessionId: "board", requestId: "q1" }),
      msg("q2", { content: "Other", sessionId: "other" }),
      msg("retry", { content: "See the board?", sessionId: "session-retry", retryOf: "q1" }),
      msg("a2", { role: "assistant", content: "Second", sessionId: "session-retry", requestId: "retry" }),
    ]);
    expect(next.filter((message) => message.sessionId === "board").map((message) => message.id)).toEqual([
      "q1", "a1", "retry", "a2",
    ]);
    expect(listSessions(next).map((session) => session.id)).toEqual(["board", "other"]);
  });

  it("leaves an assigned transcript alone", () => {
    const messages = [msg("q1", { sessionId: "session-q1" })];
    expect(organizeIntoSessions(messages)).toBe(messages);
  });

  it("hides a tombstone from the rail but keeps it in the saved transcript", () => {
    const stored = [
      msg("q1", { content: "Keep", sessionId: "session-q1" }),
      msg("q2", { content: "Gone", sessionId: "session-q2", deletedAt: 5 }),
    ];
    const restored = restoreAgentMessages(stored);
    expect(restored.map((message) => message.id)).toEqual(["q1", "q2"]);
    expect(restored[1]?.deletedAt).toBe(5);
    expect(listSessions(restored).map((session) => session.title)).toEqual(["Keep"]);
  });
});

describe("orderSessions", () => {
  it("keeps pinned sessions at the top and leaves the rest in place", () => {
    const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(orderSessions(sessions, ["c", "a"]).map((session) => session.id)).toEqual(["c", "a", "b", "d"]);
  });
});

describe("mergeAgentMessages", () => {
  it("converges deletes and offline reply chains through repeated round trips", () => {
    const a = [msg("q", { deletedAt: 30 }), msg("keep", { at: 2 })];
    const b = [msg("q"), msg("r", { replyTo: { id: "q", role: "user", excerpt: "q" } }),
      msg("rr", { replyTo: { id: "r", role: "user", excerpt: "r" } }), msg("other", { at: 1 })];
    const left = restoreAgentMessages(mergeAgentMessages(a, b));
    const right = restoreAgentMessages(mergeAgentMessages(b, a));
    expect(left.filter(m => m.deletedAt).map(m => m.id)).toEqual(["q", "r", "rr"]);
    expect(listSessions(left)).toEqual(listSessions(right));
    expect(mergeAgentMessages(left, b)).toHaveLength(5);
    expect([...replyChainIds(b, "q")]).toEqual(["q", "r", "rr"]);
  });

  it("retains unknown data on reload, cancellation and tombstone merges", () => {
    const stored = [{ ...msg("q"), requestState: "cancelled", pending: true, future: { nested: [1,2] } },
      { ...msg("a", { role: "assistant", content: "" }), requestState: "running", pending: true }];
    const saved = JSON.parse(JSON.stringify(persistableAgentMessages(stored as AgentChatMessage[])));
    const reloaded = restoreAgentMessages(saved);
    expect(reloaded[0]).toMatchObject({ future: { nested: [1,2] }, requestState: "cancelled", pending: false });
    expect(reloaded[1]).toMatchObject({ requestState: "interrupted", pending: false });
    const merged = mergeAgentMessages(reloaded, [{ ...msg("q"), content: "late completed answer", requestState: "completed" }]);
    expect(merged[0]).toMatchObject({ content: "q", requestState: "cancelled", future: { nested: [1,2] } });
  });

  it("does not keep forking the same conflicting incoming message", () => {
    const a = [msg("q", { content: "local" })], b = [msg("q", { content: "remote" })];
    const once = mergeAgentMessages(a,b);
    expect(once).toHaveLength(2);
    expect(mergeAgentMessages(once,b)).toEqual(once);
    expect((once[1] as AgentChatMessage).id).not.toBe("q");
  });

  it("updates a local queued edit without erasing prior tombstones or future fields", () => {
    const saved = [{ ...msg("q"), requestState: "queued", future: true }, msg("deleted", { deletedAt: 2 })];
    const next = mergeAgentMessages(saved, [msg("q", { content: "edited", requestState: "queued" })], false);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ content: "edited", future: true });
    expect(next[1]).toMatchObject({ deletedAt: 2 });
  });
  it("lets a tombstone win over a live copy and keeps a session id that only one side has", () => {
    const local = [{ id: "q1", content: "Why?", sessionId: "session-q1" }, { id: "q2", content: "Draw" }];
    const remote = [{ id: "q1", content: "Why?", deletedAt: 8 }, { id: "q2", content: "Draw", sessionId: "session-q2" }];
    const merged = mergeAgentMessages(local, remote) as Array<{ id: string; deletedAt?: number; sessionId?: string }>;
    expect(merged).toHaveLength(2);
    expect(merged.find((message) => message.id === "q1")?.deletedAt).toBe(8);
    expect(merged.find((message) => message.id === "q2")?.sessionId).toBe("session-q2");
  });
});
