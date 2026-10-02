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
import { Marked } from "marked";
import "katex/dist/katex.min.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { traceOpen } from "../util/messageOf";
import { parseInline } from "./docPreview";
import { afterBootSettled } from "../util/bootSettled";
import {
  dropMarkdownLayout,
  loadMarkdownHtml,
  loadMarkdownLayout,
  markdownLayoutKey,
  MD_HTML_CACHE_MIN_CHARS,
  storeMarkdownHtml,
  storeMarkdownLayout,
  type MarkdownLayoutRecord,
} from "./markdownHtmlCache";
import { markedTexmathDollars } from "./mdMath";

const markedMath = new Marked({ gfm: true, breaks: false }).use(markedTexmathDollars());

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
  const t0 = performance.now();
  const html = markedMath.parse(source, { async: false });
  const t1 = performance.now();
  const clean = DOMPurify.sanitize(html, {
    // No `target`/`rel` juggling needed: links are inert here anyway, since
    // the surface never receives a pointer event.
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input"],
    // KaTeX positions glyphs with inline styles; style elements stay forbidden.
    FORBID_ATTR: ["onerror", "onload", "onclick"],
    ADD_ATTR: ["style"],
  });
  if (source.length > 20_000) {
    traceOpen("markdown rendered", {
      chars: source.length,
      parseMs: Math.round(t1 - t0),
      sanitizeMs: Math.round(performance.now() - t1),
    });
  }
  return clean;
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

/*
 * Off-screen blocks that skip layout.
 *
 * A long note is hundreds of top-level blocks and tens of thousands of KaTeX
 * spans; laying all of them out is most of a relaunch, and every hit test
 * walks them again. `content-visibility: auto` lets the browser skip the ones
 * off screen while they stay in the DOM — selection, find, footnote anchors
 * and the document order of scroll hosts all unchanged.
 *
 * Only where it cannot move anything:
 *  - paragraphs and headings, whose children are inline, so the containment
 *    it brings cannot stop a child margin collapsing through them (a list's
 *    would, and everything below would shift under its ink); tables are out
 *    because size containment does not apply to them;
 *  - nothing that holds a scroll host, which must stay measurable;
 *  - nothing that overflowed its box, which paint containment would clip.
 * Each skipped block keeps the exact height it last laid out at, so the page
 * below it sits where it always did.
 */
const SKIPPABLE_BLOCKS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6"]);
/** Scroll hosts must stay measurable; a picture settles its height only once decoded. */
const HOLDS_SCROLL_HOST = 'pre, .katex-display, [style*="overflow" i], img';

/** What a note's layout depends on besides its text. */
export function markdownLayoutShape(node: HTMLElement): string {
  const style = getComputedStyle(node);
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return `${style.width}|${style.fontSize}|${style.lineHeight}|${style.fontFamily}|${dpr}`;
}

/**
 * Layout units per CSS px under `node`: Blink lays out in 1/64 of a *device*
 * pixel (zoom for the screen's scale factor), times any CSS `zoom` above it.
 */
function layoutUnitsPerPx(node: HTMLElement): number {
  let zoom = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    const z = Number.parseFloat(getComputedStyle(el).zoom);
    if (z > 0 && z !== 1) zoom *= z;
  }
  return 64 * zoom;
}

/**
 * The block's content-box height in CSS px: what `contain-intrinsic-size`
 * sets. From the computed style, not the client rect, which is scaled by the
 * board's camera.
 */
function contentHeight(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const height = Number.parseFloat(style.height);
  if (!Number.isFinite(height)) return 0;
  if (style.boxSizing !== "border-box") return height;
  const edges = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"] as const;
  return height - edges.reduce((sum, edge) => sum + (Number.parseFloat(style[edge]) || 0), 0);
}

/**
 * A height to hand back that lays out at exactly the units it was measured at.
 *
 * The computed height is a whole number of layout units divided by the screen
 * scale and printed to four places; handed back as is, Blink multiplies and
 * floors, and it lands one unit short often enough to move the foot of a long
 * note by pixels. Recover the whole units and aim half a unit above them.
 */
function recordableHeight(height: number, unitsPerPx: number): number {
  return (Math.round(height * unitsPerPx) + 0.5) / unitsPerPx;
}

/** Each top-level block's content height, or 0 where it must always lay out. */
export function measureSkippableHeights(node: HTMLElement): number[] {
  const unitsPerPx = layoutUnitsPerPx(node);
  return Array.from(node.children, (el) => {
    if (!(el instanceof HTMLElement) || !SKIPPABLE_BLOCKS.has(el.tagName)) return 0;
    if (el.querySelector(HOLDS_SCROLL_HOST)) return 0;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) return 0;
    const height = contentHeight(el);
    return height > 0 ? recordableHeight(height, unitsPerPx) : 0;
  });
}

/**
 * `localStorage["lc-md-layout-off"] = "1"` lays every note out in full (records
 * are still taken). For comparing layouts, and as a way out if a page ever
 * looks misplaced.
 */
function skippingDisabled(): boolean {
  try {
    return localStorage.getItem("lc-md-layout-off") === "1";
  } catch {
    return false;
  }
}

/** Hand the recorded heights to the browser. False when the record does not fit this render. */
export function applySkippableHeights(node: HTMLElement, record: MarkdownLayoutRecord): boolean {
  if (record.heights.length !== node.children.length) return false;
  Array.from(node.children).forEach((el, i) => {
    const height = record.heights[i] ?? 0;
    if (!(el instanceof HTMLElement) || !(height > 0) || !SKIPPABLE_BLOCKS.has(el.tagName)) return;
    // Not `auto` for the size: that prefers the block's last rendered size,
    // and a block drawn once before the math fonts landed keeps that wrong
    // size for good. One attribute write, not two property sets: hundreds of
    // blocks each parsed and invalidated twice was a sizeable part of a launch.
    const skip = `content-visibility:auto;contain-intrinsic-size:${height}px`;
    const prior = el.getAttribute("style");
    el.setAttribute("style", prior ? `${prior};${skip}` : skip);
  });
  return true;
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
    () => (parseInline(source) ? renderMarkdown(source) : null),
    [source],
  );
  const [parsed, setParsed] = useState<string | null>(inline);
  /** The layout record for this text at this column and type, once looked for. */
  const [layout, setLayout] = useState<{ key: string; record: MarkdownLayoutRecord | null } | null>(null);
  useEffect(() => {
    if (inline !== null) {
      setParsed(inline);
      return;
    }
    setParsed(null);
    setLayout(null);
    let cancelled = false;
    let raf = 0;
    // The placeholder is on screen already: its column and type are the page's.
    const node = nodeRef.current;
    const layoutKey = node ? markdownLayoutKey(source, markdownLayoutShape(node)) : null;
    /*
     * The last render of this exact text first: a relaunch onto a long note
     * reads it back rather than paying marked + DOMPurify again. Only a miss
     * renders, a frame later so the placeholder is on screen before the main
     * thread goes, and keeps the result for next time.
     */
    void Promise.all([
      loadMarkdownHtml(source),
      layoutKey ? loadMarkdownLayout(layoutKey) : Promise.resolve(null),
    ]).then(([cached, record]) => {
      if (cancelled) return;
      if (layoutKey) setLayout({ key: layoutKey, record });
      if (cached !== null) {
        traceOpen("markdown from render cache", { chars: source.length });
        setParsed(cached);
        return;
      }
      raf = requestAnimationFrame(() => {
        if (cancelled) return;
        const html = renderMarkdown(source);
        setParsed(html);
        void storeMarkdownHtml(source, html);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [inline, source]);
  const html = parsed ?? PREPARING_HTML;
  // React compares this prop by identity. A fresh wrapper assigns innerHTML
  // again even when the string is unchanged, replacing every word/fence and
  // triggering layout and the ink/selection observers on ordinary UI updates.
  const markup = useMemo(() => ({ __html: html }), [html]);

  /*
   * Before the first layout of the real document: hand off-screen blocks
   * their recorded heights. Without a record the note lays out in full, and
   * once the launch has settled its blocks are measured for next time.
   */
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node || parsed === null || !layout || source.length < MD_HTML_CACHE_MIN_CHARS) return;
    const { key, record } = layout;
    if (record && !skippingDisabled() && applySkippableHeights(node, record)) {
      traceOpen("markdown layout record applied", {
        skipped: record.heights.filter((h) => h > 0).length,
        blocks: record.heights.length,
      });
      // A block that renders at another size means the record is stale:
      // this session has already placed it, so the next one lays out in full.
      let dropped = false;
      const check = (event: Event) => {
        const el = event.target;
        if (dropped || !(el instanceof HTMLElement) || el.parentElement !== node) return;
        if ((event as Event & { skipped?: boolean }).skipped) return;
        // Drawn before the fonts landed, a block is not yet the size it settles at.
        if (document.fonts && document.fonts.status !== "loaded") return;
        const i = Array.prototype.indexOf.call(node.children, el);
        const recorded = record.heights[i] ?? 0;
        if (!(recorded > 0)) return;
        const unitsPerPx = layoutUnitsPerPx(node);
        const real = contentHeight(el);
        // Compared in whole layout units: the record aims half a unit high, and
        // a block can come out a unit either way between launches (0.009 CSS
        // px here), which no reader can see and no ink can be off by.
        if (Math.abs(Math.round(real * unitsPerPx) - Math.floor(recorded * unitsPerPx)) > 2) {
          dropped = true;
          traceOpen("markdown layout record stale", { block: i, recorded, real });
          void dropMarkdownLayout(key);
        }
      };
      node.addEventListener("contentvisibilityautostatechange", check, true);
      return () => node.removeEventListener("contentvisibilityautostatechange", check, true);
    }
    let cancelled = false;
    void afterBootSettled()
      .then(() => document.fonts?.ready)
      .then(() => new Promise((resolve) => window.setTimeout(resolve, 1500)))
      .then(() => {
        if (cancelled || !node.isConnected) return;
        const heights = measureSkippableHeights(node);
        if (heights.some((h) => h > 0)) void storeMarkdownLayout(key, heights);
      });
    return () => {
      cancelled = true;
    };
  }, [layout, parsed, source]);

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
    let cancelled = false;
    let raf2 = 0;
    const report = () => {
      if (cancelled) return;
      if (!shouldReportDocumentHeight(node.clientWidth, Boolean(source.trim()))) return;
      onMeasureRef.current?.(Math.max(node.scrollHeight, node.offsetHeight));
    };
    report();
    const raf = requestAnimationFrame(() => {
      report();
      raf2 = requestAnimationFrame(report);
    });
    void document.fonts?.ready?.then(report);

    if (typeof ResizeObserver !== "function") {
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        cancelAnimationFrame(raf2);
      };
    }
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(raf2);
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
      dangerouslySetInnerHTML={markup}
    />
  );
}
