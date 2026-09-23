import type { AgentChatMessage } from "./AgentSidePanel";
import { restoreMessageDrawing } from "../viz/drawingState";
import { sanitizeArtifactRefs } from "../util/padArtifacts";
import { sanitizeArtifactProposals } from "../util/agentArtifacts";
import { organizeIntoSessions } from "./coachSessions";

export function restoreAgentMessages(stored: unknown[]): AgentChatMessage[] {
  if (!Array.isArray(stored)) return [];
  return organizeIntoSessions(stored.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const message = entry as Partial<AgentChatMessage> & { drawing?: unknown };
    if (typeof message.id !== "string" || typeof message.role !== "string") return [];
    // Older builds could persist an in-flight placeholder. Drop it — a turn
    // stuck on "Working…" would wait for a socket that will never answer.
    if (message.pending && !message.requestState && !message.deletedAt) return [];
    const drawing = restoreMessageDrawing(message.drawing);
    const artifacts = sanitizeArtifactRefs(message.artifacts);
    const artifactProposals = sanitizeArtifactProposals(message.artifactProposals);
    const rawContent = typeof message.content === "string" ? message.content : "";
    const content = message.requestState === "cancelled" && rawContent.trim().toLowerCase() === "cancelled"
      ? ""
      : rawContent;
    const requestNote = typeof message.requestNote === "string" && message.requestNote.trim()
      ? message.requestNote.trim()
      : undefined;
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
    // Validate the fields used by the UI while retaining future message fields.
    const raw = message.replyTo;
    const replyTo =
      raw &&
      typeof raw.id === "string" &&
      typeof raw.role === "string" &&
      typeof raw.excerpt === "string"
        ? { ...raw, id: raw.id, role: raw.role as AgentChatMessage["role"], excerpt: raw.excerpt }
        : undefined;
    const sessionId = typeof message.sessionId === "string" && message.sessionId ? message.sessionId : undefined;
    const deletedAt = typeof message.deletedAt === "number" && message.deletedAt > 0 ? message.deletedAt : undefined;
    // A removed turn stays in the stored transcript so another device can
    // learn that it is gone. Dropping it here would bring the bubble back
    // the next time this replica saved.
    if (deletedAt) {
      const tombstone: AgentChatMessage = {
        ...message,
        id: message.id,
        role: message.role as AgentChatMessage["role"],
        content,
        at: typeof message.at === "number" ? message.at : Date.now(),
        deletedAt,
        pending: false,
        queued: undefined,
        ...(sessionId ? { sessionId } : {}),
        ...(replyTo ? { replyTo } : {}),
      };
      return [tombstone];
    }
    // Empty assistant shells left after stripping `pending` are noise.
    if (
      message.role === "assistant" &&
      !content.trim() &&
      !message.review &&
      !message.bridge &&
      !message.attachments?.length &&
      !artifacts?.length &&
      !artifactProposals?.length &&
      !drawing &&
      !processEvents?.length &&
      !reasoning
      && !message.requestState
    ) {
      return [];
    }
    return [
      {
        ...message,
        id: message.id,
        role: message.role as AgentChatMessage["role"],
        content,
        at: typeof message.at === "number" ? message.at : Date.now(),
        requestId: message.requestId, retryOf: message.retryOf,
        requestState: message.requestState && ["preparing", "queued", "running"].includes(message.requestState)
          ? "interrupted" : message.requestState,
        ...(message.pending !== undefined || message.requestState ? { pending: false } : {}),
        queued: undefined,
        ...(requestNote ? { requestNote } : {}),
        review: message.review,
        bridge: message.bridge,
        attachments: message.attachments,
        ...(artifacts ? { artifacts } : {}),
        ...(artifactProposals ? { artifactProposals } : {}),
        ...(Array.isArray(message.artifactFootnoteIds) ? { artifactFootnoteIds: message.artifactFootnoteIds.filter(id => typeof id === "string") } : {}),
        ...(flags && flags.length > 0 ? { flags } : {}),
        ...(processEvents ? { processEvents } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(drawing ? { drawing } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    ];
  }));
}

/**
 * The thread as it should be stored, which is not the thread as it is shown.
 *
 * Tracked requests persist so reload can show them as interrupted; only legacy
 * placeholders without a request state go. An attached photo drops to its
 * thumbnail: `png` is sized for a vision model —
 * 1568px, 3–5.5 MB base64 — and it has already been sent by the time anything
 * persists. Keeping it would mean four photos on one message costing more than
 * the entire localStorage budget, forever, to redisplay an image the bubble
 * draws at 320px anyway.
 */
export function persistableAgentMessages(messages: AgentChatMessage[]): AgentChatMessage[] {
  return organizeIntoSessions(messages)
    .filter((message) => !message.pending || Boolean(message.requestState) || Boolean(message.deletedAt))
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
