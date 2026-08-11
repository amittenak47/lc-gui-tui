/**
 * Picking a region (or the words under it) out of the page, in Scroll mode.
 *
 * The gesture is hold-then-drag a marquee box. Drag alone scrolls the page; a
 * tap must stay free for reading. Holding is the only thing a reader never does
 * by accident, so it is safe to enter selection mode.
 *
 * Native text selection is not used. On a tablet WebView it fights
 * `touch-action: none`, and system handles sit in screen space over a scaled
 * scene. The marquee paints in the page's own coordinates (same idea as ink),
 * and persists as a {@link RegionAnchor} — text under the box is optional.
 *
 * Annotate mode turns this layer off (`enabled=false`) unless the highlighter
 * tool is on; there the pen owns the surface.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  isRegionAnchor,
  rangeFromAnchor,
  scopeRootIn,
  scopeRootsIn,
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
import { HOLD_SENSITIVE_MS, LONG_PRESS_MS, SELECT_HOLD_SLOP_PX } from "../util/gesture";
import {
  claimSelectionGesture,
  isDocCameraLive,
  requestDocScroll,
  onDocCameraLiveChange,
  releaseSelectionGesture,
} from "../canvas/docSelectionGesture";
import { horizontalScrollHost } from "../canvas/scrollHost";
import {
  MIN_BAND_PX,
  type LocalRect,
  bandFromLocalPoints,
  finalizeMarquee,
  hitRectsUnder,
  scaleOf,
  scopeRootAtPoint,
  viewportToLocal,
} from "../util/docMarquee";

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
    element?.closest?.(".lc-doc-footnote, .lc-doc-confirm, .lc-footnote-overview, .lc-footnote-bubble"),
  );
}

/** How far into the edge a drag has to reach before the page starts moving. */
const SELECT_EDGE_PX = 36;
/** Per-frame travel at the boundary, and at full lean. */
const SELECT_EDGE_STEP_MIN_PX = 2;
const SELECT_EDGE_STEP_MAX_PX = 22;
/** Lean past the edge, in pixels, at which the scroll reaches full speed. */
const SELECT_EDGE_RAMP_PX = 90;

/**
 * Per-frame scroll for a finger `over` pixels past the edge.
 *
 * Ramped rather than constant so the boundary is usable: a fixed step fast
 * enough to cross a page is far too fast to stop on a word, and one slow enough
 * to be precise never gets anywhere. Nudging the edge creeps; pinning the screen
 * edge moves at reading speed.
 */
function edgeStep(over: number): number {
  const lean = Math.min(1, Math.abs(over) / SELECT_EDGE_RAMP_PX);
  return SELECT_EDGE_STEP_MIN_PX + (SELECT_EDGE_STEP_MAX_PX - SELECT_EDGE_STEP_MIN_PX) * lean;
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
   * Highlighter mode — same marquee, but armed immediately (no hold).
   *
   * Annotate-only: the tool *is* the mode, so a drag means this and nothing
   * else while it is on. Reading mode uses hold-then-marquee instead.
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
  /** Content blocks intersecting the live marquee (chrome only). */
  const [hitRects, setHitRects] = useState<LocalRect[]>([]);
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
  /** The edge auto-scroll's frame, null when the finger is not at an edge. */
  const edgeFrameRef = useRef<number | null>(null);
  /** Latest placement pass, so the window observer can re-run it. */
  const placeRef = useRef<(() => void) | null>(null);

  /**
   * Live hold→marquee gesture.
   *
   * `startLocal` is body layout coords at hold-fire — fixed while the page
   * scrolls under the finger, so edge auto-scroll can grow the band correctly.
   */
  const holdRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    timer: number | null;
    armTimer: number | null;
    held: boolean;
    root: HTMLElement | null;
    scope: string | undefined;
    startLocal: { x: number; y: number } | null;
    lastX: number;
    lastY: number;
    sideScroll: HTMLElement | null;
  } | null>(null);

  const clearGesture = useCallback(() => {
    if (edgeFrameRef.current != null) {
      cancelAnimationFrame(edgeFrameRef.current);
      edgeFrameRef.current = null;
    }
    const hold = holdRef.current;
    if (hold?.timer != null) window.clearTimeout(hold.timer);
    if (hold?.armTimer != null) window.clearTimeout(hold.armTimer);
    holdRef.current = null;
    hostRef.current?.classList.remove("lc-doc-selecting", "lc-doc-select-mode");
    releaseSelectionGesture();
  }, []);

  const dismiss = useCallback(() => {
    setSelection(null);
    setPhase("idle");
    setRects([]);
    setBand(null);
    setHitRects([]);
    setCopied(false);
  }, []);

  const paintMarquee = useCallback((rect: LocalRect, root: HTMLElement) => {
    const body = bodyRef.current;
    if (!body) return;
    setBand(rect);
    setHitRects(hitRectsUnder(body, root, rect));
  }, []);

  useEffect(() => {
    if (!enabled && !highlighting) {
      clearGesture();
      dismiss();
    }
  }, [enabled, highlighting, clearGesture, dismiss]);

  /**
   * Annotate highlighter: immediate marquee (no hold).
   * Same finalize path as reading-mode hold→marquee.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !highlighting) return;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (isOverlayControl(event.target)) return;
      dismiss();
      bandRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      claimSelectionGesture();
      host.classList.add("lc-doc-selecting", "lc-doc-select-mode");
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      const start = bandRef.current;
      const body = bodyRef.current;
      if (!start || start.pointerId !== event.pointerId || !body) return;
      event.preventDefault();
      const a = viewportToLocal(body, start.startX, start.startY);
      const b = viewportToLocal(body, event.clientX, event.clientY);
      const rect = bandFromLocalPoints(body, a, b);
      const { root } = scopeRootAtPoint(body, start.startX, start.startY);
      paintMarquee(rect, root);
    };

    const onPointerUp = (event: PointerEvent) => {
      const start = bandRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      bandRef.current = null;
      host.classList.remove("lc-doc-selecting", "lc-doc-select-mode");
      releaseSelectionGesture();
      const body = bodyRef.current;
      if (!body) {
        setBand(null);
        setHitRects([]);
        return;
      }
      const a = viewportToLocal(body, start.startX, start.startY);
      const b = viewportToLocal(body, event.clientX, event.clientY);
      const rect = bandFromLocalPoints(body, a, b);
      if (rect.width * (scaleOf(body) || 1) < MIN_BAND_PX) {
        setBand(null);
        setHitRects([]);
        return;
      }
      const { root, scope } = scopeRootAtPoint(body, start.startX, start.startY);
      const done = finalizeMarquee(body, rect, root, scope);
      if (!done) {
        setBand(null);
        setHitRects([]);
        return;
      }
      paintMarquee(rect, root);
      setSelection({ text: done.text, excerpt: done.excerpt, anchor: done.anchor });
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
      host.classList.remove("lc-doc-selecting", "lc-doc-select-mode");
      releaseSelectionGesture();
    };
  }, [highlighting, dismiss, paintMarquee]);

  // Reading mode: hold to arm selection mode, then drag a marquee box.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled || highlighting) return;

    const paintFromFinger = (hold: NonNullable<typeof holdRef.current>) => {
      const body = bodyRef.current;
      if (!body || !hold.startLocal || !hold.root) return;
      const end = viewportToLocal(body, hold.lastX, hold.lastY);
      const rect = bandFromLocalPoints(body, hold.startLocal, end);
      paintMarquee(rect, hold.root);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
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
          const body = bodyRef.current;
          if (!hold || !body) return;
          // No caret required — empty margin / figure still arms selection.
          const { root, scope } = scopeRootAtPoint(body, startX, startY);
          hold.held = true;
          hold.timer = null;
          if (hold.armTimer != null) {
            window.clearTimeout(hold.armTimer);
            hold.armTimer = null;
          }
          hold.root = root;
          hold.scope = scope;
          hold.startLocal = viewportToLocal(body, startX, startY);
          hold.sideScroll =
            horizontalScrollHost(document.elementFromPoint(startX, startY)) ??
            horizontalScrollHost(root);
          claimSelectionGesture();
          try {
            host.setPointerCapture(hold.pointerId);
          } catch {
            /* window listeners still run */
          }
          host.classList.add("lc-doc-selecting", "lc-doc-select-mode");
          // Tiny starter band so the mode is visible before the drag grows it.
          paintFromFinger(hold);
          if (edgeFrameRef.current == null) {
            edgeFrameRef.current = requestAnimationFrame(autoScroll);
          }
          try {
            navigator.vibrate?.(10);
          } catch {
            /* haptics are a nicety */
          }
        }, LONG_PRESS_MS),
        held: false,
        root: null,
        scope: undefined,
        startLocal: null,
        lastX: startX,
        lastY: startY,
        sideScroll: null,
      };
    };

    const autoScroll = () => {
      const hold = holdRef.current;
      if (!hold?.held) {
        edgeFrameRef.current = null;
        return;
      }
      const { lastX: x, lastY: y } = hold;
      let moved = false;

      const side = hold.sideScroll;
      if (side) {
        const box = side.getBoundingClientRect();
        const over =
          x > box.right - SELECT_EDGE_PX
            ? x - (box.right - SELECT_EDGE_PX)
            : x < box.left + SELECT_EDGE_PX
              ? x - (box.left + SELECT_EDGE_PX)
              : 0;
        if (over !== 0) {
          const before = side.scrollLeft;
          side.scrollLeft += Math.sign(over) * edgeStep(over);
          if (side.scrollLeft !== before) moved = true;
        }
      }

      const view = hostRef.current?.getBoundingClientRect();
      const top = view ? Math.max(view.top, 0) : 0;
      const bottom = view ? Math.min(view.bottom, window.innerHeight) : window.innerHeight;
      const overY =
        y > bottom - SELECT_EDGE_PX
          ? y - (bottom - SELECT_EDGE_PX)
          : y < top + SELECT_EDGE_PX
            ? y - (top + SELECT_EDGE_PX)
            : 0;
      if (overY !== 0 && requestDocScroll(Math.sign(overY) * edgeStep(overY)) !== 0) {
        moved = true;
      }

      if (moved) paintFromFinger(hold);
      edgeFrameRef.current = requestAnimationFrame(autoScroll);
    };

    const onPointerMove = (event: PointerEvent) => {
      const hold = holdRef.current;
      if (!hold || hold.pointerId !== event.pointerId) return;
      if (!hold.held) {
        const moved = Math.hypot(event.clientX - hold.startX, event.clientY - hold.startY);
        if (moved > SELECT_HOLD_SLOP_PX) clearGesture();
        return;
      }
      event.preventDefault();
      hold.lastX = event.clientX;
      hold.lastY = event.clientY;
      paintFromFinger(hold);
    };

    const finishHold = (event: PointerEvent, confirm: boolean) => {
      const hold = holdRef.current;
      if (!hold || hold.pointerId !== event.pointerId) return;
      const held = hold.held;
      const body = bodyRef.current;
      const root = hold.root;
      const scope = hold.scope;
      const startLocal = hold.startLocal;
      const lastX = hold.lastX;
      const lastY = hold.lastY;
      try {
        host.releasePointerCapture(hold.pointerId);
      } catch {
        /* already released */
      }
      clearGesture();
      if (!held || !confirm || !body || !root || !startLocal) return;
      const end = viewportToLocal(body, lastX, lastY);
      const rect = bandFromLocalPoints(body, startLocal, end);
      if (rect.width * (scaleOf(body) || 1) < MIN_BAND_PX) {
        setBand(null);
        setHitRects([]);
        return;
      }
      const done = finalizeMarquee(body, rect, root, scope);
      if (!done) {
        setBand(null);
        setHitRects([]);
        return;
      }
      paintMarquee(rect, root);
      setSelection({ text: done.text, excerpt: done.excerpt, anchor: done.anchor });
      setPhase("confirm");
    };

    const onPointerUp = (event: PointerEvent) => finishHold(event, true);
    const onPointerCancel = (event: PointerEvent) => finishHold(event, false);
    const onSelectStart = (event: Event) => event.preventDefault();

    host.addEventListener("selectstart", onSelectStart);
    host.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      host.removeEventListener("selectstart", onSelectStart);
      host.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      releaseSelectionGesture();
    };
  }, [enabled, highlighting, clearGesture, dismiss, paintMarquee]);

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
    // One-shot on deps: ribbons still ride marksSlot transform during pan.
    place();

    /*
     * Nested horizontal scroll moves the words under a fixed camera. Ribbons
     * are placed from client rects — without re-measuring on host scroll they
     * stay where the quote was when the mark was made. Capture on the body so
     * late-mounted PDF/EPUB text layers still fire.
     */
    let placementDeferred = false;
    let scrollFrame: number | null = null;
    const onHostScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!horizontalScrollHost(target)) return;
      if (isDocCameraLive()) {
        placementDeferred = true;
        return;
      }
      // Coalesce — scroll fires every frame and synchronous place() was
      // thrashing ribbons / layout while ink tried to paint.
      if (scrollFrame != null) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = null;
        place();
      });
    };
    body.addEventListener("scroll", onHostScroll, { capture: true, passive: true });

    /*
     * Live mutation watching is for reading / highlight — text layers land
     * after mount. Annotate keeps the layer mounted (`enabled=false`) so the
     * pen can draw, but re-placing ribbons on every PDF window mutation mid-
     * flick starves ink tile paint until scroll settle.
     */
    const watchMutations = enabled || highlighting;
    let frame: number | null = null;
    if (!watchMutations || footnotes.length === 0 || typeof MutationObserver !== "function") {
      return () => {
        body.removeEventListener("scroll", onHostScroll, true);
        if (scrollFrame != null) cancelAnimationFrame(scrollFrame);
        placeRef.current = null;
      };
    }

    // Coalesced to a frame: a text layer lands as hundreds of appended spans,
    // and re-measuring on each one would be a layout read per span.
    const schedulePlace = () => {
      if (isDocCameraLive()) {
        placementDeferred = true;
        return;
      }
      place();
    };
    const observer = new MutationObserver(() => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        schedulePlace();
      });
    });
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    onDocCameraLiveChange((live) => {
      if (live || !placementDeferred) return;
      placementDeferred = false;
      place();
    });
    return () => {
      observer.disconnect();
      onDocCameraLiveChange(null);
      body.removeEventListener("scroll", onHostScroll, true);
      placeRef.current = null;
      if (frame != null) cancelAnimationFrame(frame);
      if (scrollFrame != null) cancelAnimationFrame(scrollFrame);
    };
  }, [footnotes, children, enabled, highlighting]);



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
      document.querySelectorAll(
        ".lc-doc-select-rect, .lc-doc-highlight-band, .lc-doc-marquee-band, .lc-doc-marquee-hit",
      ),
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
              className={
                highlighting ? "lc-doc-highlight-band" : "lc-doc-marquee-band"
              }
              style={{
                left: band.left,
                top: band.top,
                width: band.width,
                height: band.height,
              }}
            />
          )}
          {hitRects.map((rect, index) => (
            <div
              key={`hit-${index}`}
              className="lc-doc-marquee-hit"
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }}
            />
          ))}
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
              holdThrough
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
