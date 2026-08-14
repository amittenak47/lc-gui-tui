/**
 * What the coach is told about the conversation it is already in.
 *
 * Every ask was stateless: the daemon builds its prompt from the problem, the
 * code and the question, and nothing else. So "why?" arrived with no idea what
 * it was asking about, "do that instead" had no antecedent, and a student who
 * referred to something three turns back was referring to it alone. The thread
 * existed on screen and in `localStorage` and nowhere the model could reach.
 *
 * This assembles the missing half client-side and prepends it to the question,
 * which is deliberate: conversation state lives here, not in the daemon, and
 * carrying it in the prompt works against the `lc serve` people already have
 * rather than against one they would have to rebuild first. The cost is that
 * history arrives as prose inside a user turn instead of as real chat turns —
 * worth revisiting if `/coach/ask` ever grows a `history` field.
 */

import type { AgentChatMessage } from "./AgentSidePanel";

/**
 * Characters of transcript to spend.
 *
 * A budget rather than a turn count: two sentences and a stack trace are not
 * the same amount of context, and the thing that actually breaks a prompt is
 * length. Roughly a couple of thousand tokens, which leaves the problem
 * statement and the code the room they need.
 */
export const CONTEXT_BUDGET_CHARS = 6000;

/** Longest any single turn may be before the middle is dropped. */
const TURN_MAX_CHARS = 900;

const SPEAKER: Record<AgentChatMessage["role"], string> = {
  user: "Student",
  assistant: "You (coach)",
  system: "System",
  app: "Test run",
};

/**
 * Keep both ends of a long turn.
 *
 * A stack trace says what failed at the top and where at the bottom; a coach
 * answer states a claim first and qualifies it last. Truncating the tail throws
 * away half of either, so the middle is what goes.
 */
function condense(text: string): string {
  const flat = text.replace(/\r/g, "").trim();
  if (flat.length <= TURN_MAX_CHARS) return flat;
  const head = flat.slice(0, Math.floor(TURN_MAX_CHARS * 0.6)).trimEnd();
  const tail = flat.slice(-Math.floor(TURN_MAX_CHARS * 0.3)).trimStart();
  return `${head}\n… [${flat.length - head.length - tail.length} characters omitted] …\n${tail}`;
}

export interface ConversationContextOptions {
  /**
   * Only this thread's turns, when the question was asked from inside one.
   *
   * A thread is a subconversation about one message; replying inside it while
   * the model reads the whole room is how "no, the other one" gets answered
   * about the wrong thing. The parent turn is always included, because a thread
   * with no root is a set of answers to a question nobody can see.
   */
  threadRootId?: string | null;
  budget?: number;
}

/** Turns that belong to a thread: its root, and everything replying into it. */
export function threadTurns(
  messages: readonly AgentChatMessage[],
  rootId: string,
): AgentChatMessage[] {
  const ids = new Set<string>([rootId]);
  const out: AgentChatMessage[] = [];
  for (const message of messages) {
    if (message.id === rootId || (message.replyTo && ids.has(message.replyTo.id))) {
      // Replies to replies stay in the same thread rather than starting a new
      // one — the writer sees one back-and-forth, so the model should too.
      ids.add(message.id);
      out.push(message);
    }
  }
  return out;
}

/**
 * The transcript to prepend to a question, or "" when there is nothing to say.
 *
 * Newest turns win the budget: the last exchange is what a shorthand reference
 * almost always points at, and an older turn that no longer fits was going to
 * be the least useful thing in the prompt anyway.
 */
export function buildConversationContext(
  messages: readonly AgentChatMessage[],
  options: ConversationContextOptions = {},
): string {
  const budget = options.budget ?? CONTEXT_BUDGET_CHARS;
  const source = options.threadRootId
    ? threadTurns(messages, options.threadRootId)
    : messages;

  const usable = source.filter(
    (message) => !message.pending && message.content.trim().length > 0,
  );
  if (usable.length === 0) return "";

  const lines: string[] = [];
  let spent = 0;
  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const message = usable[i];
    const body = condense(message.content);
    const line = `${SPEAKER[message.role]}: ${body}`;
    if (spent + line.length > budget) break;
    spent += line.length;
    lines.unshift(line);
  }
  if (lines.length === 0) return "";

  const heading = options.threadRootId
    ? "Earlier in this thread (oldest first):"
    : "Earlier in this conversation (oldest first):";
  return `${heading}\n\n${lines.join("\n\n")}`;
}

/**
 * The question as the coach should receive it.
 *
 * The transcript goes above the question and is labelled as history, so the
 * model answers what is being asked now rather than the last thing it reads.
 */
export function withConversationContext(
  question: string,
  messages: readonly AgentChatMessage[],
  options: ConversationContextOptions = {},
): string {
  const context = buildConversationContext(messages, options);
  if (!context) return question;
  return `${context}\n\n---\n\nThe student now asks:\n${question}`;
}

/** A test run the student has not asked about yet — the auto-forward payload. */
export function describeRunFailure(report: string, code: string): string {
  const trimmed = report.trim();
  const source = code.trim();
  return [
    "The tests just failed. Here is the output:",
    "",
    condense(trimmed),
    "",
    "And the current solution:",
    "",
    "```python",
    condense(source),
    "```",
    "",
    "Explain what went wrong and what to look at first. Do not give the full",
    "solution unless the student asks for it.",
  ].join("\n");
}
