/** Root wire fields translated separately; nested user objects stay intact. */
const translated = new Set([
  "id", "name", "label", "hash", "doc_type", "updated_at", "deleted_at", "sync_seq",
  "page_count", "title", "dataset", "task_id", "board", "agent", "source", "footnotes",
  "footnote_boards", "artifacts", "rev", "base_rev", "base_updated_at",
  "record_rev", "book_rev", "record_hash",
  "upload_id", "request_hash",
]);

export function recordAuthoredExtras(record: unknown): Record<string, unknown> {
  if (!record || typeof record !== "object" || Array.isArray(record)) return {};
  return Object.fromEntries(Object.entries(record).filter(([key]) => !translated.has(key)));
}
