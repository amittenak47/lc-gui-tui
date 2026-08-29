/**
 * One open pdf.js document per file, however many things are reading it.
 *
 * Two jobs, and they used to be one. The settled map below is the *peek*: the
 * indexer and the conflict preview ask "is this file already open?" during
 * render and take the answer or move on, which is why it has to be
 * synchronous.
 *
 * The registry is the other half, and the reason it exists is a race the peek
 * cannot see. `getDocument` is async, so two readers that start in the same
 * commit both look, both find nothing, and both parse the file — which for a
 * conflict split over a textbook is the whole book, twice, on one worker, at
 * the moment the reader is already waiting. Joining an open that is *in
 * flight* is the only thing that closes that window.
 *
 * Refcounted rather than first-one-wins, because ownership of the loading task
 * would otherwise belong to whoever mounted first: the conflict pane that
 * opened the file would `destroy()` on unmount while its partner was still
 * drawing from the same document. The last holder tears it down.
 */

type PdfJsDocument = Awaited<
  ReturnType<typeof import("pdfjs-dist").getDocument>["promise"]
>;

/** Just enough of `PDFDocumentLoadingTask` to own its teardown. */
export interface PdfLoadingTask {
  destroy(): unknown;
}

const lent = new Map<string, PdfJsDocument>();

export function lendPdfDocument(hash: string, doc: PdfJsDocument): void {
  if (!hash) return;
  lent.set(hash, doc);
}

export function borrowPdfDocument(hash: string): PdfJsDocument | null {
  if (!hash) return null;
  return lent.get(hash) ?? null;
}

export function dropPdfDocument(hash: string, doc: PdfJsDocument): void {
  if (!hash) return;
  if (lent.get(hash) === doc) lent.delete(hash);
}

/* ------------------------------------------------------- open registry --- */

interface OpenEntry {
  promise: Promise<PdfJsDocument>;
  task: PdfLoadingTask;
  /** Settled document, once there is one — for the drop on teardown. */
  doc: PdfJsDocument | null;
  /** Mounted holders. The task dies when this reaches zero. */
  refs: number;
}

const opens = new Map<string, OpenEntry>();

/** One holder's claim on an open. `release` is idempotent. */
export interface PdfDocumentLease {
  promise: Promise<PdfJsDocument>;
  /** True when this lease joined an open somebody else had already started. */
  joined: boolean;
  release(): void;
}

/**
 * Is a document for this hash open or opening?
 *
 * The synchronous question a caller has to answer before deciding it has
 * nothing to draw: a pane handed no bytes is not empty-handed if the file is
 * already open somewhere else.
 */
export function pdfDocumentOpenFor(hash: string | undefined | null): boolean {
  if (!hash) return false;
  return opens.has(hash) || lent.has(hash);
}

/**
 * Take a share of the open for `hash`, starting one if nobody has.
 *
 * `start` is only called when this caller is the one opening; a joiner never
 * touches `getDocument`, never holds the loading task, and never destroys it.
 * A failed open drops out of the registry so the next caller can try again
 * rather than joining a rejection forever.
 *
 * Without a hash there is nothing to key on, so every caller opens its own —
 * the same as before this registry existed.
 */
export function acquirePdfDocument(
  hash: string | undefined | null,
  start: () => { promise: Promise<PdfJsDocument>; task: PdfLoadingTask },
): PdfDocumentLease {
  const key = hash || "";
  const existing = key ? opens.get(key) : undefined;
  if (existing) {
    existing.refs += 1;
    return { promise: existing.promise, joined: true, release: leaseRelease(key, existing) };
  }
  const { promise, task } = start();
  const entry: OpenEntry = { promise, task, doc: null, refs: 1 };
  if (key) {
    opens.set(key, entry);
    void promise.then(
      (doc) => {
        if (opens.get(key) !== entry) return;
        entry.doc = doc;
        // Lending is the registry's job now, so the peek map lives exactly as
        // long as the document does — a holder that leaves early cannot pull
        // the file out from under a holder that stayed.
        lendPdfDocument(key, doc);
      },
      () => {
        if (opens.get(key) === entry) opens.delete(key);
      },
    );
  }
  return { promise, joined: false, release: leaseRelease(key, entry) };
}

function leaseRelease(key: string, entry: OpenEntry): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (key && opens.get(key) === entry) opens.delete(key);
    if (key && entry.doc) dropPdfDocument(key, entry.doc);
    try {
      entry.task.destroy();
    } catch {
      /* already torn down */
    }
  };
}

/** Holders on the open for this hash — for tests and diagnostics. */
export function pdfDocumentRefs(hash: string): number {
  return opens.get(hash)?.refs ?? 0;
}

export function resetPdfOpenDocsForTests(): void {
  opens.clear();
  lent.clear();
}
