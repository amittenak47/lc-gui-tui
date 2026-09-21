export interface DocumentViewSnapshot {
  paneId?: string;
  viewport: { x: number; y: number; width: number; height: number };
  pages: number[];
  text: string;
  revision: string;
}
export interface DocumentViewContext extends DocumentViewSnapshot {
  document_hash: string;
  title: string;
  format: string;
  /** Links a frozen selection to its own PNG, not unrelated attached photos. */
  documentCaptureId?: string;
  limitation?: string;
}
/** Check identity AND camera/ink revision after async export. Never silently
 * pair text from one view with pixels produced after a navigation/edit. */
export function sameDocumentView(a: DocumentViewSnapshot, b: DocumentViewSnapshot): boolean {
  return a.paneId === b.paneId && a.revision === b.revision &&
    a.text === b.text && JSON.stringify(a.pages) === JSON.stringify(b.pages) &&
    a.viewport.x === b.viewport.x && a.viewport.y === b.viewport.y &&
    a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height;
}
/** A frozen selection can outlive scrolling, but must not borrow another
 * document's ink or footnotes while its request is being prepared. */
export function sameDocumentIdentity(
  a: Pick<DocumentViewContext, "document_hash" | "paneId">,
  b: Pick<DocumentViewContext, "document_hash" | "paneId">,
): boolean {
  return a.document_hash === b.document_hash && a.paneId === b.paneId;
}

/**
 * The pad still open after an await — not the React wrapper objects.
 *
 * `Board`'s `useImperativeHandle` replaces `boardRef.current` on every
 * render, and `setAnnotateSource` mints a new source record for the same
 * file. `===` on those objects treats a queued send as "the pane changed".
 */
export function livePadStillOpen(
  started: { sourceHash: string; boardId: object; paneId?: string },
  liveSource: { hash: string } | null | undefined,
  liveBoard: { instanceId: object; captureDocumentView: () => { paneId?: string } } | null | undefined,
): boolean {
  if (!liveSource || !liveBoard) return false;
  if (liveBoard.instanceId !== started.boardId) return false;
  if (liveSource.hash !== started.sourceHash) return false;
  return liveBoard.captureDocumentView().paneId === started.paneId;
}
export function documentImageContext(view: DocumentViewContext, hasImage: boolean): DocumentViewContext {
  if (hasImage) return view;
  return { ...view, limitation: view.limitation ?? (view.text.trim()
    ? "Image unavailable; answer from the visible extracted text."
    : "The current view has no readable extracted text or image. Ask for a capture before describing it.") };
}
export function hasDocumentCapture(
  view: DocumentViewContext,
  attachments: readonly { png: string; documentCaptureId?: string }[],
): boolean {
  return Boolean(view.documentCaptureId && attachments.some(attachment =>
    attachment.documentCaptureId === view.documentCaptureId && attachment.png.length > 0));
}
export function documentAskFields(view: DocumentViewContext) {
  return {
    document_hash: view.document_hash,
    page: view.pages[0] ?? 1,
    page_text: [`Document: ${view.title}`, `Visible pages: ${view.pages.join(", ") || "continuous document"}`,
      view.text.slice(0, 12000), view.text.length > 12000 ? "[Visible text truncated]" : "", view.limitation ?? ""].filter(Boolean).join("\n"),
  };
}
