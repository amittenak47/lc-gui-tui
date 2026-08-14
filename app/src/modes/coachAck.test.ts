import { describe, expect, it } from "vitest";

import { pendingAckLine, type AgentChatMessage } from "./AgentSidePanel";

function pendingMessage(pendingAck: AgentChatMessage["pendingAck"]): AgentChatMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
    at: 0,
    pending: true,
    pendingAck,
  };
}

describe("pendingAckLine", () => {
  it("falls back when no ack metadata", () => {
    expect(pendingAckLine(pendingMessage(undefined))).toBe("Working…");
  });

  it("summarizes flags and inputs", () => {
    expect(
      pendingAckLine(
        pendingMessage({
          flags: ["Ask", "Annotation"],
          hasQuestion: true,
          boardAttached: true,
          photoCount: 2,
        }),
      ),
    ).toBe("Ask, Annotation — got question + board + 2 photos");
  });

  it("omits flags when none were sent", () => {
    expect(
      pendingAckLine(
        pendingMessage({
          flags: [],
          hasQuestion: false,
          boardAttached: true,
          photoCount: 0,
        }),
      ),
    ).toBe("got board");
  });
});
