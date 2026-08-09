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
  regionAnchorFromRect,
  SCOPE_ATTR,
  isRegionAnchor,
  rangeFromAnchor,
  scopeOfNode,
  scopeRootIn,
  scopeRootsIn,
  snapToWords,
  textNodesOf,
  textOf,
  type DocAnchor,
} from "../util/docAnchors";
import { numberFootnotes, orderScopes, type DocFootnote } from "../util/docFootnotes";
import { LONG_PRESS_MS } from "../util/gesture";
import {
  claimSelectionGesture,
  releaseSelectionGesture,
} from "../canvas/docSelectionGesture";

/** Movement before the hold fires that means the writer meant to scroll. */
const HOLD_SLOP_PX = 10;

/** Thinnest a swept band may be, so a flat sweep is still visible and hittable. */
const MIN_BAND_PX = 14;

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
  /** Off in Annotate mode: the pen owns the surface there. */
  enabled?: boolean;
  /**
   * Where the marker layer paints, when the board offers one.
   *
   * Board's marks slot carries the same transform as the page but sits above
   * the ink, so a mark stays reachable while the pen owns the surface. Falling
   * back to rendering in place keeps the layer usable on its own.
   */
  marksHost?: HTMLElement | null;
  /**
   * Highlighter mode — sweep a rectangle instead of picking words.
   *
   * The one gesture that works where selection cannot: a scanned page, a
   * figure, a diagram. No hold is needed because the tool *is* the mode, so a
   * drag means this and nothing else while it is on.
   */
  highlighting?: boolean;
  footnotes?: readonly DocFootnote[];
  onCoach?: (selection: DocSelectionResult) => void;
  onCopy?: (selection: DocSelectionResult) => void;
  onSearch?: (selection: DocSelectionResult) => void;
  /** Leave the mark and nothing else — the highlighter's plain outcome. */
  onMark?: (selection: DocSelectionResult) => void;
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

/**
 * Where a mark sits, in the body's own coordinates.
 *
 * Both anchor kinds end up here, because a ribbon does not care how its mark
 * was made. A text anchor resolves to a range and takes its first line's box; a
 * region already *is* a box, in its scope's coordinates, so it only needs
 * shifting by where that scope sits in the body.
 */
function rectForAnchor(
  body: HTMLElement,
  root: HTMLElement,
  anchor: DocAnchor,
): LocalRect | null {
  if (isRegionAnchor(anchor)) {
    const scale = scaleOf(body) || 1;
    const bodyBox = body.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    const offsetX = (rootBox.left - bodyBox.left) / scale;
    const offsetY = (rootBox.top - bodyBox.top) / scale;
    return {
      left: anchor.x + offsetX,
      top: anchor.y + offsetY,
      width: anchor.w,
      height: anchor.h,
    };
  }
  const range = rangeFromAnchor(root, anchor);
  if (!range) return null;
  const [first] = localRects(body, range);
  return first ?? null;
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
  enabled = true,
  marksHost = null,
  highlighting = false,
  footnotes = [],
  onCoach,
  onCopy,
  onSearch,
  onMark,
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
  const [ribbons, setRibbons] = useState<
    Array<{ footnote: DocFootnote; at: LocalRect; number: number }>
  >([]);
  const [copied, setCopied] = useState(false);
  /** The band being swept right now, in body coordinates. */
  const [band, setBand] = useState<LocalRect | null>(null);
  const bandRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  /** Latest placement pass, so the window observer can re-run it. */
  const placeRef = useRef<(() => void) | null>(null);

  /** Live gesture: null between holds. */
  const holdRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    timer: number | null;
    held: boolean;
    /** The scope the hold landed in — the drag stays inside it. */
    root: HTMLElement | null;
    scope: string | undefined;
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
    setBand(null);
    setCopied(false);
  }, []);

  /**
   * Where a viewport point lands: which scope, and how far into its text.
   *
   * Offsets are local to a scope root — see `docAnchors`. That is what keeps
   * resolving a mark on page 900 from walking the 899 pages in front of it.
   */
  const pointAt = useCallback(
    (x: number, y: number): { root: HTMLElement; scope?: string; offset: number } | null => {
      const body = bodyRef.current;
      if (!body) return null;
      const caret = caretAt(x, y);
      if (!caret || !body.contains(caret.node)) return null;
      const scope = scopeOfNode(body, caret.node);
      const root = (scopeRootIn(body, scope) as HTMLElement | null) ?? body;
      const range = document.createRange();
      range.setStart(caret.node, caret.offset);
      range.collapse(true);
      const offset = anchorFromRange(root, expandOne(root, range))?.start;
      return offset == null ? null : { root, scope, offset };
    },
    [],
  );

  /**
   * Paint (and remember) the selection between two offsets in one scope.
   *
   * A drag that wanders onto the next page is clamped to the page it started
   * on rather than being allowed to span both. Two pages are two offset
   * spaces, so a quote across the seam has no single anchor that could name
   * it — and a quote that silently stopped being storable would be worse than
   * one that stops at the page break the reader can see.
   */
  const applySelection = useCallback(
    (root: HTMLElement, scope: string | undefined, from: number, to: number) => {
      const text = textOf(root);
      const [start, end] = snapToWords(
        text,
        Math.min(from, to),
        Math.max(from, to) + (from === to ? 1 : 0),
      );
      if (end <= start) return;
      const anchor: DocAnchor = { kind: "text", start, end, ...(scope ? { scope } : {}) };
      const range = rangeFromAnchor(root, anchor);
      if (!range) return;
      // Sliced from the stream, not from the range: `Range.toString()` fuses
      // across block boundaries, which is exactly what the stream's separators
      // exist to prevent.
      const quoted = text.slice(start, end);
      const body = bodyRef.current;
      setRects(body ? localRects(body, range) : []);
      setSelection({ text: quoted, excerpt: excerptOf(quoted), anchor });
    },
    [],
  );

  useEffect(() => {
    if (!enabled && !highlighting) {
      clearGesture();
      dismiss();
    }
  }, [enabled, highlighting, clearGesture, dismiss]);

  /**
   * The highlighter sweep.
   *
   * A rubber band rather than a stroke that follows the finger: a band is what
   * both jobs want — dragged along a line it is a highlight, dragged around a
   * figure it is a crop — and one gesture that does both is one thing to learn.
   * A minimum height keeps a fast flat sweep from producing a hairline nobody
   * can see or hit afterwards.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !highlighting) return;

    const rectOf = (x: number, y: number) => {
      const start = bandRef.current;
      const body = bodyRef.current;
      if (!start || !body) return null;
      const origin = body.getBoundingClientRect();
      const scale = scaleOf(body) || 1;
      const left = (Math.min(start.startX, x) - origin.left) / scale;
      const top = (Math.min(start.startY, y) - origin.top) / scale;
      const width = Math.abs(x - start.startX) / scale;
      const height = Math.max(Math.abs(y - start.startY) / scale, MIN_BAND_PX);
      return { left, top, width, height };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if ((event.target as Element | null)?.closest?.(".lc-doc-footnote")) return;
      dismiss();
      bandRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      // The board must not pan under a sweep.
      claimSelectionGesture();
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      const start = bandRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      event.preventDefault();
      setBand(rectOf(event.clientX, event.clientY));
    };

    const onPointerUp = (event: PointerEvent) => {
      const start = bandRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      // Measured before the ref is cleared — `rectOf` reads it.
      const rect = rectOf(event.clientX, event.clientY);
      bandRef.current = null;
      releaseSelectionGesture();
      const body = bodyRef.current;
      if (!rect || !body || rect.width < MIN_BAND_PX) {
        setBand(null);
        return;
      }
      /*
       * The scope the sweep started in owns it.
       *
       * A band that strays onto the next page still belongs to the page the
       * reader was working on — and a region anchor lives in one scope's
       * coordinates, so there is no honest way to store one that spans two.
       */
      const scopeRoot =
        (document.elementFromPoint(start.startX, start.startY) as Element | null)?.closest?.(
          `[${SCOPE_ATTR}]`,
        ) ?? null;
      const root = (scopeRoot as HTMLElement | null) ?? body;
      const scope = scopeRoot?.getAttribute(SCOPE_ATTR) ?? undefined;
      const scale = scaleOf(body) || 1;
      const bodyBox = body.getBoundingClientRect();
      const anchor = regionAnchorFromRect(
        root,
        {
          left: bodyBox.left + rect.left * scale,
          top: bodyBox.top + rect.top * scale,
          width: rect.width * scale,
          height: rect.height * scale,
        },
        scope,
      );
      if (!anchor) {
        setBand(null);
        return;
      }
      // Words under the band, when there are any — a highlight over prose can
      // still be quoted; over a scanned plate the excerpt is simply empty.
      const text = textUnder(body, rect, scale, bodyBox);
      setBand(rect);
      setSelection({ text, excerpt: excerptOf(text), anchor });
      setSheetAt({ x: event.clientX, y: event.clientY });
    };

    host.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      host.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      releaseSelectionGesture();
    };
  }, [highlighting, dismiss]);

  // The gesture. Listeners go on the window for move/up so a drag that leaves
  // the words — off the end of a paragraph, past the edge of the page — keeps
  // extending the selection instead of silently ending it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled || highlighting) return;

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
          const at = pointAt(startX, startY);
          if (!at) {
            clearGesture();
            return;
          }
          hold.held = true;
          hold.timer = null;
          hold.root = at.root;
          hold.scope = at.scope;
          hold.anchorOffset = at.offset;
          // Board's pan must let go before the drag below starts moving.
          claimSelectionGesture();
          try {
            navigator.vibrate?.(10);
          } catch {
            /* haptics are a nicety */
          }
          applySelection(at.root, at.scope, at.offset, at.offset);
        }, LONG_PRESS_MS),
        held: false,
        root: null,
        scope: undefined,
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
      const at = pointAt(event.clientX, event.clientY);
      if (!at || hold.anchorOffset == null || !hold.root) return;
      // Wandered onto another page: hold the selection at this page's edge
      // rather than following, since the two are different offset spaces.
      const offset = at.root === hold.root ? at.offset : hold.anchorOffset;
      applySelection(hold.root, hold.scope, hold.anchorOffset, offset);
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
  }, [enabled, highlighting, applySelection, clearGesture, dismiss, pointAt]);

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
   *
   * The window comes for free from the renderer. Resolving a mark walks its own
   * scope's text and nothing else, and a page the renderer has not painted has
   * no text — so a mark a thousand pages away costs a failed lookup rather than
   * a walk of the book, and lands the moment its page is painted and the
   * mutation observer above notices. Keeping a second window here, on a
   * different rule from the renderer's, is what previously left a mark on the
   * next page unplaced while its text sat there ready.
   */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      setRibbons([]);
      return;
    }

      const numbers = numberFootnotes(footnotes);
    const place = () => {
      const roots = scopeRootsIn(body);
      // Numbering follows the document, so the sort has to know page order.
      orderScopes(roots.map((root) => root.dataset.docScope ?? ""));
      const placed: Array<{ footnote: DocFootnote; at: LocalRect; number: number }> = [];
      for (const footnote of footnotes) {
        const scope = footnote.anchor.scope;
        const root = scopeRootIn(body, scope) as HTMLElement | null;
        if (!root) continue;
        const at = rectForAnchor(body, root, footnote.anchor);
        if (!at) continue;
        placed.push({ footnote, at, number: numbers.get(footnote.id) ?? 0 });
      }
      setRibbons(placed);
    };
    placeRef.current = place;
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
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      placeRef.current = null;
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [footnotes, children]);



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
      {overlay(
        marksHost,
        <div
          className="lc-doc-select-overlay"
          aria-hidden={rects.length === 0}
        >
          {band && (
            <div
              className="lc-doc-highlight-band"
              style={{
                left: band.left,
                top: band.top,
                width: band.width,
                height: band.height,
              }}
            />
          )}
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
          {ribbons.map(({ footnote, at, number }) => (
            <button
              type="button"
              key={footnote.id}
              className={`lc-doc-footnote lc-doc-footnote-${footnote.kind}`}
              style={
                isRegionAnchor(footnote.anchor)
                  ? {
                      left: at.left,
                      top: at.top,
                      width: at.width,
                      height: at.height,
                    }
                  : { left: at.left + at.width, top: at.top }
              }
              data-region={isRegionAnchor(footnote.anchor) ? "" : undefined}
              title={footnoteTitle(footnote, number)}
              aria-label={footnoteTitle(footnote, number)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onOpenFootnote?.(footnote)}
              onContextMenu={(event) => {
                event.preventDefault();
                onRemoveFootnote?.(footnote);
              }}
            >
              <span className="lc-doc-footnote-tag">{number}</span>
            </button>
          ))}
        </div>,
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
              <p className="lc-doc-sheet-excerpt">
                {selection.excerpt || "This area of the page"}
              </p>
              <div className="lc-doc-sheet-actions">
                {/*
                  A highlight over a scanned plate has no words in it, so Copy
                  and Google have nothing to act on and are not offered. Coach
                  always is — it gets the crop.
                */}
                {onMark && (
                  <button type="button" role="menuitem" onClick={() => act(onMark)}>
                    Mark
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => act(onCoach)}>
                  Coach
                </button>
                {selection.text.trim().length > 0 && (
                  <>
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
                  </>
                )}
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


/** What a ribbon says on hover, and to a screen reader. */
function footnoteTitle(footnote: DocFootnote, number: number): string {
  const what = footnote.excerpt || "this area";
  switch (footnote.kind) {
    case "search":
      return `${number}. Search — ${footnote.query ?? what}`;
    case "note":
      return `${number}. Highlight — ${what}`;
    default:
      return `${number}. Coach — ${what}`;
  }
}


/**
 * Paint the marker layer into the board's marks slot when there is one.
 *
 * In place otherwise, which is what the layer does on its own and what keeps it
 * testable without a board around it.
 */
function overlay(host: HTMLElement | null, node: React.ReactNode): React.ReactNode {
  return host ? createPortal(node, host) : node;
}


/**
 * The words a swept band covers, if any.
 *
 * A highlight over prose should still be quotable — the coach can be told what
 * it says as well as shown it — but over a scanned plate or a figure there is
 * nothing there, and an empty string is the honest answer rather than a
 * failure. Text nodes are tested by their own boxes, so a band that clips a
 * line's descenders still counts that line.
 */
function textUnder(
  body: HTMLElement,
  rect: LocalRect,
  scale: number,
  bodyBox: DOMRect,
): string {
  const left = bodyBox.left + rect.left * scale;
  const top = bodyBox.top + rect.top * scale;
  const right = left + rect.width * scale;
  const bottom = top + rect.height * scale;
  const parts: string[] = [];
  for (const node of textNodesOf(body)) {
    if (!node.data.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const overlaps =
      box.left < right && box.right > left && box.top < bottom && box.bottom > top;
    if (overlaps) parts.push(node.data);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
