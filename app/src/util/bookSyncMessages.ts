/** Reader-facing atomic-sync messages. Protocol identities stay in diagnostics. */
import type { BookResult } from "./bookSync";
import type { BookPassNotice, BookPassResult } from "./bookSyncPass";
import type { BookIdentity, BookMeta } from "./syncState";
import { getCachedBookMeta } from "./localBookStore";

export interface BookDisplay { title: string; scratchTitles: Record<string, string> }
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
export function bookDisplay(owner: BookIdentity, metadata?: BookMeta | null, record?: Record<string, unknown> | null): BookDisplay {
  const meta = metadata ?? getCachedBookMeta<BookMeta>(owner.kind, owner.id);
  const title = text(meta?.label) ?? text(meta?.title) ?? text(meta?.name) ?? text(record?.label) ?? text(record?.title) ?? text(record?.name)
    ?? (owner.kind === "problem" ? "Problem board" : "Book");
  const scratchTitles: Record<string, string> = {};
  for (const note of Array.isArray(record?.footnotes) ? record.footnotes : []) {
    for (const board of Array.isArray(note?.whiteboards) ? note.whiteboards : []) if (typeof board?.id === "string") scratchTitles[board.id] = text(board.title) ?? "Scratch board";
  }
  return { title, scratchTitles };
}
/** Positive shard IDs already use the PDF/notebook counter's one-based IDs.
 * Zero is the shared spanning shard, never a displayed page zero. */
export function bookPageLabel(book: BookIdentity, page: { key: string; pageId: number }, display = bookDisplay(book), withPage = true): string {
  const number = page.pageId === 0 ? "across page boundaries" : Number.isSafeInteger(page.pageId) && page.pageId > 0 ? String(page.pageId) : "unknown";
  const scratch = page.key !== book.id ? display.scratchTitles[page.key.slice(`${book.id}/fn/`.length)] ?? "Scratch board" : null;
  return `${scratch ? `${scratch} ` : ""}${withPage && page.pageId !== 0 ? "page " : ""}${number}`;
}
export function bookFailureMessage(book: BookResult, libraryPull = false): string {
  const display = book.display ?? bookDisplay(book), title = display.title, error = book.error;
  const page = error?.pages[0], label = page ? bookPageLabel(book, page, display) : "handwriting";
  switch (error?.kind) {
    case "unreachable": return "Can't reach the hub. Is the desktop app open?";
    case "stage": {
      const pages = error.pages.length > 5 ? error.pages.slice(0, 3) : error.pages;
      const list = pages.map(page => bookPageLabel(book, page, display, page.key !== book.id)).join(", ");
      return `${title}: pages ${list}${error.pages.length > 5 ? ` and ${error.pages.length - 3} more` : ""} didn't upload (no response).`;
    }
    case "unconfirmed": return `${title}: the hub didn't confirm this sync. Sync again.`;
    case "hub_changed": return `${title} changed on the hub. Sync again.`;
    case "local_changed": return `${title} changed on this device during sync. Sync again.`;
    case "needs_choice": return `${title}: needs your choice. Open it and sync again.`;
    case "merge_mount": return `${title}: couldn't open the merge window.`;
    case "local_page": return `${title}: ${label} can't be read on this device.`;
    case "hub_page": return libraryPull && error.missing ? `${title}: ${label} isn't on the hub yet. Sync the other device.` : `${title}: ${label} can't be read from the hub.`;
    case "missing_staging": return `${title}: ${label} couldn't be staged.`;
    case "dependency": return `${title}: the source file or attachment didn't upload.`;
    case "gone": return `${title} was deleted on another device. Your local copy is kept.`;
    case "cap": {
      const cause = error.cause as { json?: { limit?: number }; message?: string } | undefined;
      const limit = cause?.json?.limit ?? cause?.message?.match(/\((\d+)\)/)?.[1] ?? "unknown limit";
      return `The hub library is full (${limit}).`;
    }
    case "storage": return `${title}: local storage isn't ready for safe sync. Your changes are kept on this device.`;
    default: return `${title}: sync couldn't finish. Your local copy is kept.`;
  }
}
export function bookConflictMessage(book: BookIdentity, page: { key: string; pageId: number }, display: BookDisplay): string {
  return `${display.title}: ${bookPageLabel(book, page, display)} changed here and on the hub.`;
}
export function bookNoticeMessage(notice: BookPassNotice): string {
  if (notice.kind === "old_hub") return "Update the desktop app to sync safely.";
  if (notice.kind === "links") return "Links didn't sync.";
  return `${notice.title ?? (notice.book ? bookDisplay(notice.book).title : "Book")}: snapshots didn't sync. They are kept on this device.`;
}
export function bookPassSummary(pass: BookPassResult, libraryPull = false): string | null {
  const failed = pass.books.filter(book => book.status === "failed" || book.status === "needs_choice");
  if (!failed.length) return null;
  const success = pass.books.filter(book => book.status === "synced" || book.status === "unchanged").length;
  return `Synced ${success} books. ${failed.length} failed: ${bookFailureMessage(failed[0]!, libraryPull)}`;
}
