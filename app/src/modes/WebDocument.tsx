/**
 * A captured web page as the paper under the ink.
 *
 * Same column as markdown/EPUB: sanitised HTML, measured height, board camera.
 * Not a live iframe — see `webPage.ts`.
 */

import { useEffect, useRef } from "react";

export interface WebDocumentProps {
  html: string;
  url: string;
  onMeasure?: (height: number) => void;
  selectable?: boolean;
  /** Reading-mode taps on links fetch a new snapshot instead of leaving the app. */
  onNavigate?: (url: string) => void;
}

export function WebDocument({
  html,
  url,
  onMeasure,
  selectable = false,
  onNavigate,
}: WebDocumentProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
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

  return (
    <div
      ref={nodeRef}
      className="lc-web-doc lc-md-ink-paper lc-md-ink-doc"
      data-doc-scope={url}
      aria-hidden={selectable ? undefined : true}
      // eslint-disable-next-line react/no-danger -- sanitised in fetchWebPage
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
