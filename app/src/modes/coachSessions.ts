import type { AgentChatMessage } from "./AgentSidePanel";

export type SessionStatus = "failed" | "aborted" | "succeeded";

export interface CoachSessionSummary {
  id: string;
  /** First line of the question, clipped for the rail. */
  title: string;
  at: number;
  /** Latest settled turn. A send still in flight has none. */
  status?: SessionStatus;
}

/** Stable id: the same question always opens the same session. */
export function sessionIdFor(messageId: string): string {
  return `session-${messageId}`;
}

/**
 * Put every live turn in a session.
 *
 * A session is one question. A user message that is not answering something
 * already in the transcript starts one; the answer, notes, and replies that
 * follow stay with it until the next question. Turns that already carry a
 * session id keep it, so a later edit cannot reshuffle history.
 *
 * Returns the same array when nothing needs assigning.
 */
export function organizeIntoSessions(messages: readonly AgentChatMessage[]): AgentChatMessage[] {
  if (!messages.some((message) => !message.deletedAt && !message.sessionId)) return messages as AgentChatMessage[];

  const sessionOf = new Map<string, string>();
  for (const message of messages) {
    if (message.sessionId) sessionOf.set(message.id, message.sessionId);
  }
  let current: string | null = null;
  let changed = false;
  const next = messages.map((message) => {
    if (message.deletedAt) return message;
    if (message.sessionId) {
      current = message.sessionId;
      sessionOf.set(message.id, message.sessionId);
      return message;
    }
    const parent = message.replyTo ? sessionOf.get(message.replyTo.id) : undefined;
    let sessionId = parent;
    if (!sessionId && message.role === "user" && !message.replyTo) {
      sessionId = sessionIdFor(message.id);
    }
    if (!sessionId) {
      if (!current) current = sessionIdFor(message.id);
      sessionId = current;
    }
    current = sessionId;
    sessionOf.set(message.id, sessionId);
    changed = true;
    return { ...message, sessionId };
  });
  return changed ? next : (messages as AgentChatMessage[]);
}

function sessionTitle(group: readonly AgentChatMessage[]): string {
  const source = group.find((message) => message.role === "user" && message.content.trim())
    ?? group.find((message) => message.content.trim());
  const line = (source?.content ?? "Session").trim().split("\n").map((part) => part.trim()).find(Boolean) ?? "Session";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function sessionStatus(group: readonly AgentChatMessage[]): SessionStatus | undefined {
  for (let index = group.length - 1; index >= 0; index -= 1) {
    const state = group[index]?.requestState;
    if (state === "failed") return "failed";
    if (state === "cancelled" || state === "interrupted") return "aborted";
    if (state === "completed") return "succeeded";
    if (state === "running" || state === "preparing" || state === "queued") return undefined;
  }
  return undefined;
}

/** Pinned sessions stay at the top, in pin order. The rest keep transcript order. */
export function orderSessions<T extends { id: string }>(
  sessions: readonly T[],
  pinnedIds: readonly string[],
): T[] {
  const rank = new Map(pinnedIds.map((id, index) => [id, index]));
  return [...sessions].sort((a, b) => {
    const aRank = rank.get(a.id);
    const bRank = rank.get(b.id);
    if (aRank == null && bRank == null) return 0;
    if (aRank == null) return 1;
    if (bRank == null) return -1;
    return aRank - bRank;
  });
}

/** Sessions that still have something to show, in transcript order. */
export function listSessions(messages: readonly AgentChatMessage[]): CoachSessionSummary[] {
  const groups = new Map<string, AgentChatMessage[]>();
  for (const message of messages) {
    if (message.deletedAt || !message.sessionId) continue;
    const bucket = groups.get(message.sessionId);
    if (bucket) bucket.push(message);
    else groups.set(message.sessionId, [message]);
  }
  return [...groups.entries()].map(([id, group]) => ({
    id,
    title: sessionTitle(group),
    at: group[0]?.at ?? 0,
    status: sessionStatus(group),
  }));
}

function messageId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("id" in value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

function deletedAtOf(value: unknown): number {
  if (!value || typeof value !== "object" || !("deletedAt" in value)) return 0;
  const at = (value as { deletedAt?: unknown }).deletedAt;
  return typeof at === "number" && at > 0 ? at : 0;
}

function sessionIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("sessionId" in value)) return null;
  const id = (value as { sessionId?: unknown }).sessionId;
  return typeof id === "string" && id ? id : null;
}

function withoutSessionId(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.sessionId;
  return copy;
}

/**
 * Union two transcripts by id.
 *
 * A tombstone beats a live copy of the same id, so a delete on one side is
 * not undone by a replica that still has the bubble. A session id added on
 * one side is not a second message. A real disagreement still keeps both,
 * with the incoming copy under a fresh id — the same rule the problem-pad
 * merge used before tombstones existed.
 */
export function mergeAgentMessages(local: unknown[], remote: unknown[]): unknown[] {
  const rows = local.map((value) => structuredClone(value));
  const indexOf = new Map<string, number>();
  rows.forEach((value, index) => {
    const id = messageId(value);
    if (id) indexOf.set(id, index);
  });
  for (const value of remote) {
    const id = messageId(value);
    if (!id) {
      if (!rows.some((row) => JSON.stringify(row) === JSON.stringify(value))) rows.push(structuredClone(value));
      continue;
    }
    const at = indexOf.get(id);
    if (at == null) {
      indexOf.set(id, rows.length);
      rows.push(structuredClone(value));
      continue;
    }
    const current = rows[at];
    const localDeleted = deletedAtOf(current);
    const remoteDeleted = deletedAtOf(value);
    if (localDeleted || remoteDeleted) {
      rows[at] = structuredClone(remoteDeleted >= localDeleted ? value : current);
      continue;
    }
    if (JSON.stringify(withoutSessionId(current)) === JSON.stringify(withoutSessionId(value))) {
      const sessionId = sessionIdOf(current) || sessionIdOf(value);
      const base = structuredClone(sessionIdOf(current) ? current : value);
      if (sessionId && base && typeof base === "object") (base as { sessionId?: string }).sessionId = sessionId;
      rows[at] = base;
      continue;
    }
    const extra = structuredClone(value) as { id?: string };
    extra.id = crypto.randomUUID();
    rows.push(extra);
  }
  return rows;
}
