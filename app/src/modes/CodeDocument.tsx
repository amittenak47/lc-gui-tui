/**
 * A source file as the page under the ink — read-only, locked, camera-synced.
 *
 * Same contract as {@link AnnotateDocument}: full content height inside the board
 * page frame, no own scrollbar, rides the camera with the ink. The source is
 * never edited here and never run through a markdown parser — fencing a whole
 * file into `marked` would turn `#` into headings and trip on closing fences
 * inside the source. Escaped `<pre><code>` is the paper.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { PREPARING_HTML, shouldReportDocumentHeight } from "./AnnotateDocument";
import { docPreview, parseInline, truncationNoticeHtml } from "./docPreview";

export interface CodeDocumentProps {
  source: string;
  /** Highlight.js-style language id for `class="language-…"`. */
  language?: string;
  onMeasure?: (height: number) => void;
  /**
   * Scroll mode lets the reader pick quotes out of the page.
   *
   * When that is on the source stops being decoration and becomes content a
   * screen reader should see — so `aria-hidden` comes off. In Annotate mode it
   * goes back on: the page is paper under the pen there, and the ink layer
   * above it is what answers.
   */
  selectable?: boolean;
}

/** Escape text so it is safe inside an HTML text node / attribute-free body. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Source → a single escaped `<pre><code>` block.
 *
 * No sanitiser pass afterwards: the only HTML we emit is the tags we write
 * here, and the text inside is escaped. That is enough — and cheaper than
 * DOMPurify on a multi-hundred-KB file.
 */
export function renderCode(source: string, language = "plaintext"): string {
  const lang = language.replace(/[^a-zA-Z0-9_+#-]/g, "") || "plaintext";
  const { text, hidden } = docPreview(source);
  return (
    `<pre class="lc-code-doc-pre"><code class="language-${lang}">${escapeHtml(text)}</code></pre>` +
    truncationNoticeHtml(hidden)
  );
}

export function CodeDocument({
  source,
  language = "plaintext",
  onMeasure,
  selectable = false,
}: CodeDocumentProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  /*
   * Escaped off the render path above a size where that is worth doing.
   *
   * Five full-string passes over a source file, inside `useMemo` — which is to
   * say inside the render — froze the frame that was opening it, and froze it
   * again on every toggle between Annotate and Scroll.
   */
  const inline = useMemo(
    () =>
      parseInline(docPreview(source).text) ? renderCode(source, language) : null,
    [language, source],
  );
  const [parsed, setParsed] = useState<string | null>(inline);
  useEffect(() => {
    if (inline !== null) {
      setParsed(inline);
      return;
    }
    setParsed(null);
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      setParsed(renderCode(source, language));
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [inline, language, source]);
  const html = parsed ?? PREPARING_HTML;

  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    // The open gate waits for a stable height; a placeholder has one, and
    // settling on it would reveal the page at the wrong size.
    if (parsed === null) return;

    const report = () => {
      if (!shouldReportDocumentHeight(node.clientWidth, Boolean(source.trim()))) return;
      const height = Math.max(node.scrollHeight, node.offsetHeight);
      if (height > 0 || !source.trim()) onMeasureRef.current?.(height);
    };
    report();
    const raf = requestAnimationFrame(report);

    if (typeof ResizeObserver !== "function") {
      return () => cancelAnimationFrame(raf);
    }
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [html, parsed, source]);

  return (
    <div
      ref={nodeRef}
      className="lc-code-doc lc-md-ink-paper"
      aria-hidden={selectable ? undefined : true}
      // eslint-disable-next-line react/no-danger -- escaped in renderCode
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
