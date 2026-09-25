import type { AgentChatMessage, AgentSendFlags, CoachReplyRef } from "./AgentSidePanel";
import { replyExcerpt } from "./AgentSidePanel";
import { organizeIntoSessions, replyChainIds } from "./coachSessions";

/** Resolve room/session and thread membership before reserving a queued turn. */
export function sendConversationContext(messages: readonly AgentChatMessage[], flags: Pick<AgentSendFlags, "replyTo" | "threadRootId" | "sessionId">) {
  const organized = organizeIntoSessions(messages);
  const replyTo = flags.replyTo ?? (flags.threadRootId ? threadAnchorRef(organized, flags.threadRootId) ?? undefined : undefined);
  const parent = replyTo ? organized.find(message => message.id === replyTo.id && !message.deletedAt) : undefined;
  return { ...(replyTo ? {replyTo} : {}), ...(parent?.sessionId || flags.sessionId ? {sessionId: parent?.sessionId ?? flags.sessionId!} : {}) };
}

/** A linked thread is a root and its descendants, never its entire session. */
export function conversationMessages(messages: readonly AgentChatMessage[], id: string): AgentChatMessage[] {
  const message = messages.find(row => row.id === id && !row.deletedAt);
  if (!message) return [];
  const ids = replyChainIds(messages, messageThreadRoot(messages, message));
  return messages.filter(row => ids.has(row.id) && !row.deletedAt);
}

export function conversationMarkdown(messages: readonly AgentChatMessage[]): string {
  return messages.map(message => `### ${message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "App"}\n\n${message.content || message.review?.understood_approach || (message.drawing ? "[Drawing]" : "")}`).join("\n\n---\n\n");
}

export interface RetryAttempt {
  question: AgentChatMessage;
  answer: AgentChatMessage | null;
}

/** One question and every retry of it, oldest first. */
export interface RetrySeries {
  originId: string;
  attempts: RetryAttempt[];
}

/**
 * Retries are extra copies of the same question.
 *
 * The room shows the original question and one agent answer. The others stay
 * in the transcript so each attempt can still grow its own thread.
 */
export function retrySeries(messages: readonly AgentChatMessage[]): Map<string, RetrySeries> {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const originOf = (message: AgentChatMessage): string => {
    let current = message;
    const seen = new Set<string>();
    while (current.retryOf && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.retryOf);
      if (!parent) return current.retryOf;
      current = parent;
    }
    return current.id;
  };
  const questions = new Map<string, AgentChatMessage[]>();
  for (const message of messages) {
    if (message.deletedAt || message.role !== "user") continue;
    if (!message.retryOf && !messages.some((other) => other.retryOf === message.id && !other.deletedAt)) continue;
    const origin = message.retryOf ? originOf(message) : message.id;
    const bucket = questions.get(origin);
    if (bucket) bucket.push(message);
    else questions.set(origin, [message]);
  }
  const answerFor = new Map<string, AgentChatMessage>();
  for (const message of messages) {
    if (message.deletedAt || message.role !== "assistant" || !message.requestId) continue;
    answerFor.set(message.requestId, message);
  }
  const series = new Map<string, RetrySeries>();
  for (const [originId, group] of questions) {
    group.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    series.set(originId, {
      originId,
      attempts: group.map((question) => ({ question, answer: answerFor.get(question.id) ?? null })),
    });
  }
  return series;
}

/**
 * A retry leaves the old question behind. The latest send and the selected
 * answer stay at the bottom. Stepping changes the answer, not that pair's place.
 */
export function placeRetryView(
  messages: readonly AgentChatMessage[],
  seriesByOrigin: ReadonlyMap<string, RetrySeries>,
  indexOf: (series: RetrySeries) => number,
): AgentChatMessage[] {
  const hidden = new Set<string>();
  const follow = new Map<string, AgentChatMessage>();
  for (const series of seriesByOrigin.values()) {
    const index = indexOf(series);
    const latest = series.attempts[series.attempts.length - 1]?.question;
    if (latest && latest.id !== series.originId) hidden.add(series.originId);
    series.attempts.forEach((attempt, i) => {
      if (latest && attempt.question.id !== latest.id) hidden.add(attempt.question.id);
      if (attempt.answer && i !== index) hidden.add(attempt.answer.id);
    });
    const answer = series.attempts[index]?.answer;
    if (answer && latest) follow.set(latest.id, answer);
  }
  const selected = new Set([...follow.values()].map((answer) => answer.id));
  const next = messages.filter((message) => !hidden.has(message.id) && !selected.has(message.id));
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const answer = follow.get(next[i].id);
    if (answer) next.splice(i + 1, 0, answer);
  }
  return next;
}

export interface GroupedThreads {
  threadReplies: Map<string, AgentChatMessage[]>;
  rootMessages: AgentChatMessage[];
}

/**
 * The conversation, grouped into roots and the threads hanging off them.
 *
 * A question and the agent's answer are two room turns. A thread starts only
 * when you reply to that answer: the answer then leaves the room and hangs
 * off the question with everything said after it.
 */
export function groupThreads(messages: readonly AgentChatMessage[]): GroupedThreads {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const topOf = (message: AgentChatMessage): string => {
    let current = message;
    const seen = new Set<string>();
    while (current.replyTo && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.replyTo.id);
      if (!parent) return current.replyTo.id;
      current = parent;
    }
    return current.id;
  };
  const engaged = new Set<string>();
  for (const message of messages) {
    // The agent's own answer points at the question. That is not a thread.
    // A thread starts when you reply — to the agent, or to a message of yours.
    if (message.role !== "user" || !message.replyTo) continue;
    engaged.add(topOf(message));
  }
  const replies = new Map<string, AgentChatMessage[]>();
  const roots: AgentChatMessage[] = [];
  for (const message of messages) {
    if (!message.replyTo) {
      roots.push(message);
      continue;
    }
    const root = topOf(message);
    if (!engaged.has(root)) {
      roots.push(message);
      continue;
    }
    const bucket = replies.get(root);
    if (bucket) bucket.push(message);
    else replies.set(root, [message]);
  }
  return { threadReplies: replies, rootMessages: roots };
}

/** The message a thread hangs off — walking up through any chain of replies. */
export function messageThreadRoot(
  messages: readonly AgentChatMessage[],
  message: AgentChatMessage,
): string {
  let current: AgentChatMessage | undefined = message;
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
  messages: readonly AgentChatMessage[],
  openThreadId: string | null,
  grouped: GroupedThreads,
): AgentChatMessage[] {
  if (openThreadId) {
    const root = messages.find((message) => message.id === openThreadId);
    const replies = grouped.threadReplies.get(openThreadId) ?? [];
    return root ? [root, ...replies] : replies;
  }
  /*
   * Room is roots only. Threaded Agent turns used to be copied under the root
   * as well, so a "3 replies" chip sat next to the same latest answer in full.
   * Peek lives on the chip; open the thread for the back-and-forth.
   */
  return grouped.rootMessages;
}

/**
 * One-line label for a turn used as a reply stub / thread anchor.
 *
 * Review cards often ship with empty `content` (the card is the body). Without
 * a fallback, `threadAnchorRef` used to return null and in-thread sends fell
 * out of the thread into the room root list.
 */
export function messageReplyExcerpt(message: AgentChatMessage): string {
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
  return message.role === "assistant" ? "Agent message" : "Message";
}

/** A reply anchor for the thread root, for sends that did not quote a message. */
export function threadAnchorRef(
  messages: readonly AgentChatMessage[],
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
  message: AgentChatMessage,
  openThreadId: string | null,
): boolean {
  if (!message.replyTo) return false;
  if (message.replyTo.id === openThreadId) return false;
  // The agent's answer sits under the question. It is not a quoted reply.
  if (!openThreadId && message.role === "assistant") return false;
  return true;
}
