import type { AgentChatMessage } from "./AgentSidePanel";
import { restoreMessageDrawing } from "../viz/drawingState";
import { sanitizeArtifactRefs } from "../util/padArtifacts";

export function restoreAgentMessages(stored: unknown[]): AgentChatMessage[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const message = entry as Partial<AgentChatMessage> & { drawing?: unknown };
    if (typeof message.id !== "string" || typeof message.role !== "string") return [];
    // Older builds could persist an in-flight placeholder. Drop it — a turn
    // stuck on "Working…" would wait for a socket that will never answer.
    if (message.pending) return [];
    const drawing = restoreMessageDrawing(message.drawing);
    const artifacts = sanitizeArtifactRefs(message.artifacts);
    const content = typeof message.content === "string" ? message.content : "";
    const processEvents = Array.isArray(message.processEvents)
      ? message.processEvents
      : undefined;
    const reasoning =
      typeof message.reasoning === "string" && message.reasoning.trim()
        ? message.reasoning
        : undefined;
    const flags = Array.isArray(message.flags)
      ? message.flags.filter((flag): flag is string => typeof flag === "string" && flag.length > 0)
      : undefined;
    // This function rebuilds a turn field by field, so anything not named here
    // is dropped on reload — a reply thread has to be carried explicitly or it
    // survives exactly until the page refreshes.
    const raw = message.replyTo;
    const replyTo =
      raw &&
      typeof raw.id === "string" &&
      typeof raw.role === "string" &&
      typeof raw.excerpt === "string"
        ? { id: raw.id, role: raw.role as AgentChatMessage["role"], excerpt: raw.excerpt }
        : undefined;
    // Empty assistant shells left after stripping `pending` are noise.
    if (
      message.role === "assistant" &&
      !content.trim() &&
      !message.review &&
      !message.bridge &&
      !message.attachments?.length &&
      !artifacts?.length &&
      !drawing &&
      !processEvents?.length &&
      !reasoning
    ) {
      return [];
    }
    return [
      {
        id: message.id,
        role: message.role as AgentChatMessage["role"],
        content,
        at: typeof message.at === "number" ? message.at : Date.now(),
        requestId: message.requestId, retryOf: message.retryOf,
        requestState: message.requestState && ["preparing", "queued", "running"].includes(message.requestState)
          ? "interrupted" : message.requestState,
        review: message.review,
        bridge: message.bridge,
        attachments: message.attachments,
        ...(artifacts ? { artifacts } : {}),
        ...(flags && flags.length > 0 ? { flags } : {}),
        ...(processEvents ? { processEvents } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(drawing ? { drawing } : {}),
        ...(replyTo ? { replyTo } : {}),
      },
    ];
  });
}

/** Persist finished turns only — never an in-flight `pending` placeholder. */
/**
 * The thread as it should be stored, which is not the thread as it is shown.
 *
 * Pending turns go, because a turn that never finished is not a turn. And an
 * attached photo drops to its thumbnail: `png` is sized for a vision model —
 * 1568px, 3–5.5 MB base64 — and it has already been sent by the time anything
 * persists. Keeping it would mean four photos on one message costing more than
 * the entire localStorage budget, forever, to redisplay an image the bubble
 * draws at 320px anyway.
 */
export function persistableAgentMessages(messages: AgentChatMessage[]): AgentChatMessage[] {
  return messages
    .filter((message) => !message.pending)
    .map((message) => {
      if (!message.attachments?.some((att) => att.thumb)) return message;
      return {
        ...message,
        attachments: message.attachments.map((att) =>
          att.thumb ? { ...att, png: att.thumb } : att,
        ),
      };
    });
}
