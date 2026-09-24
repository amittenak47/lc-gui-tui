import { describe, expect, it } from "vitest";
import { artifactProposalSnapshot, sanitizeArtifactProposals } from "./agentArtifacts";

describe("agent-owned output", () => {
  it("keeps a saved thread's original message fields alongside its Markdown", () => {
    const messages = [{id: "q", role: "user", content: "Question", sessionId: "s", future: {value: 1}},
      {id: "a", role: "assistant", content: "Answer", replyTo: {id: "q"}, sessionId: "s"}];
    const snapshot = artifactProposalSnapshot({kind: "markdown", title: "Conversation", source: "Question\nAnswer", messages}, false);
    expect(snapshot.kind).toBe("markdown");
    if (snapshot.kind === "whiteboard") throw new Error("wrong kind");
    expect(snapshot.value.agent).toEqual(messages);
  });
  it("creates owned code and Markdown without disk paths or inline ink", () => {
    for (const kind of ["code", "markdown"] as const) {
      const snapshot = artifactProposalSnapshot({ kind, title: "Answer", source: "explanation" }, false);
      expect(snapshot.value).toMatchObject({ owned: true, source: "explanation", docType: kind });
      expect(snapshot.value.board).not.toHaveProperty("inkC");
      expect(snapshot.value.ink.size).toBe(0);
    }
  });
  it("validates complete proposals before publication", () => {
    expect(() => artifactProposalSnapshot({ kind: "whiteboard", title: "Bad", source: "text" }, false)).toThrow();
    expect(() => artifactProposalSnapshot({ kind: "code", title: "Bad", source: "x".repeat(512001) }, false)).toThrow();
    expect(() => artifactProposalSnapshot({ kind: "whiteboard", title: "Bad", programs: [{}] }, false)).toThrow();
    expect(sanitizeArtifactProposals([{ kind: "disk", title: "Bad" }])).toBeUndefined();
  });
});
