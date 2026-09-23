import { describe, expect, it } from "vitest";
import type { AgentChatMessage } from "./AgentSidePanel";
import { restoreAgentMessages } from "./agentTranscript";
import { listSessions, mergeAgentMessages, orderSessions, organizeIntoSessions, sessionIdFor } from "./coachSessions";

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
  it("lets a tombstone win over a live copy and keeps a session id that only one side has", () => {
    const local = [{ id: "q1", content: "Why?", sessionId: "session-q1" }, { id: "q2", content: "Draw" }];
    const remote = [{ id: "q1", content: "Why?", deletedAt: 8 }, { id: "q2", content: "Draw", sessionId: "session-q2" }];
    const merged = mergeAgentMessages(local, remote) as Array<{ id: string; deletedAt?: number; sessionId?: string }>;
    expect(merged).toHaveLength(2);
    expect(merged.find((message) => message.id === "q1")?.deletedAt).toBe(8);
    expect(merged.find((message) => message.id === "q2")?.sessionId).toBe("session-q2");
  });
});
