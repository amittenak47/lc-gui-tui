import type { DocFootnote } from "./docFootnotes";

/** Missing messages may be unloaded; only an explicit tombstone removes a link. */
export function pruneDeletedThreadLinks(notes: DocFootnote[], messages: readonly unknown[]): DocFootnote[] {
  const deleted = new Set(messages.flatMap(value => {
    const row = value as {id?: unknown; deletedAt?: unknown} | null;
    return row && typeof row.id === "string" && typeof row.deletedAt === "number" && row.deletedAt > 0 ? [row.id] : [];
  }));
  if (!deleted.size) return notes;
  let changed = false;
  const result = notes.map(note => {
    if (!note || !note.threads?.some(thread => deleted.has(thread.rootId)) && !(note.threadRootId && deleted.has(note.threadRootId))) return note;
    changed = true;
    const threads = note.threads?.filter(thread => !deleted.has(thread.rootId));
    return {...note,threads,threadRootId: note.threadRootId && deleted.has(note.threadRootId) ? threads?.[0]?.rootId : note.threadRootId};
  });
  return changed ? result : notes;
}
