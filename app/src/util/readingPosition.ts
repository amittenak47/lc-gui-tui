/**
 * Where a reader is in a PDF, saved as they read.
 *
 * The page a document reopens on lived only in its saved session, and a
 * session is saved when something in it changes — ink, notes, a rename —
 * not when a page is turned. Reading without writing, then the app being
 * killed in the background, brought the book back pages behind. This is
 * the reading place alone, small and saved on every settled turn.
 *
 * Saved on this device, by document id; the most recent few hundred kept.
 */

const KEY = "lc-reading-page.v1";
const KEEP = 300;

type Places = Record<string, { page: number; at: number }>;

function load(): Places {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Places) : {};
  } catch {
    return {};
  }
}

/**
 * The page this document was last read at here, or 0 — when that reading is
 * newer than `savedAt` (the session's own last save, which keeps its page
 * when it was saved after the reading).
 */
export function loadReadingPage(docId: string | null | undefined, savedAt = 0): number {
  if (!docId) return 0;
  const place = load()[docId];
  const page = Math.floor(Number(place?.page));
  if (!Number.isFinite(page) || page < 1) return 0;
  return Number(place?.at) > savedAt ? page : 0;
}

export function saveReadingPage(docId: string | null | undefined, page: number): void {
  if (!docId || !(page >= 1)) return;
  const places = load();
  if (places[docId]?.page === page) return;
  places[docId] = { page: Math.floor(page), at: Date.now() };
  const ids = Object.keys(places);
  if (ids.length > KEEP) {
    ids
      .sort((a, b) => places[a]!.at - places[b]!.at)
      .slice(0, ids.length - KEEP)
      .forEach((id) => delete places[id]);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(places));
  } catch {
    /* storage full or unavailable: the session's own page still stands */
  }
}
