/**
 * What an annotate save treats as clean, and which held GrokBot asks that
 * save is allowed to send.
 *
 * The live footnote list can change while the write is in flight. The
 * pristine revision has to be the footnotes that write actually stored.
 */

import { footnoteRevision, type DocFootnote } from "./docFootnotes";
import type { FootnoteWriteResult } from "./footnoteRequests";

export function pristineMarksFromSaved(
  saved: { footnotes?: readonly DocFootnote[] | null },
): string {
  return footnoteRevision(saved.footnotes ?? []);
}

export function footnoteMarksDirty(
  live: readonly DocFootnote[],
  pristine: string,
): boolean {
  return footnoteRevision(live) !== pristine;
}

/**
 * Footnotes the next autosave or leave should write.
 * Null means they already match the last successful save, so that write is skipped.
 */
export function footnotesPendingSave(
  live: readonly DocFootnote[],
  pristine: string,
): readonly DocFootnote[] | null {
  if (!footnoteMarksDirty(live, pristine)) return null;
  return live;
}

export type HeldFootnoteAsk = {
  requestId: string;
  footnoteId: string;
};

export function partitionHeldAsks(
  held: readonly HeldFootnoteAsk[],
  saved: { footnotes?: readonly DocFootnote[] | null },
  live: readonly DocFootnote[],
): { send: HeldFootnoteAsk[]; keep: HeldFootnoteAsk[] } {
  const savedPending = new Set(
    (saved.footnotes ?? []).flatMap((entry) => (entry.pending ? [entry.pending] : [])),
  );
  const livePending = new Set(
    live.flatMap((entry) => (entry.pending ? [entry.pending] : [])),
  );
  const send: HeldFootnoteAsk[] = [];
  const keep: HeldFootnoteAsk[] = [];
  for (const ask of held) {
    if (savedPending.has(ask.requestId)) send.push(ask);
    else if (livePending.has(ask.requestId)) keep.push(ask);
  }
  return { send, keep };
}

type SavedRecord = { id: string; footnotes?: readonly DocFootnote[] | null };

/**
 * Pin the clean revision to the footnotes just stored, and release only the
 * held asks whose pending mark is in that record.
 *
 * A null save changes nothing: the editor keeps its notes, and an unsent ask
 * stays held for a later save that actually contains it.
 */
export function completeAnnotateSave(input: {
  saved: SavedRecord | null;
  live: readonly DocFootnote[];
  pristine: { current: string };
  held: readonly HeldFootnoteAsk[];
}): { send: HeldFootnoteAsk[]; keep: HeldFootnoteAsk[] } {
  if (!input.saved) return { send: [], keep: [...input.held] };
  input.pristine.current = pristineMarksFromSaved(input.saved);
  return partitionHeldAsks(input.held, input.saved, input.live);
}

/**
 * Open-document sink write.
 *
 * The pristine revision is the record `save` stored, not the live list after
 * that write returns. A failed save leaves both the editor and the previous
 * pristine revision alone.
 */
export async function settleOpenFootnoteWrite(input: {
  docId: string;
  openDocId: string | null;
  live: { current: DocFootnote[] };
  pristine: { current: string };
  mutate: (footnotes: readonly DocFootnote[]) => DocFootnote[];
  publish: (next: DocFootnote[]) => void;
  save: () => Promise<SavedRecord | null>;
}): Promise<FootnoteWriteResult> {
  if (input.openDocId !== input.docId) return "miss";
  const current = input.live.current;
  const next = input.mutate(current);
  if (next === current) return "gone";
  input.publish(next);
  try {
    const saved = await input.save();
    if (!saved) return "failed";
    input.pristine.current = pristineMarksFromSaved(saved);
    return "saved";
  } catch {
    return "failed";
  }
}
