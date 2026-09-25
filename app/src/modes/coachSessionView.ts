/**
 * Where the reader was in each coach session, kept across reload.
 *
 * One bucket per pad (and per scratch board). Session ids are the keys inside
 * a bucket, so switching problems does not mix their drafts or scroll offsets.
 */

const STORAGE_KEY = "whiteboard.agent.sessionView.v1";

export interface CoachSessionComposerPlace {
  start: number;
  end: number;
  scroll: number;
}

export interface CoachSessionScroll {
  top: number;
  pinned: boolean;
}

export interface CoachSessionReply {
  id: string;
  role: "user" | "assistant" | "system" | "app";
  excerpt: string;
}

export interface CoachSessionView {
  pickedSessionId: string | null;
  newSessionId: string | null;
  drafts: Record<string, string>;
  threads: Record<string, string>;
  replies: Record<string, CoachSessionReply>;
  composer: Record<string, CoachSessionComposerPlace>;
  scroll: Record<string, CoachSessionScroll>;
}

export function emptyCoachSessionView(): CoachSessionView {
  return {
    pickedSessionId: null,
    newSessionId: null,
    drafts: {},
    threads: {},
    replies: {},
    composer: {},
    scroll: {},
  };
}

function storage(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    return null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function draftsOf(value: unknown): Record<string, string> {
  const source = record(value);
  if (!source) return {};
  const drafts: Record<string, string> = {};
  for (const [id, draft] of Object.entries(source)) {
    if (!text(id) || typeof draft !== "string" || draft.length === 0) continue;
    drafts[id] = draft;
  }
  return drafts;
}

function threadsOf(value: unknown): Record<string, string> {
  const source = record(value);
  if (!source) return {};
  const threads: Record<string, string> = {};
  for (const [id, threadId] of Object.entries(source)) {
    const thread = text(threadId);
    if (text(id) && thread) threads[id] = thread;
  }
  return threads;
}

function repliesOf(value: unknown): Record<string, CoachSessionReply> {
  const source = record(value);
  if (!source) return {};
  const replies: Record<string, CoachSessionReply> = {};
  for (const [sessionId, raw] of Object.entries(source)) {
    const reply = record(raw);
    const id = text(reply?.id);
    const excerpt = typeof reply?.excerpt === "string" ? reply.excerpt : null;
    const role = reply?.role;
    if (!text(sessionId) || !id || excerpt == null) continue;
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "app") continue;
    replies[sessionId] = { id, role, excerpt };
  }
  return replies;
}

function composerOf(value: unknown): Record<string, CoachSessionComposerPlace> {
  const source = record(value);
  if (!source) return {};
  const composer: Record<string, CoachSessionComposerPlace> = {};
  for (const [id, raw] of Object.entries(source)) {
    const place = record(raw);
    const start = finite(place?.start);
    const end = finite(place?.end);
    const scroll = finite(place?.scroll);
    if (!text(id) || start == null || end == null || scroll == null) continue;
    composer[id] = { start, end, scroll };
  }
  return composer;
}

function scrollOf(value: unknown): Record<string, CoachSessionScroll> {
  const source = record(value);
  if (!source) return {};
  const scroll: Record<string, CoachSessionScroll> = {};
  for (const [id, raw] of Object.entries(source)) {
    const place = record(raw);
    const top = finite(place?.top);
    if (!text(id) || top == null || place?.pinned !== false) continue;
    scroll[id] = { top, pinned: false };
  }
  return scroll;
}

function viewOf(value: unknown): CoachSessionView {
  const source = record(value);
  if (!source) return emptyCoachSessionView();
  return {
    pickedSessionId: text(source.pickedSessionId),
    newSessionId: text(source.newSessionId),
    drafts: draftsOf(source.drafts),
    threads: threadsOf(source.threads),
    replies: repliesOf(source.replies),
    composer: composerOf(source.composer),
    scroll: scrollOf(source.scroll),
  };
}

function readAll(): Record<string, unknown> {
  const store = storage();
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? "{}") as unknown;
    return record(parsed) ?? {};
  } catch {
    return {};
  }
}

export function loadCoachSessionView(scope: string): CoachSessionView {
  if (!scope) return emptyCoachSessionView();
  return viewOf(readAll()[scope]);
}

export function saveCoachSessionView(scope: string, view: CoachSessionView): void {
  if (!scope) return;
  const store = storage();
  if (!store) return;
  try {
    const all = readAll();
    const next = viewOf(view);
    const blank = !next.pickedSessionId && !next.newSessionId
      && Object.keys(next.drafts).length === 0
      && Object.keys(next.threads).length === 0
      && Object.keys(next.replies).length === 0
      && Object.keys(next.composer).length === 0
      && Object.keys(next.scroll).length === 0;
    if (blank) delete all[scope];
    else all[scope] = next;
    if (Object.keys(all).length === 0) store.removeItem(STORAGE_KEY);
    else store.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* A full or blocked store still leaves the in-memory place intact. */
  }
}
