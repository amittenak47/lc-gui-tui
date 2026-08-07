/**
 * An EPUB as the page under the ink.
 *
 * Reflowable, so unlike the PDF stack this is laid out the way the markdown
 * page is: one column at the frame's width, chapters end to end, measured and
 * reported up so the page frame grows to fit. It looks like the markdown pad on
 * purpose — the two are the same kind of reading, and a book that arrived in a
 * different file format should not arrive in a different app.
 *
 * Parsing is on the main thread and deliberately so: it is an unzip and a
 * sanitise, it happens once when the book opens (behind the same loading
 * transition every document open already has), and a worker would mean either
 * shipping the DOM parser twice or posting every chapter's HTML across a
 * boundary to be sanitised on the side that has one.
 */

import { useEffect, useMemo, useRef } from "react";

import { readEpub, type EpubChapter } from "../util/epub";

export interface EpubDocumentProps {
  bytes: ArrayBuffer;
  onMeasure?: (height: number) => void;
  /** Scroll mode: the chapter text answers the pointer so quotes can be picked. */
  selectable?: boolean;
  onError?: (message: string) => void;
}

export function EpubDocument({
  bytes,
  onMeasure,
  selectable = false,
  onError,
}: EpubDocumentProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  /*
   * Parsed during render, reported in an effect.
   *
   * The parse itself is pure and belongs in a memo, but telling the parent it
   * failed is not — calling up into `onError` mid-render is a state update on
   * another component while this one is rendering. So the failure is carried
   * out of the memo as a value and announced afterwards.
   */
  const parsed = useMemo<{ chapters: EpubChapter[]; error: string | null }>(() => {
    try {
      return { chapters: readEpub(bytes).chapters, error: null };
    } catch (cause: unknown) {
      return {
        chapters: [],
        error: cause instanceof Error ? cause.message : "this EPUB could not be opened",
      };
    }
  }, [bytes]);
  const { chapters, error } = parsed;

  useEffect(() => {
    if (error) onErrorRef.current?.(error);
  }, [error]);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    // Same measure contract as the markdown page: fonts and images land after
    // first layout and change the height under us, so watch the box rather
    // than measuring once after mount.
    const report = () => {
      const height = node.scrollHeight;
      if (height > 0) onMeasureRef.current?.(height);
    };
    report();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [chapters]);

  return (
    <div
      ref={nodeRef}
      className="lc-epub-doc lc-md-ink-carbon"
      aria-hidden={selectable ? undefined : true}
    >
      {chapters.map((chapter) => (
        <section
          key={chapter.href}
          className="lc-epub-chapter"
          data-epub-href={chapter.href}
          // eslint-disable-next-line react/no-danger -- sanitised in chapterHtml
          dangerouslySetInnerHTML={{ __html: chapter.html }}
        />
      ))}
      {chapters.length === 0 && (
        <p className="lc-epub-loading">
          {error ? "This EPUB could not be opened." : "Opening…"}
        </p>
      )}
    </div>
  );
}
