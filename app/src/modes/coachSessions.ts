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
  if (!messages.some((message) => !message.sessionId)) return messages as AgentChatMessage[];

  const sessionOf = new Map<string, string>();
  for (const message of messages) {
    if (message.sessionId) sessionOf.set(message.id, message.sessionId);
  }
  let current: string | null = null;
  let changed = false;
  const next = messages.map((message) => {
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

/** A stable rail even when replicas appended offline questions in different orders. */
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
  })).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export function replyChainIds(messages: readonly AgentChatMessage[], root: string): Set<string> {
  const ids = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      if (message.replyTo && ids.has(message.replyTo.id) && !ids.has(message.id)) {
        ids.add(message.id);
        changed = true;
      }
    }
  }
  return ids;
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
  if (copy.pending === false) delete copy.pending;
  if (copy.queued === false) delete copy.queued;
  return copy;
}

/** Object key order is not authored content. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

function conflictId(id: string, value: unknown): string {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(canonical(withoutSessionId(value)))) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  }
  return `${id}-conflict-${hash.toString(16).padStart(8, "0")}`;
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
export function mergeAgentMessages(local: unknown[], remote: unknown[], preserveConflicts = true): unknown[] {
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
      const winner = remoteDeleted >= localDeleted ? value : current;
      rows[at] = { ...(current as object), ...(value as object), ...(structuredClone(winner) as object), pending: false };
      continue;
    }
    const here = current as Record<string, unknown>, there = value as Record<string, unknown>;
    if (here.requestState === "cancelled" || there.requestState === "cancelled") {
      const stopped = there.requestState === "cancelled" ? there : here;
      rows[at] = { ...here, ...there, ...structuredClone(stopped), pending: false };
      continue;
    }
    if (canonical(withoutSessionId(current)) === canonical(withoutSessionId(value))) {
      const sessionId = sessionIdOf(current) || sessionIdOf(value);
      const base = structuredClone(sessionIdOf(current) ? current : value);
      if (sessionId && base && typeof base === "object") (base as { sessionId?: string }).sessionId = sessionId;
      rows[at] = base;
      continue;
    }
    if (!preserveConflicts) {
      rows[at] = { ...here, ...structuredClone(there) };
      continue;
    }
    const extra = structuredClone(value) as { id?: string };
    extra.id = conflictId(id, value);
    if (!rows.some(row => messageId(row) === extra.id)) rows.push(extra);
  }
  // A replica may have authored a reply before it learned its parent was deleted.
  // Propagate the tombstone after union, including chains arriving out of order.
  const deleted = new Map(rows.map(row => [messageId(row), deletedAtOf(row)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index] as { id?: string; replyTo?: { id?: string }; deletedAt?: number } | null;
      if (!row || typeof row !== "object") continue;
      const parent = row.replyTo?.id ? deleted.get(row.replyTo.id) ?? 0 : 0;
      if (parent > deletedAtOf(row)) {
        rows[index] = { ...row, deletedAt: parent, pending: false };
        deleted.set(messageId(row), parent);
        changed = true;
      }
    }
  }
  return rows;
}
