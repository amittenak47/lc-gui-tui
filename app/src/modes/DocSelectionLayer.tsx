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
import {
  footnoteAtSamePlace,
  numberFootnotes,
  orderScopes,
  overlappingFootnotes,
  type DocFootnote,
} from "../util/docFootnotes";
import { HoldButton } from "../components/HoldButton";
import { HOLD_SENSITIVE_MS, LONG_PRESS_MS } from "../util/gesture";
import {
  claimSelectionGesture,
  releaseSelectionGesture,
} from "../canvas/docSelectionGesture";

/**
 * Controls painted over the page that own their own taps.
 *
 * The host's `pointerdown` listener is native and sits inside the React tree,
 * so it runs *before* React's synthetic handlers — a `stopPropagation` on the
 * control itself is too late, and the selection would already have been thrown
 * away by the time its own click arrived. Everything the overlay draws on top
 * of the words has to be named here.
 */
function isOverlayControl(target: EventTarget | null): boolean {
  const element = target as Element | null;
  return Boolean(
    element?.closest?.(".lc-doc-footnote, .lc-doc-confirm, .lc-footnote-overview"),
  );
}

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
  onAnnotate?: (selection: DocSelectionResult, anchorRect: DOMRect | null) => void;
  onCopy?: (selection: DocSelectionResult, anchorRect: DOMRect | null) => void;
  onSearch?: (selection: DocSelectionResult, anchorRect: DOMRect | null) => void;
  /** Leave the mark and nothing else — the highlighter's plain outcome. */
  onMark?: (selection: DocSelectionResult, anchorRect: DOMRect | null) => void;
  /** Tap on an existing ribbon — reopen the overview for that mark. */
  onOpenFootnote?: (footnote: DocFootnote, anchorRect: DOMRect | null) => void;
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
  onAnnotate,
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
  /**
   * How far along the selection is: still being dragged, waiting to be
   * confirmed, or confirmed and showing what can be done with it.
   *
   * The middle state is the one that was missing. The actions used to open the
   * instant the finger lifted, which meant every hold that ended slightly wrong
   * — and on a tablet that is most of them — put a menu on screen that had to be
   * dismissed before the reader could try again. A tick and a cross beside the
   * words is a chance to say "not that" without the menu ever appearing.
   */
  const [phase, setPhase] = useState<"idle" | "confirm" | "actions">("idle");
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
  /**
   * Where each ribbon is on screen, so the card it opens can hang off it.
   *
   * Kept from the rendered node rather than recomputed: the ribbons live under
   * the board's transform, and their own boxes already answer in the viewport
   * coordinates a fixed-position card needs.
   */
  const ribbonRects = useRef(new Map<string, DOMRect>());
  /** Latest placement pass, so the window observer can re-run it. */
  const placeRef = useRef<(() => void) | null>(null);

  /** Live gesture: null between holds. */
  const holdRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    timer: number | null;
    /** Capture early so the compositor cannot cancel mid-hold. */
    armTimer: number | null;
    held: boolean;
    /** The scope the hold landed in — the drag stays inside it. */
    root: HTMLElement | null;
    scope: string | undefined;
    anchorOffset: number | null;
    /** Last resolved drag offset — used when caret hit-testing blanks out. */
    lastOffset: number | null;
  } | null>(null);

  const clearGesture = useCallback(() => {
    const hold = holdRef.current;
    if (hold?.timer != null) window.clearTimeout(hold.timer);
    if (hold?.armTimer != null) window.clearTimeout(hold.armTimer);
    holdRef.current = null;
    hostRef.current?.classList.remove("lc-doc-selecting");
    releaseSelectionGesture();
  }, []);

  const dismiss = useCallback(() => {
    setSelection(null);
    setPhase("idle");
    setRects([]);
    setBand(null);
    setCopied(false);
  }, []);

  /**
   * Where a viewport point lands: which scope, and how far into its text.
   *
   * Offsets are local to a scope root — see `docAnchors`. That is what keeps
   * resolving a mark on page 900 from walking the 899 pages in front of it.
   *
   * **The point does not have to be on a glyph.** `caretRangeFromPoint` answers
   * for text and nothing else, and most of a real drag is not over text: the
   * margins either side of the column, the gaps between paragraphs, the space
   * past the end of a short line, everything below the last line. Taking `null`
   * for an answer there is why a drag appeared to select one word and then stop
   * — every move that left the run of letters it started on was discarded, so
   * dragging *down* through a paragraph never extended anything.
   *
   * So a miss is retried against the column rather than given up on: the x is
   * pulled inside the text's own box, which turns "somewhere in the left
   * margin, four lines down" into "the start of that line". Past the bottom of
   * the document it resolves to the end of the text, which is what dragging off
   * the end of a page is asking for.
   */
  const pointAt = useCallback(
    (
      x: number,
      y: number,
      preferred?: HTMLElement | null,
    ): { root: HTMLElement; scope?: string; offset: number } | null => {
      const body = bodyRef.current;
      if (!body) return null;

      const resolve = (
        at: { node: Node; offset: number } | null,
      ): { root: HTMLElement; scope?: string; offset: number } | null => {
        if (!at || !body.contains(at.node)) return null;
        const scope = scopeOfNode(body, at.node);
        const root = (scopeRootIn(body, scope) as HTMLElement | null) ?? body;
        const range = document.createRange();
        range.setStart(at.node, at.offset);
        range.collapse(true);
        const offset = anchorFromRange(root, expandOne(root, range))?.start;
        return offset == null ? null : { root, scope, offset };
      };

      const direct = resolve(caretAt(x, y));
      if (direct) return direct;

      /*
       * Code `<pre>` blocks often miss at the raw finger point (scroll, indent,
       * touch-action). Probe inside the pre's box at the finger's x before
       * falling back to the whole column edges — that fallback is what made a
       * drag freeze on `def` instead of reaching `__init__`.
       */
      const under = document.elementFromPoint(x, y);
      const pre = under?.closest?.("pre");
      if (pre instanceof HTMLElement && body.contains(pre)) {
        const box = pre.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          const inset = Math.min(6, box.width / 4);
          const clampedY = Math.min(Math.max(y, box.top + 1), box.bottom - 1);
          const xs = [
            Math.min(Math.max(x, box.left + inset), box.right - inset),
            box.left + inset,
            box.right - inset,
          ];
          for (const candidateX of xs) {
            const hit = resolve(caretAt(candidateX, clampedY));
            if (hit) return hit;
          }
        }
      }

      /*
       * Retry inside the column the drag belongs to.
       *
       * The scope the hold started in when there is one, so a drag down the
       * side of page 40 does not get pulled into page 41's margin; the whole
       * body otherwise.
       */
      const column = preferred ?? body;
      const box = column.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return null;

      const inset = Math.min(8, box.width / 4);
      // Left edge first when the finger is left of the text, right edge when it
      // is right of it — the reading order of the line either way.
      const candidates =
        x < box.left
          ? [box.left + inset, box.right - inset]
          : [box.right - inset, box.left + inset];
      const clampedY = Math.min(Math.max(y, box.top + 1), box.bottom - 1);
      for (const candidateX of candidates) {
        const hit = resolve(caretAt(candidateX, clampedY));
        if (hit) return hit;
      }

      // Below everything: the end of the text. Above it: the beginning. A drag
      // that runs off the page should take the rest of the page with it.
      if (y > box.bottom || y < box.top) {
        const scope = column.getAttribute?.(SCOPE_ATTR) ?? undefined;
        const root = column;
        return {
          root,
          scope,
          offset: y > box.bottom ? textOf(root).length : 0,
        };
      }
      return null;
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
      if (isOverlayControl(event.target)) return;
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
      // Same confirmation step as a text quote — a swept band is at least as
      // easy to get slightly wrong.
      setPhase("confirm");
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
      if (isOverlayControl(event.target)) return;
      dismiss();
      clearGesture();
      const startX = event.clientX;
      const startY = event.clientY;
      holdRef.current = {
        pointerId: event.pointerId,
        startX,
        startY,
        armTimer: window.setTimeout(() => {
          const hold = holdRef.current;
          if (!hold || hold.held) return;
          try {
            host.setPointerCapture(hold.pointerId);
          } catch {
            /* pointer may already be gone */
          }
        }, 140),
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
          if (hold.armTimer != null) {
            window.clearTimeout(hold.armTimer);
            hold.armTimer = null;
          }
          hold.root = at.root;
          hold.scope = at.scope;
          hold.anchorOffset = at.offset;
          hold.lastOffset = at.offset;
          // Board's pan must let go before the drag below starts moving.
          claimSelectionGesture();
          /*
           * Take the pointer, now that the hold has earned it.
           *
           * Without capture the browser is still entitled to decide the gesture
           * was a scroll and take it away — `pointercancel`, mid-word, and the
           * quote is whatever single word the hold started on. That is the
           * failure that made dragging feel like it only ever selected one
           * word. Capture also routes moves that leave the element back here,
           * so a drag off the end of a line keeps extending.
           */
          try {
            host.setPointerCapture(hold.pointerId);
          } catch {
            /* the pointer may already be gone — the window listeners still run */
          }
          /*
           * Nothing under the finger may scroll while the hold has it.
           *
           * A document is full of things that scroll on their own — a wide code
           * block, a table, a PDF page too wide for the column. Drag sideways
           * across one and the browser starts scrolling it, which both moves
           * the words out from under the selection and ends the gesture with a
           * `pointercancel`. Capture alone does not prevent that; `touch-action`
           * is what tells the compositor there is no scroll to start. Set for
           * the length of the hold only, so ordinary reading still scrolls.
           */
          host.classList.add("lc-doc-selecting");
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
        lastOffset: null,
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
      // Resolved against the scope the hold started in, so a drag that strays
      // sideways off the column comes back to *this* page's text.
      let at = pointAt(event.clientX, event.clientY, hold.root);
      // Caret blanks in `<pre>` / indent gaps — probe nearby before freezing.
      if (!at && hold.root) {
        for (const dy of [0, -6, 6, -12, 12]) {
          for (const dx of [0, -8, 8, -16, 16]) {
            if (dx === 0 && dy === 0) continue;
            at = pointAt(event.clientX + dx, event.clientY + dy, hold.root);
            if (at) break;
          }
          if (at) break;
        }
      }
      if (!at || hold.anchorOffset == null || !hold.root) {
        // Keep the last good extent rather than shrinking back to one word.
        if (hold.lastOffset != null) {
          applySelection(hold.root!, hold.scope, hold.anchorOffset!, hold.lastOffset);
        }
        return;
      }
      // Wandered onto another page: hold the selection at this page's edge
      // rather than following, since the two are different offset spaces.
      const offset = at.root === hold.root ? at.offset : hold.anchorOffset;
      hold.lastOffset = offset;
      applySelection(hold.root, hold.scope, hold.anchorOffset, offset);
    };

    /*
     * Confirm only on a real lift.
     *
     * `pointercancel` used to share this path and open ✓/✕ mid-drag whenever
     * the compositor snatched the pointer (scroll claim, palm, second touch).
     * Cancel clears the gesture but leaves the highlight; the writer lifts
     * cleanly to accept or reject.
     */
    const finishHold = (event: PointerEvent, confirm: boolean) => {
      const hold = holdRef.current;
      if (!hold || hold.pointerId !== event.pointerId) return;
      const held = hold.held;
      try {
        host.releasePointerCapture(hold.pointerId);
      } catch {
        /* already released */
      }
      clearGesture();
      if (held && confirm) setPhase("confirm");
    };

    const onPointerUp = (event: PointerEvent) => finishHold(event, true);
    const onPointerCancel = (event: PointerEvent) => finishHold(event, false);

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
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      host.removeEventListener("selectstart", onSelectStart);
      host.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
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



  /** Numbering, so an offered mark is named the way the page names it. */
  const footnoteNumbers = numberFootnotes(footnotes);
  /** The mark this selection already is, if any — see `footnoteAtSamePlace`. */
  const existingHere = selection ? footnoteAtSamePlace(footnotes, selection.anchor) : null;
  /** Marks it merely touches. The exact match is not repeated among them. */
  const overlaps = selection
    ? overlappingFootnotes(footnotes, selection.anchor).filter(
        (entry) => entry.id !== existingHere?.id,
      )
    : [];

  const act = (run: ((selection: DocSelectionResult, anchorRect: DOMRect | null) => void) | undefined) => {
    const current = selection;
    const anchorRect = highlightBox();
    if (!current || !run) return;
    run(current, anchorRect);
    dismiss();
  };

  /**
   * The selection's own box, in the same coordinates the marks are painted in.
   *
   * Everything that hangs off the selection hangs off this rather than off a
   * pointer event: the tick and cross sit on it, and the action popup is placed
   * from it. That is what makes the position honest after a gesture the browser
   * took away, and what keeps the chip on the words when the page is scrolled
   * or zoomed under it.
   */
  /**
   * The highlight's box on screen.
   *
   * Asked of the painted rects rather than recomputed from the anchor: the
   * overlay carries the page's transform, so its boxes already answer in
   * viewport coordinates at whatever zoom the reader is at — which is what a
   * fixed-position control needs, and what converting page coordinates by hand
   * would have to reconstruct.
   */
  const highlightBox = (): DOMRect | null => {
    const painted = Array.from(
      document.querySelectorAll(".lc-doc-select-rect, .lc-doc-highlight-band"),
    );
    if (painted.length === 0) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const node of painted) {
      const box = node.getBoundingClientRect();
      left = Math.min(left, box.left);
      top = Math.min(top, box.top);
      right = Math.max(right, box.right);
      bottom = Math.max(bottom, box.bottom);
    }
    return new DOMRect(left, top, right - left, bottom - top);
  };

  /**
   * Clamp a measured box into the window, with a margin.
   *
   * `offsetWidth`/`offsetHeight` rather than `getBoundingClientRect()`: the
   * measurement happens in the ref callback, on the frame the pop animation
   * starts, and a rect reports the box *as transformed* — 0.96 of its real
   * width — so clamping against it leaves the element a little wider than the
   * space that was reserved for it. The layout size is what it will settle at.
   *
   * The visual viewport, not the layout one, because on a tablet they differ
   * exactly when it matters: a pinch-zoom or a soft keyboard leaves
   * `innerWidth` describing a region larger than what the reader can see.
   */
  const clampInto = (node: HTMLElement, left: number, top: number) => {
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const view = window.visualViewport;
    const viewWidth = view?.width ?? window.innerWidth;
    const viewHeight = view?.height ?? window.innerHeight;
    const originX = view?.offsetLeft ?? 0;
    const originY = view?.offsetTop ?? 0;
    const margin = 8;
    const maxLeft = Math.max(margin, originX + viewWidth - width - margin);
    const maxTop = Math.max(margin, originY + viewHeight - height - margin);
    node.style.left = `${Math.round(Math.min(Math.max(originX + margin, left), maxLeft))}px`;
    node.style.top = `${Math.round(Math.min(Math.max(originY + margin, top), maxTop))}px`;
    node.style.visibility = "visible";
  };

  /** Tick and cross, off the selection's top-right corner. */
  const placeConfirm = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const at = highlightBox();
    if (!at) {
      clampInto(node, window.innerWidth / 2 - node.offsetWidth / 2, 12);
      return;
    }
    // Just outside the corner, and above the line rather than over the next
    // word — the same relationship a footnote marker has to its text.
    clampInto(node, at.right + 4, at.top - node.offsetHeight - 4);
  }, []);

  /**
   * Put the popup below the selection, and inside the window.
   *
   * Measured on the node rather than computed from a guess at its size,
   * because its width depends on which actions are offered — a plate with no
   * words in it has two buttons, a quote has four. It is rendered hidden at the
   * origin for exactly one frame so there is something real to measure; the
   * alternative is a menu that visibly jumps into place.
   *
   * It used to be positioned from the pointer with a `translate(-50%, 10px)`
   * and no clamp at all, which is why a quote near the right edge opened half
   * off the screen and one near the bottom opened below it.
   */
  const placeSheet = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const at = highlightBox();
    if (!at) {
      clampInto(node, window.innerWidth / 2 - width / 2, window.innerHeight / 2 - height / 2);
      return;
    }
    // Below the quote by preference; above it when there is no room underneath,
    // which is better than over the words the menu is about.
    const below = at.bottom + 10;
    const top = below + height + 8 > window.innerHeight ? at.top - height - 10 : below;
    clampInto(node, at.left + at.width / 2 - width / 2, top);
  }, []);

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
            /*
             * Tap opens the mark; holding fills it and pops it.
             *
             * `HoldButton` is what the rest of the app already means by "this
             * is destructive, so mean it" — and its fill rises from the bottom
             * on `--lc-hold`, which is exactly the water-balloon read: the
             * ribbon swells with colour and bursts. Nothing new to learn, and
             * no delete button crowding a marker that is 13 pixels wide.
             */
            <HoldButton
              key={footnote.id}
              label={String(number)}
              className={`lc-doc-footnote lc-doc-footnote-${footnote.kind}`}
              style={{
                ...(isRegionAnchor(footnote.anchor)
                  ? { left: at.left, top: at.top, width: at.width, height: at.height }
                  : { left: at.left + at.width, top: at.top }),
                // One value in; the edge and the label are derived in CSS.
                ...(footnote.color ? { ["--lc-fn-color" as string]: footnote.color } : {}),
              }}
              dataRegion={isRegionAnchor(footnote.anchor)}
              dataTip={footnoteTitle(footnote, number)}
              ariaLabel={`${footnoteTitle(footnote, number)} — tap to open, hold to delete`}
              onTap={() => {
                const rect = ribbonRects.current.get(footnote.id) ?? null;
                onOpenFootnote?.(footnote, rect);
              }}
              /*
               * The longer hold, not the default 333ms.
               *
               * A ribbon is sixteen pixels across and deleting it throws away a
               * thread or a search the reader cannot get back. `HOLD_MS` is
               * shorter than the app's own `LONG_PRESS_MS`, so a tap that
               * merely lingered would have popped the mark. `HOLD_SENSITIVE_MS`
               * is what the offline gate and the solution reveal already use
               * for "mean it".
               */
              holdMs={HOLD_SENSITIVE_MS}
              onConfirm={() => onRemoveFootnote?.(footnote)}
              onMeasure={(node: HTMLButtonElement | null) => {
                if (node) ribbonRects.current.set(footnote.id, node.getBoundingClientRect());
                else ribbonRects.current.delete(footnote.id);
              }}
            >
              <span className="lc-doc-footnote-tag">{number}</span>
            </HoldButton>
          ))}
        </div>,
      )}
      {/*
        Accept or reject, at the top-right corner of what was picked.

        Portalled to the body rather than painted into the page overlay, and
        that is not a cosmetic choice: the overlay lives inside the board, where
        the scroll gatekeeper takes pointer capture, and a control there gets no
        `click` at all — its `pointerup` is retargeted to the capturing element.
        Out here the chip is an ordinary button. It is positioned from the
        highlight's on-screen box, so it still lands on the corner of the words
        at any zoom; a selection does not outlive the gesture that made it, so
        it has nothing to track.
      */}
      {phase === "confirm" &&
        selection &&
        createPortal(
          <div className="lc-doc-confirm" ref={placeConfirm} style={{ visibility: "hidden" }}>
            <button
              type="button"
              className="lc-doc-confirm-btn lc-doc-confirm-yes"
              aria-label="Use this selection"
              title="Use this selection"
              onClick={() => {
                /*
                 * Re-marking the very same words is not a new mark.
                 *
                 * Nobody annotates one span twice on purpose — they are trying
                 * to get back to the note they already made — so this goes
                 * straight to that card instead of offering to make a
                 * duplicate beside it. Anything less than an exact match is a
                 * real new selection and gets the sheet, with the overlap
                 * listed in it.
                 */
                if (existingHere) {
                  const rect = highlightBox();
                  dismiss();
                  onOpenFootnote?.(existingHere, rect);
                  return;
                }
                setPhase("actions");
              }}
            >
              ✓
            </button>
            <button
              type="button"
              className="lc-doc-confirm-btn lc-doc-confirm-no"
              aria-label="Discard this selection"
              title="Discard this selection"
              onClick={dismiss}
            >
              ✕
            </button>
          </div>,
          document.body,
        )}
      {phase === "actions" &&
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
              ref={placeSheet}
              style={{ left: 0, top: 0, visibility: "hidden" }}
            >
              <p className="lc-doc-sheet-excerpt">
                {selection.excerpt || "This area of the page"}
              </p>
              {/*
                Marks this selection has landed on.

                Offered rather than assumed. Selecting a paragraph that happens
                to contain a marked phrase is an ordinary thing to do and makes
                a real new mark — but it is also exactly when a near-duplicate
                gets made by accident, so the note already there is one tap
                away. Built from the same rows the overview card uses.
              */}
              {overlaps.length > 0 && (
                <ul className="lc-doc-sheet-marks" aria-label="Marks on this selection">
                  {overlaps.map((footnote) => (
                    <li key={footnote.id}>
                      <button
                        type="button"
                        role="menuitem"
                        className="lc-coach-scope-option"
                        onClick={() => {
                          const rect = highlightBox();
                          dismiss();
                          onOpenFootnote?.(footnote, rect);
                        }}
                      >
                        <strong>{`Open ${footnoteNumbers.get(footnote.id) ?? ""}`.trim()}</strong>
                        <span className="lc-muted">{footnote.excerpt || "this area"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="lc-doc-sheet-actions">
                {/*
                  A highlight over a scanned plate has no words in it, so Copy
                  and Google have nothing to act on. Annotate always is — it gets
                  the crop and opens the overview card.
                */}
                {onMark && (
                  <button type="button" role="menuitem" onClick={() => act(onMark)}>
                    Mark
                  </button>
                )}
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
                <button type="button" role="menuitem" onClick={() => act(onAnnotate)}>
                  Annotate
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
