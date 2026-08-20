/**
 * A captured web page as the paper under the ink.
 *
 * Same column as markdown/EPUB: sanitised HTML, measured height, board camera.
 * Not a live iframe — see `webPage.ts`.
 */

import { useEffect, useRef } from "react";

import { promoteLazyImages, type WebHtmlSource } from "../util/webPage";

export interface WebDocumentProps {
  html: string;
  url: string;
  onMeasure?: (height: number) => void;
  selectable?: boolean;
  /** Reading-mode taps on links fetch a new snapshot instead of leaving the app. */
  onNavigate?: (url: string) => void;
  /** Vite / fetch_html GET — page JS never ran. */
  source?: WebHtmlSource;
  /** Why the rendered capture was not used. Surfaced in the address bar. */
  note?: string;
}

export function WebDocument({
  html,
  url,
  onMeasure,
  selectable = false,
  onNavigate,
  source,
}: WebDocumentProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    promoteLazyImages(node);
    const report = () => {
      const height = node.scrollHeight;
      if (height > 0) onMeasureRef.current?.(height);
    };
    report();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [html]);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
      onNavigateRef.current?.(href);
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  }, [html]);

  /*
   * Which of the three kinds of paper this is — see `WebHtmlSource`.
   *
   * The note that used to sit here as a paragraph has moved to the address bar.
   * It was rendered inside the scrolling page, so it scrolled away and read as
   * part of the site's own content, which is why nobody saw it.
   */
  return (
    <div className="lc-web-doc-wrap">
      <div
        ref={nodeRef}
        className={source === "reader" ? "lc-web-doc is-reader" : "lc-web-doc"}
        data-doc-scope={url}
        aria-hidden={selectable ? undefined : true}
        // eslint-disable-next-line react/no-danger -- sanitised in fetchWebPage
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
