import type { CoachChatMessage, CoachReplyRef } from "./AgentSidePanel";
import { replyExcerpt } from "./AgentSidePanel";

export interface GroupedThreads {
  threadReplies: Map<string, CoachChatMessage[]>;
  rootMessages: CoachChatMessage[];
}

/** The conversation, grouped into roots and the threads hanging off them. */
export function groupThreads(messages: readonly CoachChatMessage[]): GroupedThreads {
  const rootOf = new Map<string, string>();
  const replies = new Map<string, CoachChatMessage[]>();
  const roots: CoachChatMessage[] = [];
  for (const message of messages) {
    const parent = message.replyTo?.id;
    if (!parent) {
      roots.push(message);
      continue;
    }
    const root = rootOf.get(parent) ?? parent;
    rootOf.set(message.id, root);
    const bucket = replies.get(root);
    if (bucket) bucket.push(message);
    else replies.set(root, [message]);
  }
  return { threadReplies: replies, rootMessages: roots };
}

/** The message a thread hangs off — walking up through any chain of replies. */
export function messageThreadRoot(
  messages: readonly CoachChatMessage[],
  message: CoachChatMessage,
): string {
  let current: CoachChatMessage | undefined = message;
  const seen = new Set<string>();
  while (current?.replyTo && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId: string = current.replyTo.id;
    const parent = messages.find((candidate) => candidate.id === parentId);
    if (!parent) return parentId;
    current = parent;
  }
  return current?.id ?? message.id;
}

/** What the transcript shows: the room, or one thread within it. */
export function visibleThreadMessages(
  messages: readonly CoachChatMessage[],
  openThreadId: string | null,
  grouped: GroupedThreads,
): CoachChatMessage[] {
  if (!openThreadId) return grouped.rootMessages;
  const root = messages.find((message) => message.id === openThreadId);
  const replies = grouped.threadReplies.get(openThreadId) ?? [];
  return root ? [root, ...replies] : replies;
}

/**
 * One-line label for a turn used as a reply stub / thread anchor.
 *
 * Review cards often ship with empty `content` (the card is the body). Without
 * a fallback, `threadAnchorRef` used to return null and in-thread sends fell
 * out of the thread into the room root list.
 */
export function messageReplyExcerpt(message: CoachChatMessage): string {
  const fromContent = replyExcerpt(message.content);
  if (fromContent) return fromContent;
  const review = message.review;
  if (review) {
    const approach = replyExcerpt(review.understood_approach);
    if (approach) return approach;
    const question = replyExcerpt(review.socratic_question);
    if (question) return question;
    return `Review · ${review.verdict}`;
  }
  if (message.drawing) return "Drawing";
  if (message.flags && message.flags.length > 0) return message.flags.join(" · ");
  return message.role === "assistant" ? "Coach message" : "Message";
}

/** A reply anchor for the thread root, for sends that did not quote a message. */
export function threadAnchorRef(
  messages: readonly CoachChatMessage[],
  id: string,
): CoachReplyRef | null {
  const message = messages.find((candidate) => candidate.id === id);
  if (!message) return null;
  return {
    id: message.id,
    role: message.role,
    excerpt: messageReplyExcerpt(message),
  };
}

/** Whether a reply stub should render above a turn. */
export function showsReplyStub(
  message: CoachChatMessage,
  openThreadId: string | null,
): boolean {
  if (!message.replyTo) return false;
  return message.replyTo.id !== openThreadId;
}
