/**
 * Picking a quote out of the page, in Scroll mode.
 *
 * The gesture is hold-then-drag, and it has to be, because every simpler one is
 * already taken: a drag is how the page scrolls, and a tap has to stay free or
 * reading turns into a minefield. Holding is the only thing a reader never does
 * by accident, which is what makes it safe to give it a mode.
 *
 * Native selection is not used. On a tablet WebView it is a different control
 * on every platform, it fights `touch-action: none` (which reading mode needs
 * so the camera pan can arm at all), and its handles are drawn by the system in
 * screen space over a page that lives in a scaled scene — they would sit
 * visibly wrong the moment the writer zoomed. The highlight here is painted
 * from `Range.getClientRects()` into the page's own coordinate space instead,
 * so it scales and scrolls with the words like the ink does.
 *
 * Annotate mode does not mount this at all. There the pen owns the surface.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  anchorFromRange,
  excerptOf,
  rangeFromAnchor,
  snapToWords,
  textOf,
  type DocAnchor,
} from "../util/docAnchors";
import type { DocFootnote } from "../util/docFootnotes";
import { LONG_PRESS_MS } from "../util/gesture";
import {
  claimSelectionGesture,
  releaseSelectionGesture,
} from "../canvas/docSelectionGesture";

/** Movement before the hold fires that means the writer meant to scroll. */
const HOLD_SLOP_PX = 10;

/** A rectangle in the document's own (unscaled) coordinate space. */
interface LocalRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DocSelectionResult {
  text: string;
  excerpt: string;
  anchor: DocAnchor;
}

export interface DocSelectionLayerProps {
  /** The rendered document — markdown body, PDF page, EPUB chapter. */
  children: React.ReactNode;
  /** Sub-document these offsets belong to; unset for a single-stream doc. */
  scope?: string;
  /** Off in Annotate mode: the pen owns the surface there. */
  enabled?: boolean;
  footnotes?: readonly DocFootnote[];
  onCoach?: (selection: DocSelectionResult) => void;
  onCopy?: (selection: DocSelectionResult) => void;
  onSearch?: (selection: DocSelectionResult) => void;
  /** Tap on an existing ribbon — reopen the thread or the search. */
  onOpenFootnote?: (footnote: DocFootnote) => void;
  onRemoveFootnote?: (footnote: DocFootnote) => void;
}

/** Caret hit-testing, spelled both ways browsers spell it. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  return null;
}

/**
 * The factor the board camera is scaling this subtree by.
 *
 * Asked of the DOM rather than plumbed down from the camera: the page slot is
 * transformed by Board and by nothing else, so its rendered width over its
 * layout width *is* the zoom, and a value read this way cannot drift out of
 * step with what is on screen.
 */
function scaleOf(node: HTMLElement): number {
  const width = node.offsetWidth;
  if (width <= 0) return 1;
  const rendered = node.getBoundingClientRect().width;
  return rendered > 0 ? rendered / width : 1;
}

function localRects(host: HTMLElement, range: Range): LocalRect[] {
  const origin = host.getBoundingClientRect();
  const scale = scaleOf(host) || 1;
  return Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
    .map((rect) => ({
      left: (rect.left - origin.left) / scale,
      top: (rect.top - origin.top) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    }));
}

export function DocSelectionLayer({
  children,
  scope,
  enabled = true,
  footnotes = [],
  onCoach,
  onCopy,
  onSearch,
  onOpenFootnote,
  onRemoveFootnote,
}: DocSelectionLayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /**
   * The document body, and nothing else.
   *
   * Anchors are offsets into a character stream, so the root they are measured
   * against must hold exactly the document's text — put the ribbons inside it
   * and their emoji would shift every offset after the first one. The overlay
   * is therefore a sibling of this, not a child.
   */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [rects, setRects] = useState<LocalRect[]>([]);
  const [selection, setSelection] = useState<DocSelectionResult | null>(null);
  /** Viewport point the action sheet hangs from; null while none is open. */
  const [sheetAt, setSheetAt] = useState<{ x: number; y: number } | null>(null);
  const [ribbons, setRibbons] = useState<Array<{ footnote: DocFootnote; at: LocalRect }>>(
    [],
  );
  const [copied, setCopied] = useState(false);

  /** Live gesture: null between holds. */
  const holdRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    timer: number | null;
    held: boolean;
    anchorOffset: number | null;
  } | null>(null);

  const clearGesture = useCallback(() => {
    const hold = holdRef.current;
    if (hold?.timer != null) window.clearTimeout(hold.timer);
    holdRef.current = null;
    releaseSelectionGesture();
  }, []);

  const dismiss = useCallback(() => {
    setSelection(null);
    setSheetAt(null);
    setRects([]);
    setCopied(false);
  }, []);

  /** Offset of a viewport point in the document's character stream. */
  const offsetAt = useCallback((x: number, y: number): number | null => {
    const host = bodyRef.current;
    if (!host) return null;
    const caret = caretAt(x, y);
    if (!caret || !host.contains(caret.node)) return null;
    const range = document.createRange();
    range.setStart(caret.node, caret.offset);
    range.collapse(true);
    return anchorFromRange(host, expandOne(host, range))?.start ?? null;
  }, []);

  /** Paint (and remember) the selection between two character offsets. */
  const applySelection = useCallback(
    (from: number, to: number) => {
      const host = bodyRef.current;
      if (!host) return;
      const text = textOf(host);
      const [start, end] = snapToWords(
        text,
        Math.min(from, to),
        Math.max(from, to) + (from === to ? 1 : 0),
      );
      if (end <= start) return;
      const anchor: DocAnchor = { start, end, ...(scope ? { scope } : {}) };
      const range = rangeFromAnchor(host, anchor);
      if (!range) return;
      // Sliced from the stream, not from the range: `Range.toString()` fuses
      // across block boundaries, which is exactly what the stream's separators
      // exist to prevent.
      const quoted = text.slice(start, end);
      setRects(localRects(host, range));
      setSelection({ text: quoted, excerpt: excerptOf(quoted), anchor });
    },
    [scope],
  );

  useEffect(() => {
    if (!enabled) {
      clearGesture();
      dismiss();
    }
  }, [enabled, clearGesture, dismiss]);

  // The gesture. Listeners go on the window for move/up so a drag that leaves
  // the words — off the end of a paragraph, past the edge of the page — keeps
  // extending the selection instead of silently ending it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled) return;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // A tap on a ribbon is that ribbon's, not the start of a new quote.
      if ((event.target as Element | null)?.closest?.(".lc-doc-footnote")) return;
      dismiss();
      clearGesture();
      const startX = event.clientX;
      const startY = event.clientY;
      holdRef.current = {
        pointerId: event.pointerId,
        startX,
        startY,
        timer: window.setTimeout(() => {
          const hold = holdRef.current;
          if (!hold) return;
          const offset = offsetAt(startX, startY);
          if (offset == null) {
            clearGesture();
            return;
          }
          hold.held = true;
          hold.timer = null;
          hold.anchorOffset = offset;
          // Board's pan must let go before the drag below starts moving.
          claimSelectionGesture();
          try {
            navigator.vibrate?.(10);
          } catch {
            /* haptics are a nicety */
          }
          applySelection(offset, offset);
        }, LONG_PRESS_MS),
        held: false,
        anchorOffset: null,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      const hold = holdRef.current;
      if (!hold || hold.pointerId !== event.pointerId) return;
      if (!hold.held) {
        // Moved before the hold landed: the writer meant to scroll, and the
        // page has already started doing it. Get out of the way.
        const moved = Math.hypot(event.clientX - hold.startX, event.clientY - hold.startY);
        if (moved > HOLD_SLOP_PX) clearGesture();
        return;
      }
      event.preventDefault();
      const offset = offsetAt(event.clientX, event.clientY);
      if (offset == null || hold.anchorOffset == null) return;
      applySelection(hold.anchorOffset, offset);
    };

    const onPointerUp = (event: PointerEvent) => {
      const hold = holdRef.current;
      if (!hold || hold.pointerId !== event.pointerId) return;
      const held = hold.held;
      clearGesture();
      if (held) setSheetAt({ x: event.clientX, y: event.clientY });
    };

    /*
     * The platform's own selection stays off.
     *
     * The body has to be `user-select: text` for `caretRangeFromPoint` to
     * answer at all, and that is also what invites the system long-press
     * handles — drawn in screen space, over a page that lives in a scaled
     * scene, so they sit visibly wrong the moment the writer zooms. Cancelling
     * `selectstart` keeps the hit-testing and drops the UI.
     */
    const onSelectStart = (event: Event) => event.preventDefault();

    host.addEventListener("selectstart", onSelectStart);
    host.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      host.removeEventListener("selectstart", onSelectStart);
      host.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      releaseSelectionGesture();
    };
  }, [enabled, applySelection, clearGesture, dismiss, offsetAt]);

  /*
   * Ribbons are placed from the live DOM, so they follow a re-render of the
   * document — a theme change, a font landing — without storing any geometry.
   *
   * Placing them once on mount is not enough, because not every document *has*
   * its text on mount. A PDF's words arrive with the text layer, seconds after
   * the pages do, and a reopened book put its ribbons on a page that was still
   * blank: every anchor failed to resolve, and nothing ever asked again. So the
   * body is watched, and placement re-runs when its text changes. A mutation
   * observer rather than a prop the renderers report through: the layer should
   * not have to know which of them is slow, and the next one will be too.
   */
  useLayoutEffect(() => {
    const host = bodyRef.current;
    if (!host) {
      setRibbons([]);
      return;
    }

    const place = () => {
      const placed: Array<{ footnote: DocFootnote; at: LocalRect }> = [];
      for (const footnote of footnotes) {
        if (scope && footnote.anchor.scope && footnote.anchor.scope !== scope) continue;
        const range = rangeFromAnchor(host, footnote.anchor);
        if (!range) continue;
        const [first] = localRects(host, range);
        if (!first) continue;
        placed.push({ footnote, at: first });
      }
      setRibbons(placed);
    };
    place();

    if (footnotes.length === 0 || typeof MutationObserver !== "function") return;
    // Coalesced to a frame: a text layer lands as hundreds of appended spans,
    // and re-measuring on each one would be a layout read per span.
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        place();
      });
    });
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [footnotes, scope, children]);

  const act = (run: ((selection: DocSelectionResult) => void) | undefined) => {
    const current = selection;
    if (!current || !run) return;
    run(current);
    dismiss();
  };

  return (
    <div className="lc-doc-selectable" ref={hostRef}>
      <div className="lc-doc-selectable-body" ref={bodyRef}>
        {children}
      </div>
      {(rects.length > 0 || ribbons.length > 0) && (
        <div className="lc-doc-select-overlay" aria-hidden={rects.length === 0}>
          {rects.map((rect, index) => (
            <div
              key={`sel-${index}`}
              className="lc-doc-select-rect"
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }}
            />
          ))}
          {ribbons.map(({ footnote, at }) => (
            <button
              type="button"
              key={footnote.id}
              className={`lc-doc-footnote lc-doc-footnote-${footnote.kind}`}
              style={{ left: at.left + at.width, top: at.top }}
              title={
                footnote.kind === "search"
                  ? `Search: ${footnote.query ?? footnote.excerpt}`
                  : `Coach: ${footnote.excerpt}`
              }
              aria-label={
                footnote.kind === "search"
                  ? `Reopen search for ${footnote.query ?? footnote.excerpt}`
                  : `Open coach thread about ${footnote.excerpt}`
              }
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onOpenFootnote?.(footnote)}
              onContextMenu={(event) => {
                event.preventDefault();
                onRemoveFootnote?.(footnote);
              }}
            >
              {footnote.kind === "search" ? "🔎" : "💬"}
            </button>
          ))}
        </div>
      )}
      {sheetAt &&
        selection &&
        createPortal(
          <>
            <button
              type="button"
              className="lc-doc-sheet-backdrop"
              aria-label="Dismiss selection actions"
              onClick={dismiss}
            />
            <div
              className="lc-doc-sheet"
              role="menu"
              style={{ left: sheetAt.x, top: sheetAt.y }}
            >
              <p className="lc-doc-sheet-excerpt">{selection.excerpt}</p>
              <div className="lc-doc-sheet-actions">
                <button type="button" role="menuitem" onClick={() => act(onCoach)}>
                  Coach
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCopied(true);
                    act(onCopy);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button type="button" role="menuitem" onClick={() => act(onSearch)}>
                  Google
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

/**
 * Give a collapsed caret one character of body so it can be anchored.
 *
 * `anchorFromRange` refuses an empty range on purpose — a zero-length quote is
 * a bug everywhere else it could come from. A caret is the one legitimate
 * exception, and widening it here keeps that check strict.
 */
function expandOne(host: HTMLElement, range: Range): Range {
  const widened = range.cloneRange();
  try {
    widened.setEnd(range.endContainer, range.endOffset + 1);
  } catch {
    try {
      widened.setStart(range.startContainer, Math.max(0, range.startOffset - 1));
    } catch {
      /* a caret with nothing either side of it — the anchor will be null */
    }
  }
  return host.contains(widened.startContainer) ? widened : range;
}
