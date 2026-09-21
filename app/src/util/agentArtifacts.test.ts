import { describe, expect, it } from "vitest";
import { artifactProposalSnapshot, sanitizeArtifactProposals } from "./agentArtifacts";

describe("agent-owned output", () => {
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
