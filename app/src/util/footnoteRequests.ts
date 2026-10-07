/**
 * Ask GrokBot: a pending footnote on this device, an inbox row on the hub,
 * and the answer applied back here. The document is only written on the device.
 */

import { LcApiError, type FootnotePingResultDto, type FootnoteRequestDto, type LcClient } from "../api/client";
import { debugLog } from "./debugLog";
import type { DocAnchor } from "./docAnchors";
import { getAnnotateDoc, saveAnnotateDoc } from "./annotateStore";
import {
  freshNoteId,
  type DocFootnote,
  type DocFootnoteNote,
  type DocFootnoteUserLink,
} from "./docFootnotes";

const QUEUE_KEY = "whiteboard.footnoteRequests.v1";
const AWAITING_KEY = "whiteboard.footnoteAwaiting.v1";
const CONTEXT_RADIUS = 1500;
const WIDE_RADIUS = 6000;
const PAGE_FOOTNOTE_CAP = 20;
const PAGE_FOOTNOTE_BYTES = 16000;

export const FOOTNOTE_REJECTED_NOTE = "The request was rejected.";
export const FOOTNOTE_UNSENT_NOTE = "Not sent to GrokBot: this document has not been saved yet.";

export type FootnoteWriteResult = "saved" | "gone" | "failed" | "miss";

export interface OpenAnnotateFootnoteSink {
  docId(): string | null;
  write(
    docId: string,
    mutate: (footnotes: readonly DocFootnote[]) => DocFootnote[],
  ): Promise<FootnoteWriteResult>;
}

interface AwaitingRow {
  id: string;
  docId: string;
}

const sinks = new Set<OpenAnnotateFootnoteSink>();
let inboxChain: Promise<void> = Promise.resolve();

export function registerOpenAnnotateFootnotes(sink: OpenAnnotateFootnoteSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function freshFootnoteRequestId(now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `fr-${now.toString(36)}-${rand}`;
}

export function sliceAround(pageText: string, excerpt: string, radius: number): string {
  if (!pageText) return "";
  const at = excerpt ? pageText.indexOf(excerpt) : -1;
  if (at < 0) return pageText.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(pageText.length, at + excerpt.length + radius);
  return pageText.slice(start, end);
}

export function pageNumberFor(
  scope: string | undefined,
  pages: readonly { page: number; scope?: string }[] | null,
  viewerPage: number | null,
): number | null {
  if (scope && pages) {
    const hit = pages.find((entry) => entry.scope === scope);
    if (hit && Number.isInteger(hit.page) && hit.page > 0) return hit.page;
  }
  const matched = scope?.match(/^p(\d+)r?$/);
  if (matched) {
    const n = Number(matched[1]);
    if (n > 0) return n;
  }
  if (viewerPage != null && Number.isInteger(viewerPage) && viewerPage > 0) return viewerPage;
  if (pages?.length === 1 && pages[0]!.page > 0) return pages[0]!.page;
  return null;
}

export function pageFootnotesFor(
  footnotes: readonly DocFootnote[],
  scope: string | undefined,
  exceptId: string,
): Array<{ excerpt: string; notes: string[] }> {
  const wanted = scope ?? "";
  const entries = footnotes
    .filter((entry) => entry.id !== exceptId && (entry.anchor.scope ?? "") === wanted)
    .slice(0, PAGE_FOOTNOTE_CAP)
    .map((entry) => ({
      excerpt: entry.excerpt,
      notes: (entry.notes ?? []).map((note) => note.text).filter((text) => text.trim().length > 0),
    }));
  const bytes = () => new TextEncoder().encode(JSON.stringify(entries)).length;
  let guard = 0;
  while (entries.length > 0 && bytes() > PAGE_FOOTNOTE_BYTES && guard < 1000) {
    guard += 1;
    const last = entries[entries.length - 1]!;
    if (last.notes.length > 0) {
      const tail = last.notes[last.notes.length - 1]!;
      if (tail.length > 40) last.notes[last.notes.length - 1] = tail.slice(0, Math.floor(tail.length / 2));
      else last.notes.pop();
    } else if (last.excerpt.length > 40) {
      last.excerpt = last.excerpt.slice(0, Math.floor(last.excerpt.length / 2));
    } else {
      entries.pop();
    }
  }
  return entries;
}

export function buildFootnoteRequest(input: {
  id: string;
  deviceId: string;
  docId: string;
  docName: string;
  anchor: DocAnchor;
  excerpt: string;
  pageText: string | null;
  pages: readonly { page: number; scope?: string }[] | null;
  viewerPage: number | null;
  footnotes: readonly DocFootnote[];
  exceptId: string;
}): FootnoteRequestDto {
  const excerpt = input.excerpt.slice(0, 4000);
  const pageText = input.pageText ?? "";
  const scope = input.anchor.scope;
  return {
    id: input.id,
    device_id: input.deviceId,
    doc_id: input.docId,
    doc_name: input.docName,
    page: pageNumberFor(scope, input.pages, input.viewerPage),
    anchor: input.anchor,
    excerpt,
    context: sliceAround(pageText, excerpt, CONTEXT_RADIUS).slice(0, 8000),
    wide_context: sliceAround(pageText, excerpt, WIDE_RADIUS).slice(0, 24000),
    page_footnotes: pageFootnotesFor(input.footnotes, scope, input.exceptId),
    prompt: null,
  };
}

/**
 * Fill the pending footnote that asked for `result.id`.
 *
 * Reader notes already on the mark stay first. The same link url is not added twice.
 * No matching pending mark returns the same list.
 */
export function applyFootnoteResult(
  footnotes: readonly DocFootnote[],
  result: { id: string; notes?: readonly string[] | null; links?: readonly { title?: string; url?: string }[] | null },
  now = Date.now(),
): DocFootnote[] {
  const index = footnotes.findIndex((entry) => entry.pending === result.id);
  if (index < 0) return footnotes as DocFootnote[];
  const entry = footnotes[index]!;
  const existing = entry.notes ?? [];
  const added: DocFootnoteNote[] = [];
  for (const raw of result.notes ?? []) {
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (!text) continue;
    added.push({
      id: freshNoteId([...existing, ...added], now),
      text,
      createdAt: now,
      updatedAt: now,
    });
  }
  const notes = existing.length + added.length > 0 ? [...existing, ...added] : undefined;
  const userLinks = mergeLinks(entry.userLinks, result.links);
  const rest = { ...entry };
  delete rest.pending;
  const next: DocFootnote = {
    ...rest,
    ...(notes ? { notes } : {}),
    ...(userLinks ? { userLinks } : {}),
  };
  return footnotes.map((item, at) => (at === index ? next : item));
}

function mergeLinks(
  existing: readonly DocFootnoteUserLink[] | undefined,
  incoming: readonly { title?: string; url?: string }[] | null | undefined,
): DocFootnoteUserLink[] | undefined {
  const out: DocFootnoteUserLink[] = existing ? existing.map((link) => ({ ...link })) : [];
  const seen = new Set(out.map((link) => link.url));
  for (const link of incoming ?? []) {
    const url = typeof link.url === "string" ? link.url.trim() : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = link.title?.trim();
    out.push(title ? { title, url } : { url });
  }
  return out.length > 0 ? out : undefined;
}

function readJson(key: string): unknown {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing — the mark stays pending in the open document */
  }
}

function loadQueue(): FootnoteRequestDto[] {
  const parsed = readJson(QUEUE_KEY);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is FootnoteRequestDto => {
    if (!entry || typeof entry !== "object") return false;
    const row = entry as Partial<FootnoteRequestDto>;
    return typeof row.id === "string" && typeof row.doc_id === "string";
  });
}

function loadAwaiting(): AwaitingRow[] {
  const parsed = readJson(AWAITING_KEY);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is AwaitingRow => {
    if (!entry || typeof entry !== "object") return false;
    const row = entry as Partial<AwaitingRow>;
    return typeof row.id === "string" && typeof row.docId === "string";
  });
}

export function enqueueFootnoteRequest(body: FootnoteRequestDto): void {
  const queue = loadQueue().filter((entry) => entry.id !== body.id);
  queue.push(body);
  writeJson(QUEUE_KEY, queue);
  const waiting = loadAwaiting().filter((entry) => entry.id !== body.id);
  waiting.push({ id: body.id, docId: body.doc_id });
  writeJson(AWAITING_KEY, waiting);
}

export function footnoteInboxNeedsPoll(): boolean {
  return loadQueue().length > 0 || loadAwaiting().length > 0;
}

function forgetAwaiting(id: string): void {
  writeJson(AWAITING_KEY, loadAwaiting().filter((entry) => entry.id !== id));
}

function forgetQueued(id: string): void {
  writeJson(QUEUE_KEY, loadQueue().filter((entry) => entry.id !== id));
}

function sinksFor(docId: string): OpenAnnotateFootnoteSink[] {
  const matches: OpenAnnotateFootnoteSink[] = [];
  for (const sink of sinks) {
    if (sink.docId() === docId) matches.push(sink);
  }
  return matches;
}

async function writeFootnotes(
  docId: string,
  mutate: (footnotes: readonly DocFootnote[]) => DocFootnote[],
): Promise<FootnoteWriteResult> {
  const matches = sinksFor(docId);
  let openWithoutMark = false;
  if (matches.length > 0) {
    let saved = false;
    let failed = false;
    for (const sink of matches) {
      const outcome = await sink.write(docId, mutate);
      if (outcome === "saved") saved = true;
      else if (outcome === "failed") failed = true;
      else if (outcome === "gone") openWithoutMark = true;
    }
    if (failed) return "failed";
    if (saved) return "saved";
  }
  let doc;
  try {
    doc = await getAnnotateDoc(docId);
  } catch {
    return "failed";
  }
  if (!doc) return "gone";
  const current = doc.footnotes ?? [];
  const next = mutate(current);
  if (next === current) return "gone";
  // The open editor is still loading, or holds an edit not yet saved; its
  // autosave would overwrite a write here. Ask again on the next ping.
  if (openWithoutMark) return "failed";
  try {
    await saveAnnotateDoc({
      id: doc.id,
      name: doc.name,
      hash: doc.hash,
      docType: doc.docType,
      label: doc.label,
      owned: doc.owned,
      source: doc.source,
      board: doc.board,
      footnotes: next,
      agent: Array.isArray(doc.agent) ? doc.agent : undefined,
      captures: doc.captures,
      padKind: doc.padKind,
      artifacts: doc.artifacts,
    });
    return "saved";
  } catch {
    return "failed";
  }
}

function isClientError(cause: unknown): boolean {
  return cause instanceof LcApiError && cause.status >= 400 && cause.status < 500;
}

async function flushBody(client: LcClient): Promise<void> {
  const queue = loadQueue();
  if (queue.length === 0) return;
  for (const item of queue) {
    try {
      await client.postFootnoteRequest(item);
      // Remove this id from the live queue. Writing the snapshot's remainder
      // would erase a request enqueued while the POST was in flight.
      forgetQueued(item.id);
    } catch (cause) {
      if (!isClientError(cause)) continue;
      const cleared = await writeFootnotes(item.doc_id, (footnotes) =>
        applyFootnoteResult(footnotes, { id: item.id, notes: [FOOTNOTE_REJECTED_NOTE] }),
      );
      if (cleared === "failed") continue;
      forgetQueued(item.id);
      forgetAwaiting(item.id);
    }
  }
}

function answerOf(result: FootnotePingResultDto["result"]): { notes: string[]; links: { title?: string; url: string }[] } | null {
  if (!result || typeof result !== "object") return null;
  const notes = Array.isArray(result.notes) ? result.notes.filter((note): note is string => typeof note === "string") : null;
  if (!notes) return null;
  const links = Array.isArray(result.links)
    ? result.links.flatMap((link) => {
        if (!link || typeof link !== "object") return [];
        const url = typeof link.url === "string" ? link.url : "";
        const title = typeof link.title === "string" ? link.title : undefined;
        return url ? [{ url, ...(title ? { title } : {}) }] : [];
      })
    : [];
  return { notes, links };
}

async function applyResults(client: LcClient, results: readonly FootnotePingResultDto[]): Promise<void> {
  for (const row of results) {
    if (!row || typeof row.id !== "string" || typeof row.doc_id !== "string") continue;
    const answer = answerOf(row.result);
    if (!answer) continue;
    const outcome = await writeFootnotes(row.doc_id, (footnotes) =>
      applyFootnoteResult(footnotes, { id: row.id, notes: answer.notes, links: answer.links }),
    );
    if (outcome === "failed") continue;
    try {
      await client.ackFootnoteRequest(row.id);
      forgetAwaiting(row.id);
    } catch {
      /* the next ping acks again; applying a cleared mark is a no-op */
    }
  }
}

function enqueueWork(work: () => Promise<void>): Promise<void> {
  const run = inboxChain.then(work);
  inboxChain = run.catch(() => {});
  return run;
}

export function flushFootnoteQueue(client: LcClient): Promise<void> {
  return enqueueWork(() => flushBody(client));
}

export function applyFootnotePing(
  client: LcClient,
  ping: { footnote_results?: readonly FootnotePingResultDto[] | null },
): Promise<void> {
  const results = Array.isArray(ping.footnote_results) ? ping.footnote_results : [];
  return enqueueWork(async () => {
    await flushBody(client);
    await applyResults(client, results);
  });
}

let loggedMissingResultsEndpoint = false;

export async function pollFootnoteInbox(client: LcClient): Promise<void> {
  if (!footnoteInboxNeedsPoll()) return;
  let results: FootnotePingResultDto[];
  try {
    results = await client.footnoteResults();
  } catch (cause) {
    // An old hub has no /footnote-results. Leave the queue for the next poll
    // and do not fall back to a full pad sync.
    if (cause instanceof LcApiError && cause.status === 404 && !loggedMissingResultsEndpoint) {
      loggedMissingResultsEndpoint = true;
      debugLog({ k: "error", n: "footnote-results", e: "hub has no /footnote-results" });
    }
    return;
  }
  try {
    await applyFootnotePing(client, { footnote_results: results });
  } catch {
    /* a down hub stays queued; a 4xx is handled inside the flush */
  }
}
