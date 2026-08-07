import { describe, expect, it } from "vitest";

import type { CoachChatMessage } from "./AgentSidePanel";
import {
  buildConversationContext,
  CONTEXT_BUDGET_CHARS,
  threadTurns,
  withConversationContext,
} from "./coachContext";

function msg(
  id: string,
  overrides: Partial<CoachChatMessage> = {},
): CoachChatMessage {
  return {
    id,
    role: "user",
    content: `Turn ${id}`,
    at: 0,
    ...overrides,
  };
}

describe("threadTurns", () => {
  it("picks up assistant turns threaded to the root", () => {
    const root = msg("root", { role: "assistant", content: "Root answer" });
    const assistant = msg("asst-1", {
      role: "assistant",
      content: "Follow-up",
      replyTo: { id: "root", role: "assistant", excerpt: "Root answer" },
    });
    expect(threadTurns([root, assistant], "root")).toEqual([root, assistant]);
  });
});

describe("buildConversationContext", () => {
  it("uses the thread heading and excludes turns outside the thread", () => {
    const root = msg("root", { role: "assistant", content: "About two pointers" });
    const inThread = msg("user-1", {
      content: "Why that one?",
      replyTo: { id: "root", role: "assistant", excerpt: "About two pointers" },
    });
    const outside = msg("other", { role: "user", content: "Unrelated room turn" });
    const context = buildConversationContext([root, inThread, outside], {
      threadRootId: "root",
    });
    expect(context).toContain("Earlier in this thread");
    expect(context).toContain("Why that one?");
    expect(context).not.toContain("Unrelated room turn");
  });

  it("drops pending and empty turns and stops at the budget", () => {
    const older = msg("d", { content: "Older turn that should fall off the budget" });
    const pending = msg("b", { content: "Hidden", pending: true });
    const empty = msg("c", { content: "   " });
    const usable = msg("a", { content: "Visible newest" });
    const messages = [
      older,
      pending,
      empty,
      ...Array.from({ length: 30 }, (_, index) =>
        msg(`fill-${index}`, { content: `Budget filler ${index} `.repeat(40) }),
      ),
      usable,
    ];
    const context = buildConversationContext(messages);
    expect(context).toContain("Visible newest");
    expect(context).not.toContain("Hidden");
    expect(context).not.toContain("Older turn that should fall off the budget");
    expect(context.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS + 120);
  });
});

describe("withConversationContext", () => {
  it("returns the bare question when there is no usable history", () => {
    expect(withConversationContext("Why?", [])).toBe("Why?");
  });

  it("scopes history to the thread root when threadRootId is set", () => {
    const root = msg("root", { role: "assistant", content: "About sliding window" });
    const inThread = msg("user-1", {
      content: "Why that window?",
      replyTo: { id: "root", role: "assistant", excerpt: "About sliding window" },
    });
    const outside = msg("other", { role: "user", content: "Unrelated room turn" });
    const asked = withConversationContext("Say more", [root, inThread, outside], {
      threadRootId: "root",
    });
    expect(asked).toContain("Why that window?");
    expect(asked).not.toContain("Unrelated room turn");
    expect(asked).toContain("Say more");
  });
});
