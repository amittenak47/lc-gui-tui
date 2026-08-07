import { describe, expect, it } from "vitest";

import type { CoachChatMessage } from "./AgentSidePanel";
import {
  groupThreads,
  messageThreadRoot,
  showsReplyStub,
  threadAnchorRef,
  visibleThreadMessages,
} from "./coachThreads";

function msg(
  id: string,
  overrides: Partial<CoachChatMessage> = {},
): CoachChatMessage {
  return {
    id,
    role: "user",
    content: `message ${id}`,
    at: 0,
    ...overrides,
  };
}

describe("visibleThreadMessages", () => {
  it("includes an assistant turn threaded to the root", () => {
    const root = msg("root", { role: "assistant", content: "Root answer" });
    const user = msg("user-1", {
      replyTo: { id: "root", role: "assistant", excerpt: "Root answer" },
    });
    const assistant = msg("asst-1", {
      role: "assistant",
      content: "Follow-up",
      replyTo: { id: "root", role: "assistant", excerpt: "Root answer" },
    });
    const messages = [root, user, assistant];
    const grouped = groupThreads(messages);
    expect(visibleThreadMessages(messages, "root", grouped)).toEqual([root, user, assistant]);
  });
});

describe("groupThreads", () => {
  it("groups an unquoted user send anchored at the root under that root", () => {
    const root = msg("root", { role: "assistant", content: "Root" });
    const user = msg("user-1", {
      replyTo: { id: "root", role: "assistant", excerpt: "Root" },
    });
    const grouped = groupThreads([root, user]);
    expect(grouped.rootMessages).toEqual([root]);
    expect(grouped.threadReplies.get("root")).toEqual([user]);
  });

  it("re-parents a reply-to-a-reply to the root", () => {
    const root = msg("root", { role: "assistant", content: "Root" });
    const first = msg("reply-1", {
      replyTo: { id: "root", role: "assistant", excerpt: "Root" },
    });
    const nested = msg("reply-2", {
      replyTo: { id: "reply-1", role: "user", excerpt: "message reply-1" },
    });
    const grouped = groupThreads([root, first, nested]);
    expect(grouped.threadReplies.get("root")).toEqual([first, nested]);
    expect(messageThreadRoot([root, first, nested], nested)).toBe("root");
  });

  it("counts assistant turns in the thread-bar reply count", () => {
    const root = msg("root", { role: "assistant", content: "Root" });
    const user = msg("user-1", {
      replyTo: { id: "root", role: "assistant", excerpt: "Root" },
    });
    const assistant = msg("asst-1", {
      role: "assistant",
      content: "In thread",
      replyTo: { id: "root", role: "assistant", excerpt: "Root" },
    });
    const grouped = groupThreads([root, user, assistant]);
    expect(grouped.threadReplies.get("root")?.length).toBe(2);
  });
});

describe("threadAnchorRef", () => {
  it("returns null for a missing id", () => {
    expect(threadAnchorRef([], "missing")).toBeNull();
  });

  it("returns a trimmed excerpt for a long message", () => {
    const long = "word ".repeat(80).trim();
    const root = msg("root", { role: "assistant", content: long });
    const anchor = threadAnchorRef([root], "root");
    expect(anchor).not.toBeNull();
    expect(anchor!.excerpt.length).toBeLessThan(long.length);
    expect(anchor!.excerpt.endsWith("…")).toBe(true);
  });

  it("anchors a review-only root with empty content", () => {
    const root = msg("root", {
      role: "assistant",
      content: "",
      review: {
        task_id: "t",
        provider: "test",
        understood_approach: "Two pointers from both ends",
        verdict: "on_track",
        rating: { correctness: 3, complexity: 3, clarity: 3 },
        strengths: [],
        gaps: [],
        counterexample: null,
        socratic_question: "What happens at the middle?",
        offer_bridge: false,
        counterexample_rejected: null,
      },
    });
    const anchor = threadAnchorRef([root], "root");
    expect(anchor).toEqual({
      id: "root",
      role: "assistant",
      excerpt: "Two pointers from both ends",
    });
  });

  it("falls back to Review · verdict when review text is empty", () => {
    const root = msg("root", {
      role: "assistant",
      content: "",
      review: {
        task_id: "t",
        provider: "test",
        understood_approach: "",
        verdict: "unclear",
        rating: { correctness: 1, complexity: 1, clarity: 1 },
        strengths: [],
        gaps: [],
        counterexample: null,
        socratic_question: "",
        offer_bridge: false,
        counterexample_rejected: null,
      },
    });
    const anchor = threadAnchorRef([root], "root");
    expect(anchor?.excerpt).toBe("Review · unclear");
  });
});

describe("showsReplyStub", () => {
  const rootStub = { id: "root", role: "assistant" as const, excerpt: "Root" };
  const replyStub = { id: "reply-1", role: "user" as const, excerpt: "Reply" };

  it("is false when the stub points at the open thread root", () => {
    const message = msg("user-1", { replyTo: rootStub });
    expect(showsReplyStub(message, "root")).toBe(false);
  });

  it("is true when the stub points at a reply inside the thread", () => {
    const message = msg("user-2", { replyTo: replyStub });
    expect(showsReplyStub(message, "root")).toBe(true);
  });

  it("is true in the room view", () => {
    const message = msg("user-1", { replyTo: rootStub });
    expect(showsReplyStub(message, null)).toBe(true);
  });
});
