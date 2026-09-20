import { describe, expect, it } from "vitest";
import { persistableAgentMessages, restoreAgentMessages } from "./agentTranscript";
import type { AgentChatMessage } from "./AgentSidePanel";
import type { ArtifactRef } from "../util/padArtifacts";

const artifact: ArtifactRef = {
  parent: { kind: "annotate", id: "set-1" }, artifactId: "scratch-1", kind: "whiteboard",
};

describe("artifact links in transcripts", () => {
  it("retains an artifact-only assistant turn on reload without a thumbnail", () => {
    const message: AgentChatMessage = {
      id: "turn-1", role: "assistant", content: "", at: 1, artifacts: [artifact],
    };
    const restored = restoreAgentMessages(persistableAgentMessages([message]));
    expect(restored).toHaveLength(1);
    expect(restored[0]!.artifacts).toEqual([artifact]);
  });

  it("shrinks photo attachments without shrinking or losing content references", () => {
    const message: AgentChatMessage = {
      id: "turn-1", role: "user", content: "Review", at: 1,
      artifacts: [artifact], attachments: [{ label: "page", png: "large", thumb: "small" }],
    };
    const [restored] = restoreAgentMessages(persistableAgentMessages([message]));
    expect(restored!.attachments![0]!.png).toBe("small");
    expect(restored!.artifacts).toEqual([artifact]);
    expect(message.attachments![0]!.png).toBe("large");
  });

  it("does not retain empty shells with only invalid links", () => {
    expect(restoreAgentMessages([{
      id: "turn-1", role: "assistant", content: "", at: 1,
      artifacts: [{ ...artifact, parent: null }],
    }])).toEqual([]);
  });

  it("keeps unavailable references and thread identity without resolving remote data", () => {
    const [restored] = restoreAgentMessages([{
      id: "turn-1", role: "assistant", content: "", at: 1, artifacts: [artifact],
      replyTo: { id: "root", role: "user", excerpt: "Make a diagram" },
    }]);
    expect(restored!.artifacts).toEqual([artifact]);
    expect(restored!.replyTo!.id).toBe("root");
  });
});
