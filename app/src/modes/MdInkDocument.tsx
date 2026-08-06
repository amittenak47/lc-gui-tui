/**
 * The markdown page under the ink — read-only, locked, and camera-synced.
 *
 * This is the paper, not a document viewer. It has no scrollbar of its own and
 * never takes a pointer: it lays out at full content height inside the board's
 * page frame and rides the board camera like any other element on the page, so
 * a pan moves the markdown, the Excalidraw shapes and the raster ink together
 * as one thing. An inner `overflow: auto` would have been much easier and
 * completely wrong — the ink would slide off the words the moment you scrolled.
 *
 * Height is measured and reported up so the page frame can grow to fit. Nothing
 * else about the document is dynamic: the markdown is never edited here, only
 * drawn over.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useRef } from "react";

export interface MdInkDocumentProps {
  source: string;
  /**
   * Called with the rendered height in scene units whenever it changes.
   *
   * The document fills a wrapper that the board lays out at the page's scene
   * width and then *scales* by the zoom, so everything measured in here is
   * already in scene units — no dividing by the camera, and no re-measuring
   * when the writer zooms.
   */
  onMeasure?: (height: number) => void;
}

/**
 * Markdown → HTML, with anything executable taken out.
 *
 * `marked` does not sanitise, and a markdown file is an untrusted document
 * however it got here — the writer may well be annotating something they were
 * sent. Scripts, event handlers and embedded objects go; the formatting a set
 * of notes actually uses stays.
 */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false, gfm: true, breaks: false });
  return DOMPurify.sanitize(html, {
    // No `target`/`rel` juggling needed: links are inert here anyway, since
    // the surface never receives a pointer event.
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
  });
}

export function MdInkDocument({ source, onMeasure }: MdInkDocumentProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => renderMarkdown(source), [source]);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    // Fonts land after first layout and change the height under us, so measure
    // again when the box actually changes rather than once after mount.
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

  return (
    <div
      ref={nodeRef}
      className="lc-md-ink-doc lc-md-ink-carbon"
      // Locked: the markdown is the page, and a page does not answer the pen.
      // Pointer events belong to the ink layer above and the board beneath.
      aria-hidden
      // eslint-disable-next-line react/no-danger -- sanitised in renderMarkdown
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
