/**
 * A source file as the page under the ink — read-only, locked, camera-synced.
 *
 * Same contract as {@link MdInkDocument}: full content height inside the board
 * page frame, no own scrollbar, rides the camera with the ink. The source is
 * never edited here and never run through a markdown parser — fencing a whole
 * file into `marked` would turn `#` into headings and trip on closing fences
 * inside the source. Escaped `<pre><code>` is the paper.
 */

import { useEffect, useMemo, useRef } from "react";

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
  return `<pre class="lc-code-doc-pre"><code class="language-${lang}">${escapeHtml(source)}</code></pre>`;
}

export function CodeDocument({
  source,
  language = "plaintext",
  onMeasure,
  selectable = false,
}: CodeDocumentProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => renderCode(source, language), [source, language]);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

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
