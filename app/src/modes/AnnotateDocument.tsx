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
import { useEffect, useMemo, useRef, useState } from "react";

import { docPreview, parseInline, truncationNoticeHtml } from "./docPreview";

export interface AnnotateDocumentProps {
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
  /**
   * Scroll mode lets the reader pick quotes out of the page.
   *
   * When that is on the markdown stops being decoration and becomes content a
   * screen reader should see — so `aria-hidden` comes off. In Annotate mode it
   * goes back on: the page is paper under the pen there, and the ink layer
   * above it is what answers.
   */
  selectable?: boolean;
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
  const { text, hidden } = docPreview(source);
  const html = marked.parse(text, { async: false, gfm: true, breaks: false });
  const clean = DOMPurify.sanitize(html, {
    // No `target`/`rel` juggling needed: links are inert here anyway, since
    // the surface never receives a pointer event.
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
  });
  // Appended after sanitising because it is ours, not the document's.
  return clean + truncationNoticeHtml(hidden);
}

/**
 * Narrower than this and the box is not laid out yet, whatever it measures.
 *
 * A `width: 100%` document inside a collapsed slot puts one glyph per line, so
 * its height is enormous and meaningless. Reporting it grows the page frame and
 * zooms the camera out, which keeps the slot narrow — the measurement causes the
 * condition it was measured under. Say nothing until there is a real column.
 */
export const MIN_MEASURABLE_WIDTH_PX = 80;

/**
 * True when the paper column is wide enough that its height means something.
 *
 * Empty notes wait for this bar so a 0×0 first paint is not reported as
 * "nothing in it". Files with text must not wait — that swallow left them on
 * the 1100 floor with the pan clamp pinned.
 */
export function columnIsMeasurable(clientWidth: number): boolean {
  return Number.isFinite(clientWidth) && clientWidth >= MIN_MEASURABLE_WIDTH_PX;
}

/** Whether `onMeasure` should fire for this layout. */
/** What stands in for the page while a large file is being parsed. */
export const PREPARING_HTML = '<p class="lc-doc-preparing">Preparing the page…</p>';

export function shouldReportDocumentHeight(clientWidth: number, hasText: boolean): boolean {
  if (!Number.isFinite(clientWidth) || clientWidth <= 0) return false;
  if (hasText) return true;
  return columnIsMeasurable(clientWidth);
}

export function AnnotateDocument({ source, onMeasure, selectable = false }: AnnotateDocumentProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  /*
   * Parsed off the render path, above a size where that is worth doing.
   *
   * `marked` + DOMPurify ran inside `useMemo`, which is to say inside the
   * render — so a large file froze the frame that was opening it, and froze it
   * again on every toggle between Annotate and Scroll. Small notes still parse
   * inline: the work is a few milliseconds and doing it there keeps their open
   * exactly as it was, with no placeholder frame in between.
   */
  const inline = useMemo(
    () => (parseInline(docPreview(source).text) ? renderMarkdown(source) : null),
    [source],
  );
  const [parsed, setParsed] = useState<string | null>(inline);
  useEffect(() => {
    if (inline !== null) {
      setParsed(inline);
      return;
    }
    setParsed(null);
    let cancelled = false;
    // A frame, so the placeholder is on screen before the main thread goes.
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      setParsed(renderMarkdown(source));
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [inline, source]);
  const html = parsed ?? PREPARING_HTML;

  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    /*
     * Nothing is reported until there is real content.
     *
     * The open gate waits for a stable height, and a placeholder has one. Let
     * it settle on that and the page reveals at the wrong size, then reflows
     * when the document arrives. Waiting is what the gate is for.
     */
    if (parsed === null) return;

    /*
     * Fonts land after first layout and change the height under us, so measure
     * again when the box actually changes rather than once after mount.
     *
     * Zero is reported, unlike the PDF / code / epub readers next door. Those
     * cannot be zero tall once they exist, so for them a zero reading means
     * "not rendered yet" and swallowing it is right. A markdown note *can* be
     * zero tall, because a note you have just created has nothing in it — and
     * swallowing that reading meant the open never completed. The document
     * timed out and the reader was told to pick a smaller file, about a file
     * with nothing in it.
     */
    const report = () => {
      if (!shouldReportDocumentHeight(node.clientWidth, Boolean(source.trim()))) return;
      onMeasureRef.current?.(Math.max(node.scrollHeight, node.offsetHeight));
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
      className="lc-md-ink-doc lc-md-ink-paper"
      // Locked under the pen; readable when the page is selectable. Pointer
      // events still belong to the ink layer above in Annotate mode — the
      // selection layer around this only takes them in Scroll mode.
      aria-hidden={selectable ? undefined : true}
      // eslint-disable-next-line react/no-danger -- sanitised in renderMarkdown
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
