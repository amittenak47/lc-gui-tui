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
  limitation?: string;
}
/** Check identity AND camera/ink revision after async export. Never silently
 * pair text from one view with pixels produced after a navigation/edit. */
export function sameDocumentView(a: DocumentViewSnapshot, b: DocumentViewSnapshot): boolean {
  return a.revision === b.revision && JSON.stringify(a.viewport) === JSON.stringify(b.viewport);
}
export function documentAskFields(view: DocumentViewContext) {
  return {
    document_hash: view.document_hash,
    page: view.pages[0] ?? 1,
    page_text: [`Document: ${view.title}`, `Visible pages: ${view.pages.join(", ") || "continuous document"}`,
      view.text.slice(0, 12000), view.text.length > 12000 ? "[Visible text truncated]" : "", view.limitation ?? ""].filter(Boolean).join("\n"),
  };
}
