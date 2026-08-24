/**
 * Picking a quote out of the page.
 *
 * On a tablet, hold-still then drag is the quote path. Native drag-select is
 * left for mouse / highlighter: Android WebView paints a magnified copy of
 * selected text that does not follow the page camera's `translate() scale()`,
 * so the styled overlay sits on the wrong glyphs.
 *
 * Hold stillness of {@link SELECT_HOLD_ARM_MS} claims the finger; the drag
 * after that is the box. Immediate travel is pan (touch) or native select
 * (mouse).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";

import {
  SCOPE_ATTR,
  anchorFromRange,
  excerptOf,
  isRegionAnchor,
  isTextAnchor,
  rangeFromAnchor,
  scopeRootIn,
  scopeRootsIn,
  snapToWords,
  streamOffsetAt,
  textForAnchor,
  textOf,
  type DocAnchor,
} from "../util/docAnchors";
import {
  footnoteAtSamePlace,
  markChipLeft,
  numberFootnotes,
  orderScopes,
  overlappingFootnotes,
  type DocFootnote,
  type DocFootnoteSubMark,
  type DocFootnoteSubMarkKind,
} from "../util/docFootnotes";
import { AI_TAB_HEIGHT, AI_TAB_WIDTH, aiBookTabLeft, stackAiTabTops } from "../util/aiBookTabs";
import { HoldButton } from "../components/HoldButton";
import {
  HOLD_SENSITIVE_MS,
  SELECT_HOLD_ARM_MS,
  SELECT_HOLD_SLOP_PX,
} from "../util/gesture";
import {
  claimSelectionGesture,
  isDocCameraLive,
  isDocChromeTarget,
  requestDocScroll,
  onDocCameraLiveChange,
  releaseSelectionGesture,
  setSubMarkPointerHit,
} from "../canvas/docSelectionGesture";
import { horizontalScrollHost } from "../canvas/scrollHost";
import {
  MIN_BAND_PX,
  type LocalRect,
  bandFromLocalPoints,
  clientRectsToLocal,
  coversViewportBox,
  isPageCoverRect,
  finalizeMarquee,
  hitRectsUnder,
  localRectCoversHost,
  localRects,
  scaleOf,
  scopeRootAtPoint,
  textUnder,
  tightClientRects,
  tightLocalRects,
  unionLocalRects,
  unionRectsIntoBlocks,
  unionViewportBoxes,
  viewportToLocal,
} from "../util/docMarquee";
import { caretPointIn } from "../util/docSubMarkHit";
import {
  inkPaletteNow,
  onInkPaletteChange,
} from "../canvas/inkPaletteBridge";
import { currentInkPalette } from "../util/inkPaletteHistory";
import { footnoteThemeVars } from "../util/footnoteTheme";

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

type RibbonPlacement = {
  footnote: DocFootnote;
  at: LocalRect;
  bands: LocalRect[];
  useBands: boolean;
  number: number;
};

function localRectEqual(a: LocalRect, b: LocalRect): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** Avoid setState when place() remeasures the same geometry. */
function ribbonsPlacementEqual(a: RibbonPlacement[], b: RibbonPlacement[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.footnote.id !== y.footnote.id ||
      x.number !== y.number ||
      x.useBands !== y.useBands ||
      !localRectEqual(x.at, y.at) ||
      x.bands.length !== y.bands.length
    ) {
      return false;
    }
    for (let j = 0; j < x.bands.length; j++) {
      if (!localRectEqual(x.bands[j], y.bands[j])) return false;
    }
  }
  return true;
}

export interface DocSelectionResult {
  text: string;
  excerpt: string;
  anchor: DocAnchor;
  /** Content-block boxes under the marquee (body-local). */
  hitRects: LocalRect[];
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
   * Highlighter / underline tool — native text selection, not the hold box.
   */
  highlighting?: boolean;
  footnotes?: readonly DocFootnote[];
  onAnnotate?: (selection: DocSelectionResult, anchorRect: DOMRect | null) => void;
  onCopy?: (
    selection: DocSelectionResult,
    anchorRect: DOMRect | null,
  ) => void | boolean | Promise<void | boolean>;
  onSearch?: (selection: DocSelectionResult, anchorRect: DOMRect | null) => void;
  /** Leave the mark and nothing else — the highlighter's plain outcome. */
  onMark?: (selection: DocSelectionResult, anchorRect: DOMRect | null) => void;
  /** Tap on an existing ribbon — reopen the overview for that mark. */
  onOpenFootnote?: (footnote: DocFootnote, anchorRect: DOMRect | null) => void;
  onRemoveFootnote?: (footnote: DocFootnote) => void;
  /** Armed from the footnote hub — underline / highlight inside the open mark. */
  subMarkMode?: DocFootnoteSubMarkKind | null;
  subMarkParent?: DocFootnote | null;
  onAddSubMark?: (mark: DocFootnoteSubMark) => void;
  /** Hub-row hover — wash this committed sub-mark on the page. */
  hoveredSubMarkId?: string | null;
  /** Live / next underline colour while the tool is armed. */
  subMarkPaintTheme?: { color: string; palette: string[] } | null;
  /** New live drag — stop retinting the last committed underline. */
  onSubMarkLiveStart?: () => void;
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
  return unionLocalRects(localRects(body, range));
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
  subMarkMode = null,
  subMarkParent = null,
  onAddSubMark,
  hoveredSubMarkId = null,
  subMarkPaintTheme = null,
  onSubMarkLiveStart,
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
  const overlayRef = useRef<HTMLDivElement | null>(null);
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
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [ribbons, setRibbons] = useState<
    Array<{
      footnote: DocFootnote;
      at: LocalRect;
      bands: LocalRect[];
      useBands: boolean;
      number: number;
    }>
  >([]);
  const [copied, setCopied] = useState(false);
  /** Native text select vs hold-marquee — drives which actions sheet buttons show. */
  const [actionsVia, setActionsVia] = useState<"native" | "marquee">("native");
  const actionsViaRef = useRef(actionsVia);
  actionsViaRef.current = actionsVia;
  /** Screen box for the open selection — native path has no painted overlay rects. */
  const selectionScreenBoxRef = useRef<DOMRect | null>(null);
  /** The band being swept right now, in body coordinates. */
  const [band, setBand] = useState<LocalRect | null>(null);
  /** Rubber-band is fading out after confirm (hitRects stay). */
  const [bandFading, setBandFading] = useState(false);
  /** Content blocks intersecting the live marquee (chrome only). */
  const [hitRects, setHitRects] = useState<LocalRect[]>([]);
  /** Live sub-mark range while the reader is dragging on the page. */
  const [subMarkLive, setSubMarkLive] = useState<{
    start: number;
    end: number;
    root: HTMLElement;
    scope?: string;
  } | null>(null);
  /** ✓/✕ after a sub-mark drag — same pill as a new mark, not tap-to-commit. */
  const [subMarkConfirm, setSubMarkConfirm] = useState(false);
  const acceptSubMarkRef = useRef<(() => void) | null>(null);
  const subMarkDragRef = useRef<{
    pointerId: number;
    mode: "select" | "start" | "end";
    root: HTMLElement;
    scope?: string;
    anchor: number;
    focus: number;
  } | null>(null);
  const subMarkLiveRef = useRef(subMarkLive);
  subMarkLiveRef.current = subMarkLive;
  const onSubMarkLiveStartRef = useRef(onSubMarkLiveStart);
  onSubMarkLiveStartRef.current = onSubMarkLiveStart;
  const bandFadeTimerRef = useRef<number | null>(null);
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
    armTimer: number | null;
    /** Stillness elapsed — pan must not steal; next move is the marquee. */
    armed: boolean;
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
    const host = hostRef.current;
    if (hold?.armTimer != null) window.clearTimeout(hold.armTimer);
    if (hold) {
      try {
        host?.releasePointerCapture(hold.pointerId);
      } catch {
        /* already released */
      }
    }
    holdRef.current = null;
    host?.classList.remove("lc-doc-selecting", "lc-doc-select-mode");
    releaseSelectionGesture();
  }, []);

  const dismiss = useCallback(() => {
    if (bandFadeTimerRef.current != null) {
      window.clearTimeout(bandFadeTimerRef.current);
      bandFadeTimerRef.current = null;
    }
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
    setSelection(null);
    setPhase("idle");
    setRects([]);
    setBand(null);
    setBandFading(false);
    setHitRects([]);
    setCopied(false);
    setSubMarkLive(null);
    setSubMarkConfirm(false);
    subMarkDragRef.current = null;
    selectionScreenBoxRef.current = null;
    setActionsVia("native");
  }, []);

  const subMarkArmed = Boolean(subMarkMode && subMarkParent);
  const inkHistory = useSyncExternalStore(onInkPaletteChange, inkPaletteNow, inkPaletteNow);
  const inkPalette = currentInkPalette(inkHistory);

  const paintMarquee = useCallback((rect: LocalRect, root: HTMLElement) => {
    const body = bodyRef.current;
    if (!body) return;
    if (bandFadeTimerRef.current != null) {
      window.clearTimeout(bandFadeTimerRef.current);
      bandFadeTimerRef.current = null;
    }
    setBandFading(false);
    if (localRectCoversHost(body, rect)) {
      setBand(null);
      setHitRects([]);
      return;
    }
    setBand(rect);
    setHitRects(hitRectsUnder(body, root, rect));
  }, []);

  /** Enter confirm: keep paragraph chrome, fade the rubber-band away. */
  const confirmMarquee = useCallback(
    (done: {
      text: string;
      excerpt: string;
      anchor: DocAnchor;
      hitRects: LocalRect[];
    }, rect: LocalRect) => {
      if (bandFadeTimerRef.current != null) {
        window.clearTimeout(bandFadeTimerRef.current);
        bandFadeTimerRef.current = null;
      }
      setHitRects(done.hitRects);
      setSelection({
        text: done.text,
        excerpt: done.excerpt,
        anchor: done.anchor,
        hitRects: done.hitRects,
      });
      setBand(rect);
      setBandFading(true);
      setPhase("confirm");
      bandFadeTimerRef.current = window.setTimeout(() => {
        setBand(null);
        setBandFading(false);
        bandFadeTimerRef.current = null;
      }, 220);
    },
    [],
  );

  useEffect(() => {
    if (!enabled && !highlighting && !subMarkArmed) {
      clearGesture();
      dismiss();
    }
  }, [enabled, highlighting, subMarkArmed, clearGesture, dismiss]);

  /** Leaving sub-mark / highlight must drop the live dashed marquee immediately. */
  useEffect(() => {
    if (subMarkArmed || highlighting) return;
    setBand(null);
    setBandFading(false);
    if (bandFadeTimerRef.current != null) {
      window.clearTimeout(bandFadeTimerRef.current);
      bandFadeTimerRef.current = null;
    }
  }, [subMarkArmed, highlighting]);

  /*
   * Leaving Underline: drop an unconfirmed live range. Commit is ✓ on the
   * same pill as a new mark — toggling the tool off is cancel, not save.
   */
  useEffect(() => {
    if (subMarkArmed) return;
    setSubMarkLive(null);
    setSubMarkConfirm(false);
    subMarkDragRef.current = null;
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
    clearGesture();
  }, [subMarkArmed, clearGesture]);

  /*
   * No auto-seed. Seeding the first word put overlapping grips on one glyph and
   * made every drag look broken. Live range appears only when the reader drags.
   */
  useEffect(() => {
    if (!subMarkArmed) return;
    setSubMarkLive(null);
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
  }, [subMarkArmed, subMarkMode, subMarkParent?.id]);

  useEffect(() => {
    if (!subMarkLive) return;
    onSubMarkLiveStartRef.current?.();
  }, [subMarkLive]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.classList.toggle("lc-doc-submark-armed", subMarkArmed);
    host.classList.toggle("lc-doc-panel-open", Boolean(subMarkParent));
    return () => {
      host.classList.remove("lc-doc-submark-armed", "lc-doc-panel-open");
    };
  }, [subMarkArmed, subMarkParent]);

  useEffect(() => {
    return () => {
      if (bandFadeTimerRef.current != null) {
        window.clearTimeout(bandFadeTimerRef.current);
        bandFadeTimerRef.current = null;
      }
    };
  }, []);

  /**
   * Native Selection → actions sheet (Copy / Google / Mark).
   * No Confirm|Close — that chrome is hold-marquee only.
   * Panel open + underline off: full-page native select.
   * Panel open + underline on: native outside the mark only (inside = grip path).
   */
  useEffect(() => {
    const host = hostRef.current;
    const body = bodyRef.current;
    if (!host || !body) return;
    if (!enabled && !highlighting && !subMarkParent) return;

    const scopeRootForRange = (range: Range): { root: HTMLElement; scope?: string } => {
      const node = range.commonAncestorContainer;
      const el =
        node.nodeType === Node.ELEMENT_NODE
          ? (node as HTMLElement)
          : node.parentElement;
      const scoped = el?.closest(`[${SCOPE_ATTR}]`);
      if (scoped instanceof HTMLElement && body.contains(scoped)) {
        const scope = scoped.getAttribute(SCOPE_ATTR) ?? undefined;
        return { root: scoped, scope: scope || undefined };
      }
      return { root: body };
    };

    const panelBands = (): LocalRect[] | null => {
      if (!subMarkParent) return null;
      const scope = subMarkParent.anchor.scope;
      const root = scopeRootIn(body, scope) as HTMLElement | null;
      if (!root) return null;
      const stored =
        subMarkParent.bands && subMarkParent.bands.length > 0
          ? tightLocalRects(body, subMarkParent.bands)
          : [];
      if (stored.length > 0) return stored;
      const at = rectForAnchor(body, root, subMarkParent.anchor);
      return at && !localRectCoversHost(body, at) ? [at] : null;
    };

    const rangeHitsBands = (range: Range, bands: readonly LocalRect[]): boolean => {
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 0.5 && rect.height < 0.5) continue;
        if (
          pointInLocalBands(
            body,
            bands,
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
            8,
          )
        ) {
          return true;
        }
      }
      return false;
    };

    const commitNative = (event?: Event) => {
      if (holdRef.current?.held) return;
      if (subMarkDragRef.current) return;
      if (event && isDocChromeTarget(event.target)) return;
      // Already showing actions — don't bounce back to a new sheet on chrome clicks.
      if (phaseRef.current === "actions" || phaseRef.current === "confirm") return;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount < 1) return;
      const range = sel.getRangeAt(0);
      if (!body.contains(range.commonAncestorContainer)) return;
      const raw = sel.toString();
      if (!raw.trim()) return;

      // Underline tool owns in-mark ranges; leave those for the grip path.
      if (subMarkArmed) {
        const bands = panelBands();
        if (bands && bands.length > 0 && rangeHitsBands(range, bands)) return;
      }

      const { root, scope } = scopeRootForRange(range);
      let anchor = anchorFromRange(root, range, scope);
      if (!anchor) return;
      const stream = textOf(root);
      const [start, end] = snapToWords(stream, anchor.start, anchor.end);
      anchor = { ...anchor, start, end };
      const text = textForAnchor(root, anchor);
      if (!text.trim()) return;

      const clientRects = tightClientRects(range, body);
      const local = unionRectsIntoBlocks(clientRectsToLocal(body, clientRects));
      selectionScreenBoxRef.current = unionViewportBoxes(clientRects);

      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* native overlay on Android fights the camera transform */
      }

      setRects(local);
      setHitRects([]);
      setActionsVia("native");
      setSelection({
        text,
        excerpt: excerptOf(text),
        anchor,
        hitRects: local,
      });
      setBand(null);
      setBandFading(false);
      // Native path skips Confirm|Close — straight to Copy / Google.
      setPhase("actions");
    };

    const onPointerUp = (event: Event) => {
      window.requestAnimationFrame(() => commitNative(event));
    };

    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("mouseup", onPointerUp, true);
    return () => {
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("mouseup", onPointerUp, true);
    };
  }, [enabled, highlighting, subMarkArmed, subMarkParent]);

  /** Panel open (no sub-mark tool): still register mark hit so Board/backdrop can test it. */
  useEffect(() => {
    if (!subMarkParent || subMarkArmed) return;
    const SUBMARK_HIT_PAD = 48;
    const hit = (clientX: number, clientY: number): boolean => {
      const body = bodyRef.current;
      if (!body) return false;
      const scope = subMarkParent.anchor.scope;
      const root = scopeRootIn(body, scope) as HTMLElement | null;
      if (!root) return false;
      const stored =
        subMarkParent.bands && subMarkParent.bands.length > 0
          ? tightLocalRects(body, subMarkParent.bands)
          : [];
      const fallback = (() => {
        const at = rectForAnchor(body, root, subMarkParent.anchor);
        return at && !localRectCoversHost(body, at) ? [at] : [];
      })();
      const bands = stored.length > 0 ? stored : fallback;
      if (bands.length === 0) return false;
      return pointInLocalBands(body, bands, clientX, clientY, SUBMARK_HIT_PAD);
    };
    setSubMarkPointerHit(hit);
    return () => setSubMarkPointerHit(null);
  }, [subMarkParent, subMarkArmed]);

  // Reading mode (and Ask-area 🔍): hold still to arm annotate marquee.
  // Native drag-select is separate — do not preventDefault selectstart until armed.
  // Panel open → native in-band only (no hold box fighting Copy).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled || subMarkArmed || subMarkParent) return;

    const paintFromFinger = (hold: NonNullable<typeof holdRef.current>) => {
      const body = bodyRef.current;
      if (!body || !hold.startLocal || !hold.root) return;
      const end = viewportToLocal(body, hold.lastX, hold.lastY);
      const rect = bandFromLocalPoints(body, hold.startLocal, end);
      paintMarquee(rect, hold.root);
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

    const beginMarquee = (hold: NonNullable<typeof holdRef.current>) => {
      const body = bodyRef.current;
      if (!body || hold.held) return;
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
      dismiss();
      const { root, scope } = scopeRootAtPoint(body, hold.startX, hold.startY);
      hold.held = true;
      hold.root = root;
      hold.scope = scope;
      hold.startLocal = viewportToLocal(body, hold.startX, hold.startY);
      hold.sideScroll =
        horizontalScrollHost(document.elementFromPoint(hold.startX, hold.startY)) ??
        horizontalScrollHost(root);
      claimSelectionGesture();
      try {
        host.setPointerCapture(hold.pointerId);
      } catch {
        /* window listeners still run */
      }
      host.classList.add("lc-doc-selecting", "lc-doc-select-mode");
      paintFromFinger(hold);
      if (edgeFrameRef.current == null) {
        edgeFrameRef.current = requestAnimationFrame(autoScroll);
      }
      try {
        navigator.vibrate?.(10);
      } catch {
        /* haptics are a nicety */
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (isDocChromeTarget(event.target)) return;
      // Unsaved confirm (✓/✕, not yet Annotate) dies on tap-off. A new hold
      // on this same pointer can replace it. Actions stay on the backdrop.
      if (phaseRef.current === "confirm") dismiss();
      clearGesture();
      const startX = event.clientX;
      const startY = event.clientY;
      holdRef.current = {
        pointerId: event.pointerId,
        startX,
        startY,
        armTimer: window.setTimeout(() => {
          const hold = holdRef.current;
          if (!hold || hold.held || hold.armed) return;
          hold.armed = true;
          hold.armTimer = null;
          // Claim before Android's ~500ms long-press can pointercancel. The
          // box itself starts on the first move after this pause.
          claimSelectionGesture();
          try {
            host.setPointerCapture(hold.pointerId);
          } catch {
            /* pointer may already be gone */
          }
          host.classList.add("lc-doc-selecting", "lc-doc-select-mode");
        }, SELECT_HOLD_ARM_MS),
        armed: false,
        held: false,
        root: null,
        scope: undefined,
        startLocal: null,
        lastX: startX,
        lastY: startY,
        sideScroll: null,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      const hold = holdRef.current;
      if (!hold || hold.pointerId !== event.pointerId) return;
      if (!hold.held) {
        const moved = Math.hypot(event.clientX - hold.startX, event.clientY - hold.startY);
        if (!hold.armed) {
          if (moved > SELECT_HOLD_SLOP_PX) clearGesture();
          return;
        }
        if (moved <= SELECT_HOLD_SLOP_PX) return;
        // Armed: any direction starts the box. Stillness already beat pan.
        // Yielding vertical drags back to scroll made a hold-then-drag down
        // a paragraph (the natural annotate motion) never signal.
        hold.lastX = event.clientX;
        hold.lastY = event.clientY;
        beginMarquee(hold);
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
      confirmMarquee(done, rect);
    };

    const onPointerUp = (event: PointerEvent) => finishHold(event, true);
    const onPointerCancel = (event: PointerEvent) => finishHold(event, false);
    const onSelectStart = (event: Event) => {
      if (holdRef.current?.armed || holdRef.current?.held) event.preventDefault();
    };
    const onContextMenu = (event: Event) => {
      if (holdRef.current?.armed || holdRef.current?.held) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    host.addEventListener("selectstart", onSelectStart);
    host.addEventListener("contextmenu", onContextMenu);
    host.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      host.removeEventListener("selectstart", onSelectStart);
      host.removeEventListener("contextmenu", onContextMenu);
      host.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      clearGesture();
    };
  }, [enabled, highlighting, subMarkArmed, subMarkParent, clearGesture, dismiss, paintMarquee, confirmMarquee]);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (phaseRef.current !== "confirm") return;
      if (isDocChromeTarget(event.target)) return;
      dismiss();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [dismiss]);

  /*
   * Sub-mark mode — custom range only. Native Selection is killed while armed:
   * dual native+grip path painted a second text layer (blurry duplicate) and
   * let the browser flood-select half the page when the grip moved a few words.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !subMarkArmed || !subMarkMode || !subMarkParent || !onAddSubMark) return;

    const killNativeSelection = () => {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
    };

    const parentRegion = () => {
      const body = bodyRef.current;
      if (!body) return null;
      const scope = subMarkParent.anchor.scope;
      const root = scopeRootIn(body, scope) as HTMLElement | null;
      if (!root) return null;
      const storedBands =
        subMarkParent.bands && subMarkParent.bands.length > 0
          ? tightLocalRects(body, subMarkParent.bands)
          : [];
      const fallback = (() => {
        const at = rectForAnchor(body, root, subMarkParent.anchor);
        return at && !localRectCoversHost(body, at) ? [at] : [];
      })();
      const bands = storedBands.length > 0 ? storedBands : fallback;
      if (bands.length === 0) return null;
      const bounds = parentTextBounds(body, root, subMarkParent, bands);
      return { body, root, scope, bands, bounds };
    };

    const offsetAt = (
      body: HTMLElement,
      root: HTMLElement,
      bands: readonly LocalRect[],
      bounds: { start: number; end: number } | null,
      clientX: number,
      clientY: number,
      scope?: string,
    ): { start: number; root: HTMLElement; scope?: string } | null => {
      const clampStart = (raw: number) => {
        if (!bounds) return raw;
        return Math.max(bounds.start, Math.min(Math.max(bounds.start, bounds.end - 1), raw));
      };

      /*
       * Pointer → offset in the mark's character stream.
       *
       * Clamp, never discard. The bands say where the mark is, and staying inside
       * it is what `bounds` is for; using them to *reject* a caret was the bug —
       * they are body-local layout rectangles and a caret is in viewport pixels,
       * so on a transformed slot a perfectly good caret failed the test and the
       * lookup fell through to a coarse character grid.
       */
      const hit = caretPointIn(root, clientX, clientY, { bands, body });
      if (!hit) return null;
      // A caret is a boundary, not a range — `anchorFromRange` refuses those.
      const start = streamOffsetAt(root, hit.node, hit.offset);
      if (start == null) return null;
      return { start: clampStart(start), root, scope };
    };

    const parentBlockText = (body: HTMLElement, bands: readonly LocalRect[]): string => {
      if (subMarkParent.blockText?.trim()) return subMarkParent.blockText;
      const union = unionLocalRects(bands);
      if (!union) return "";
      const scale = scaleOf(body) || 1;
      return textUnder(body, union, scale, body.getBoundingClientRect());
    };

    const clampToParent = (
      start: number,
      end: number,
      bounds: { start: number; end: number } | null,
    ): [number, number] => {
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      if (!bounds) return [lo, hi];
      return [Math.max(bounds.start, lo), Math.min(bounds.end, hi)];
    };

    const liveFrom = (
      root: HTMLElement,
      scope: string | undefined,
      anchor: number,
      focus: number,
      bounds: { start: number; end: number } | null,
    ) => {
      const [start, end] = clampToParent(anchor, focus, bounds);
      if (end <= start) return;
      setSubMarkLive({ start, end, root, scope });
    };

    const releaseSubMarkGesture = () => {
      host.classList.remove("lc-doc-selecting", "lc-doc-submark-mode", "lc-doc-submark-grip-drag");
      releaseSelectionGesture();
    };

    const SUBMARK_HIT_PAD = 48;

    const pointerHitsParentMark = (clientX: number, clientY: number): boolean => {
      const under = document.elementFromPoint(clientX, clientY);
      if (under?.closest?.(".lc-doc-submark-grip")) return true;
      const region = parentRegion();
      if (!region) return false;
      return pointInLocalBands(
        region.body,
        region.bands,
        clientX,
        clientY,
        SUBMARK_HIT_PAD,
      );
    };

    setSubMarkPointerHit(pointerHitsParentMark);
    killNativeSelection();

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const fromTarget = (event.target as Element | null)?.closest?.(
        ".lc-doc-submark-grip",
      ) as Element | null;
      const fromPoint = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest?.(".lc-doc-submark-grip") as Element | null;
      const grip = fromTarget ?? fromPoint;
      if (!grip && isDocChromeTarget(event.target)) return;
      const region = parentRegion();
      if (!region) return;
      if (
        !grip &&
        !pointInLocalBands(
          region.body,
          region.bands,
          event.clientX,
          event.clientY,
          SUBMARK_HIT_PAD,
        )
      ) {
        return;
      }

      // Own the gesture — no browser Selection (that was the blurry duplicate text).
      event.preventDefault();
      event.stopPropagation();
      killNativeSelection();
      setSubMarkConfirm(false);
      setSelection(null);
      setPhase("idle");
      setRects([]);
      setBand(null);
      setBandFading(false);
      setHitRects([]);
      setCopied(false);
      claimSelectionGesture();
      host.classList.add("lc-doc-selecting", "lc-doc-submark-mode");

      const live = subMarkLiveRef.current;
      if (grip && live) {
        host.classList.add("lc-doc-submark-grip-drag");
        const which = grip.getAttribute("data-grip");
        subMarkDragRef.current = {
          pointerId: event.pointerId,
          mode: which === "start" ? "start" : "end",
          root: live.root,
          scope: live.scope,
          anchor: live.start,
          focus: live.end,
        };
        try {
          (grip as HTMLElement).setPointerCapture(event.pointerId);
        } catch {
          try {
            host.setPointerCapture(event.pointerId);
          } catch {
            /* capture is best-effort */
          }
        }
        return;
      }

      const at =
        offsetAt(
          region.body,
          region.root,
          region.bands,
          region.bounds,
          event.clientX,
          event.clientY,
          region.scope,
        ) ??
        (live
          ? {
              start: region.bounds
                ? Math.max(
                    region.bounds.start,
                    Math.min(region.bounds.end - 1, live.start),
                  )
                : live.start,
              root: region.root,
              scope: region.scope,
            }
          : null);
      if (!at) {
        releaseSubMarkGesture();
        return;
      }
      const focus = region.bounds
        ? Math.min(region.bounds.end, at.start + 1)
        : at.start + 1;
      subMarkDragRef.current = {
        pointerId: event.pointerId,
        mode: "select",
        root: at.root,
        scope: at.scope,
        anchor: at.start,
        focus,
      };
      try {
        host.setPointerCapture(event.pointerId);
      } catch {
        /* capture is best-effort */
      }
      liveFrom(at.root, at.scope, at.start, focus, region.bounds);
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = subMarkDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      killNativeSelection();
      const region = parentRegion();
      if (!region) return;
      const at = offsetAt(
        region.body,
        region.root,
        region.bands,
        region.bounds,
        event.clientX,
        event.clientY,
        drag.scope,
      );
      if (!at) return;
      if (drag.mode === "select") {
        drag.focus = at.start;
        liveFrom(drag.root, drag.scope, drag.anchor, drag.focus, region.bounds);
        return;
      }
      if (drag.mode === "start") {
        const next = Math.min(at.start, drag.focus - 1);
        drag.anchor = next;
        liveFrom(drag.root, drag.scope, drag.anchor, drag.focus, region.bounds);
        return;
      }
      const next = Math.max(at.start, drag.anchor + 1);
      drag.focus = next;
      liveFrom(drag.root, drag.scope, drag.anchor, drag.focus, region.bounds);
    };

    const commitSubMark = (rawStart: number, rawEnd: number, root: HTMLElement, scope?: string) => {
      if (!subMarkMode || rawEnd <= rawStart) return;
      const region = parentRegion();
      const blockText = region ? parentBlockText(region.body, region.bands) : "";
      const stream = textOf(root);
      const [start, end] = snapToWords(stream, rawStart, rawEnd);
      const [clampedStart, clampedEnd] = clampToParent(start, end, region?.bounds ?? null);
      if (clampedEnd <= clampedStart) return;

      const range = rangeFromAnchor(root, {
        kind: "text",
        start: clampedStart,
        end: clampedEnd,
        ...(scope ? { scope } : {}),
      });
      if (!range) return;

      const textAnchor = anchorFromRange(root, range, scope);
      const excerpt = excerptOf(
        textForAnchor(
          root,
          textAnchor ?? {
            kind: "text",
            start: clampedStart,
            end: clampedEnd,
            scope,
          },
        ),
      );
      if (!excerpt) return;

      let relStart = clampedStart;
      let relEnd = clampedEnd;
      if (isTextAnchor(subMarkParent.anchor)) {
        relStart = clampedStart - subMarkParent.anchor.start;
        relEnd = clampedEnd - subMarkParent.anchor.start;
      } else if (region?.bounds) {
        relStart = clampedStart - region.bounds.start;
        relEnd = clampedEnd - region.bounds.start;
      } else if (blockText) {
        const slice = stream.slice(clampedStart, clampedEnd);
        const idx = blockText.indexOf(slice);
        relStart = idx >= 0 ? idx : 0;
        relEnd = relStart + slice.length;
      }

      setSubMarkLive(null);
      setSubMarkConfirm(false);
      onAddSubMark({
        id: "sm-pending",
        kind: subMarkMode,
        excerpt,
        start: relStart,
        end: relEnd,
        ...(textAnchor ? { anchor: textAnchor } : {}),
      });
    };

    acceptSubMarkRef.current = () => {
      const live = subMarkLiveRef.current;
      if (!live || live.end - live.start < 2) return;
      commitSubMark(live.start, live.end, live.root, live.scope);
    };

    const onPointerUp = (event: PointerEvent) => {
      const drag = subMarkDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      subMarkDragRef.current = null;
      releaseSubMarkGesture();
      killNativeSelection();

      const region = parentRegion();
      const [rawStart, rawEnd] = [
        Math.min(drag.anchor, drag.focus),
        Math.max(drag.anchor, drag.focus),
      ];

      if (drag.mode === "start" || drag.mode === "end") {
        if (rawEnd <= rawStart) return;
        /*
         * The live range stays exactly where the finger left it. Snapping to word
         * edges belongs to commit (`commitSubMark`) — doing it on every lift made
         * a grip nudge jump a whole word and made the next drag start from
         * somewhere the reader had not put it.
         */
        const [clampedStart, clampedEnd] = clampToParent(rawStart, rawEnd, region?.bounds ?? null);
        if (clampedEnd <= clampedStart) return;
        setSubMarkLive({
          start: clampedStart,
          end: clampedEnd,
          root: drag.root,
          scope: drag.scope,
        });
        setSubMarkConfirm(true);
        return;
      }

      const moved = Math.abs(drag.focus - drag.anchor) > 1;
      if (!moved) {
        const live = subMarkLiveRef.current;
        if (live && live.end - live.start >= 2) setSubMarkConfirm(true);
        return;
      }
      if (rawEnd <= rawStart) return;
      const [clampedStart, clampedEnd] = clampToParent(rawStart, rawEnd, region?.bounds ?? null);
      if (clampedEnd <= clampedStart) return;
      setSubMarkLive({
        start: clampedStart,
        end: clampedEnd,
        root: drag.root,
        scope: drag.scope,
      });
      setSubMarkConfirm(true);
    };

    const onSelectStart = (event: Event) => event.preventDefault();

    host.addEventListener("selectstart", onSelectStart);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    return () => {
      setSubMarkPointerHit(null);
      host.removeEventListener("selectstart", onSelectStart);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      releaseSubMarkGesture();
      killNativeSelection();
    };
  }, [subMarkArmed, subMarkMode, subMarkParent, onAddSubMark, dismiss]);

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
      const placed: Array<{
        footnote: DocFootnote;
        at: LocalRect;
        bands: LocalRect[];
        useBands: boolean;
        number: number;
      }> = [];
      for (const footnote of footnotes) {
        const scope = footnote.anchor.scope;
        const root = scopeRootIn(body, scope) as HTMLElement | null;
        if (!root) continue;
        /*
         * Drop washes over *this page*, not only over the document.
         *
         * `tightLocalRects` measures against the paper slot and the board, and
         * for a PDF forty pages long a rect covering one page is a couple of
         * percent of either — so it passed as a line box and painted the page.
         * A marquee mark is the one that produces such a rect. The scope root
         * is the page, so it is the box that can answer the question.
         */
        const storedBands =
          footnote.bands && footnote.bands.length > 0
            ? tightLocalRects(body, footnote.bands)
            : [];
        const live =
          isTextAnchor(footnote.anchor)
            ? (() => {
                const range = rangeFromAnchor(root, footnote.anchor);
                return range ? tightLocalRects(body, localRects(body, range)) : [];
              })()
            : [];
        const bands =
          live.length > 0
            ? live
            : storedBands.length > 0
              ? storedBands
              : (() => {
                  const at = rectForAnchor(body, root, footnote.anchor);
                  return at && !localRectCoversHost(body, at) ? [at] : [];
                })();
        if (bands.length === 0) continue;
        const at = unionLocalRects(bands);
        if (!at) continue;
        placed.push({
          footnote,
          at,
          bands,
          useBands: live.length > 0 || storedBands.length > 0,
          number: numbers.get(footnote.id) ?? 0,
        });
      }
      // Skip React commits when geometry is unchanged — mid-scroll place() used
      // to re-render the overlay every time even when nothing moved.
      setRibbons((prev) => (ribbonsPlacementEqual(prev, placed) ? prev : placed));
      const overlayNode = overlayRef.current;
      if (overlayNode) {
        overlayNode.style.left = "0px";
        overlayNode.style.top = "0px";
        overlayNode.style.right = "auto";
        overlayNode.style.bottom = "auto";
        overlayNode.style.width = `${body.offsetWidth}px`;
        overlayNode.style.height = `${body.offsetHeight}px`;
      }
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
    const onViewResize = () => {
      if (isDocCameraLive()) {
        placementDeferred = true;
        return;
      }
      if (scrollFrame != null) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = null;
        place();
      });
    };
    window.addEventListener("resize", onViewResize);
    window.visualViewport?.addEventListener("resize", onViewResize);
    const unbindView = () => {
      window.removeEventListener("resize", onViewResize);
      window.visualViewport?.removeEventListener("resize", onViewResize);
    };

    /*
     * Live mutation watching is for reading / highlight — text layers land
     * after mount. Annotate keeps the layer mounted (`enabled=false`) so the
     * pen can draw, but re-placing ribbons on every PDF window mutation mid-
     * flick starves ink tile paint until scroll settle.
     *
     * Critical: disconnect the observer while the camera is live. Deferring
     * `place()` alone still left MutationObserver + rAF firing every text-layer
     * paint during a flick (~30fps chop). Pause delivery; reconnect on settle.
     */
    const watchMutations = enabled || highlighting;
    let frame: number | null = null;
    if (!watchMutations || footnotes.length === 0 || typeof MutationObserver !== "function") {
      return () => {
        unbindView();
        body.removeEventListener("scroll", onHostScroll, true);
        if (scrollFrame != null) cancelAnimationFrame(scrollFrame);
        placeRef.current = null;
      };
    }

    let observing = false;
    const observer = new MutationObserver(() => {
      if (isDocCameraLive()) {
        placementDeferred = true;
        return;
      }
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (isDocCameraLive()) {
          placementDeferred = true;
          return;
        }
        place();
      });
    });
    const startObserver = () => {
      if (observing) return;
      observer.observe(body, { childList: true, subtree: true, characterData: true });
      observing = true;
    };
    const stopObserver = () => {
      if (!observing) return;
      observer.disconnect();
      observing = false;
      if (frame != null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };
    if (!isDocCameraLive()) startObserver();
    else placementDeferred = true;

    onDocCameraLiveChange((live) => {
      if (live) {
        placementDeferred = true;
        stopObserver();
        return;
      }
      startObserver();
      if (!placementDeferred) return;
      placementDeferred = false;
      place();
    });
    return () => {
      stopObserver();
      onDocCameraLiveChange(null);
      unbindView();
      body.removeEventListener("scroll", onHostScroll, true);
      placeRef.current = null;
      if (frame != null) cancelAnimationFrame(frame);
      if (scrollFrame != null) cancelAnimationFrame(scrollFrame);
    };
    // Intentionally omit `children`: identity churn on every App render re-bound
    // the observer and re-ran place(), which felt like a constant scroll ping.
  }, [footnotes, enabled, highlighting]);



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

  const act = (
    run: ((selection: DocSelectionResult, anchorRect: DOMRect | null) => void | Promise<void>) | undefined,
  ) => {
    const current = selection;
    const anchorRect = highlightBox();
    if (!current || !run) return;
    void Promise.resolve(run(current, anchorRect)).finally(() => {
      dismiss();
    });
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
  const paneBox = (): DOMRect => {
    const board = bodyRef.current?.closest(".lc-board");
    if (board instanceof HTMLElement) return board.getBoundingClientRect();
    const view = window.visualViewport;
    return new DOMRect(
      0,
      0,
      view?.width ?? window.innerWidth,
      view?.height ?? window.innerHeight,
    );
  };

  const tightBox = (
    box: DOMRect | null | undefined,
    host: HTMLElement | null,
    hostBox: DOMRect,
  ): DOMRect | null => {
    if (!box || (box.width <= 0 && box.height <= 0)) return null;
    if (host ? isPageCoverRect(box, host) : coversViewportBox(box, hostBox)) return null;
    return box;
  };

  const liveSelectionBox = (host: HTMLElement): DOMRect | null => {
    try {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount < 1) return null;
      const range = sel.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer) &&
          range.commonAncestorContainer !== host) {
        return null;
      }
      return unionViewportBoxes(tightClientRects(range, host));
    } catch {
      return null;
    }
  };

  /**
   * The highlight's box on screen.
   *
   * Current selection paint only — never every highlight band on the page.
   *
   * Footnote washes live in the same overlay. Unioning them with the quote
   * made highlightBox the paper, so ✓/✕ / Copy / Annotate clamped to the
   * pane's top-right corner and the whole page took the mark colour.
   */
  const highlightBox = (): DOMRect | null => {
    const host = bodyRef.current;
    const hostBox = host?.getBoundingClientRect() ?? paneBox();
    if (actionsViaRef.current === "native") {
      const live = host ? liveSelectionBox(host) : null;
      if (live) return live;
      const captured = tightBox(selectionScreenBoxRef.current, host, hostBox);
      if (captured) return captured;
    }
    const paintedRoot = overlayRef.current;
    const painted = paintedRoot
      ? Array.from(
          paintedRoot.querySelectorAll(
            ".lc-doc-select-rect, .lc-doc-marquee-band:not(.is-fading), .lc-doc-marquee-hit, .lc-doc-submark-live",
          ),
        )
      : [];
    const paintedBoxes = painted
      .map((node) => node.getBoundingClientRect())
      .filter((box) => {
        if (box.width <= 0.5 || box.height <= 0.5) return false;
        if (host) return !isPageCoverRect(box, host);
        return !coversViewportBox(box, hostBox);
      });
    /*
     * The whole block, not its first line.
     *
     * Every box in `paintedBoxes` has already been through the page-cover
     * filter, so their union is the selection's own extent — a paragraph is
     * still a paragraph when it happens to run the full width of its column.
     * Testing the union again and falling back to the topmost box is what put
     * ✓/✕, Copy / Google and the ribbon on the right edge of the *first line*:
     * take a heading plus the paragraph under it and the chip landed on the
     * heading, halfway across the selection it belonged to.
     */
    const fromPaint = unionViewportBoxes(paintedBoxes);
    if (fromPaint) return fromPaint;
    const captured = tightBox(selectionScreenBoxRef.current, host, hostBox);
    if (captured) return captured;
    return host ? liveSelectionBox(host) : null;
  };

  /**
   * Clamp a measured box into the board pane (split view), with a margin.
   *
   * `offsetWidth`/`offsetHeight` rather than `getBoundingClientRect()`: the
   * measurement happens in the ref callback, on the frame the pop animation
   * starts, and a rect reports the box *as transformed* — 0.96 of its real
   * width — so clamping against it leaves the element a little wider than the
   * space that was reserved for it. The layout size is what it will settle at.
   *
   * Anchors from `getBoundingClientRect` are layout-viewport coordinates. Do
   * not add `visualViewport.offsetLeft/Top` onto them — that shoved chrome to
   * the top-left off-screen on Android WebView.
   */
  const clampInto = (node: HTMLElement, left: number, top: number) => {
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const pane = paneBox();
    const margin = 8;
    const minLeft = pane.left + margin;
    const minTop = pane.top + margin;
    const maxLeft = Math.max(minLeft, pane.right - width - margin);
    const maxTop = Math.max(minTop, pane.bottom - height - margin);
    node.style.left = `${Math.round(Math.min(Math.max(minLeft, left), maxLeft))}px`;
    node.style.top = `${Math.round(Math.min(Math.max(minTop, top), maxTop))}px`;
    node.style.visibility = "visible";
  };

  /** Tick and cross, off the selection's top-right corner. */
  const selectionChromeRef = useRef<HTMLDivElement | null>(null);

  const placeConfirm = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const at = highlightBox();
    if (!at) {
      node.style.visibility = "hidden";
      return;
    }
    // Just outside the corner, and above the line rather than over the next
    // word — the same relationship a footnote marker has to its text.
    clampInto(node, at.right + 4, at.top - node.offsetHeight - 4);
  }, []);

  /**
   * Actions stay in the same corner as confirm / the bookmark — top-right of
   * the selection — so the pill morphs in place instead of jumping under the box.
   */
  const placeSheet = useCallback((node: HTMLDivElement | null) => {
    placeConfirm(node);
  }, [placeConfirm]);

  const placeSelectionChrome = useCallback(
    (node: HTMLDivElement | null) => {
      if (phase === "confirm" || subMarkConfirm) placeConfirm(node);
      else if (phase === "actions") placeSheet(node);
    },
    [phase, placeConfirm, placeSheet, subMarkConfirm],
  );

  const bindSelectionChrome = useCallback(
    (node: HTMLDivElement | null) => {
      selectionChromeRef.current = node;
      placeSelectionChrome(node);
    },
    [placeSelectionChrome],
  );

  useLayoutEffect(() => {
    if (phase !== "confirm" && phase !== "actions" && !subMarkConfirm) return;
    const relayout = () => placeSelectionChrome(selectionChromeRef.current);
    relayout();
    // Android / Motion: one more place after layout paints select rects.
    const id = requestAnimationFrame(relayout);
    window.addEventListener("resize", relayout);
    window.visualViewport?.addEventListener("resize", relayout);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener("resize", relayout);
      window.visualViewport?.removeEventListener("resize", relayout);
    };
  }, [phase, placeSelectionChrome, overlaps.length, selection, copied, subMarkConfirm, subMarkLive]);

  const paintedSubMarks = useMemo(() => {
    const body = bodyRef.current;
    if (!body || !subMarkParent?.subMarks?.length) return [];
    const out: Array<{
      id: string;
      kind: DocFootnoteSubMarkKind;
      rects: LocalRect[];
      color?: string;
      palette?: string[];
    }> = [];
    for (const mark of subMarkParent.subMarks) {
      const anchor = resolveSubMarkAnchor(subMarkParent, mark);
      if (!anchor) continue;
      const root = scopeRootIn(body, anchor.scope) as HTMLElement | null;
      if (!root) continue;
      const range = rangeFromAnchor(root, anchor);
      if (!range) continue;
      out.push({
        id: mark.id,
        kind: mark.kind,
        rects: localRects(body, range),
        color: mark.color,
        palette: mark.palette,
      });
    }
    return out;
  }, [subMarkParent, footnotes, children]);

  const subMarkLivePaint = useMemo(() => {
    const body = bodyRef.current;
    if (!body || !subMarkLive) return [];
    const range = rangeFromAnchor(subMarkLive.root, {
      kind: "text",
      start: subMarkLive.start,
      end: subMarkLive.end,
      ...(subMarkLive.scope ? { scope: subMarkLive.scope } : {}),
    });
    if (!range) return [];
    return localRects(body, range);
  }, [subMarkLive]);

  const subMarkTint = subMarkParent
    ? footnoteThemeVars(subMarkParent.color ?? inkPalette[0], inkPalette)
    : undefined;
  const subMarkLiveTint = subMarkPaintTheme
    ? footnoteThemeVars(subMarkPaintTheme.color, subMarkPaintTheme.palette)
    : subMarkTint;

  const aiTabTops = useMemo(
    () =>
      stackAiTabTops(
        ribbons
          .filter((entry) => entry.footnote.kind === "ai")
          .map((entry) => ({
            id: entry.footnote.id,
            y:
              (entry.useBands && entry.bands[0]
                ? entry.bands[0].top
                : entry.at?.top) ?? 0,
          })),
      ),
    [ribbons],
  );

  return (
    <div className="lc-doc-selectable" ref={hostRef}>
      <div className="lc-doc-selectable-body" ref={bodyRef}>
        {children}
      </div>
      {overlay(
        marksHost,
        <div
          ref={overlayRef}
          className="lc-doc-select-overlay"
          aria-hidden={rects.length === 0 && hitRects.length === 0 && !band && ribbons.length === 0}
        >
          {band &&
            !(bodyRef.current && localRectCoversHost(bodyRef.current, band)) && (
            <div
              className={
                (highlighting ? "lc-doc-highlight-band" : "lc-doc-marquee-band") +
                (bandFading ? " is-fading" : "")
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
              className={
                phase === "idle"
                  ? "lc-doc-marquee-hit"
                  : "lc-doc-marquee-hit is-confirmed"
              }
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
          {ribbons.map(({ footnote, at, bands, useBands, number }) => {
            /*
             * Tap opens the mark; hold fills left→right and deletes.
             *
             * User marks: number chip in the gutter beside the top of the
             * whole mark — the union of its bands, not the topmost one. A
             * heading followed by its paragraph put the ribbon at the end of
             * the heading, mid-selection, because that band happened to be
             * first and short. See `markChipLeft` for why beside and not
             * inside. AI marks: a book tab on the page's right edge, half on
             * the paper and half hanging off.
             */
            const tint = footnoteThemeVars(
              footnote.color ?? inkPalette[0],
              inkPalette,
            );
            const paintBands = (
              useBands && bands.length > 0 ? bands : at ? [at] : []
            ).filter(
              (bandRect) =>
                !bodyRef.current || !localRectCoversHost(bodyRef.current, bandRect),
            );
            if (paintBands.length === 0) return null;
            const block = paintBands.reduce(
              (best, bandRect) => ({
                left: Math.min(best.left, bandRect.left),
                top: Math.min(best.top, bandRect.top),
                right: Math.max(best.right, bandRect.left + bandRect.width),
              }),
              {
                left: paintBands[0]!.left,
                top: paintBands[0]!.top,
                right: paintBands[0]!.left + paintBands[0]!.width,
              },
            );
            const isAiTab = footnote.kind === "ai";
            const chipPad = 3;
            const chipW = isAiTab ? AI_TAB_WIDTH : 16;
            const pageWidth = bodyRef.current?.offsetWidth ?? 0;
            const chipLeft = isAiTab
              ? aiBookTabLeft(pageWidth)
              : markChipLeft({
                  blockLeft: block.left,
                  blockRight: block.right,
                  pageWidth,
                  chipWidth: chipW,
                  pad: chipPad,
                });
            const chipTop = isAiTab
              ? (aiTabTops.get(footnote.id) ?? block.top)
              : block.top + chipPad;
            const chipStyle = {
              left: chipLeft,
              top: chipTop,
              ...(isAiTab ? { width: AI_TAB_WIDTH, height: AI_TAB_HEIGHT } : {}),
              ...tint,
            };
            const caption = footnote.title?.replace(/\s+/g, " ").trim() ?? "";
            return (
              <span key={footnote.id} className="lc-doc-footnote-pack" style={tint}>
                {paintBands.map((bandRect, bandIndex) => (
                    <div
                      key={`fn-band-${bandIndex}`}
                      className="lc-doc-footnote-band"
                      style={{
                        left: bandRect.left,
                        top: bandRect.top,
                        width: bandRect.width,
                        height: bandRect.height,
                        ...tint,
                      }}
                    />
                  ))}
                {caption ? (
                  <span
                    className="lc-doc-footnote-caption"
                    style={{ left: chipLeft + chipW, top: chipTop }}
                  >
                    {caption}
                  </span>
                ) : null}
                <HoldButton
                  label={String(number)}
                  className={`lc-doc-footnote lc-doc-footnote-bookmark lc-doc-footnote-${footnote.kind}${
                    isAiTab ? " lc-doc-footnote-tab" : ""
                  }`}
                  style={chipStyle}
                  dataId={footnote.id}
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
              </span>
            );
          })}

          {paintedSubMarks.flatMap((entry) =>
            entry.rects.map((rect, index) => (
              <div
                key={`sub-${entry.id}-${index}`}
                className={`lc-doc-submark-paint lc-doc-submark-${entry.kind}${
                  hoveredSubMarkId === entry.id ? " is-hovered" : ""
                }`}
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  ...(entry.color
                    ? footnoteThemeVars(entry.color, entry.palette ?? inkPalette)
                    : subMarkTint),
                }}
              />
            )),
          )}
          {subMarkLivePaint.map((rect, index) => (
            <div
              key={`sub-live-${index}`}
              className={`lc-doc-submark-paint lc-doc-submark-live lc-doc-submark-${subMarkMode ?? "underline"}`}
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                ...subMarkLiveTint,
              }}
            />
          ))}
          {subMarkLivePaint.length > 0 &&
            subMarkLive != null &&
            subMarkLive.end - subMarkLive.start >= 2 && (
            <>
              {(() => {
                const startRect = subMarkLivePaint[0]!;
                const endRect = subMarkLivePaint[subMarkLivePaint.length - 1]!;
                const hit = 20;
                const startStem = 6;
                const endStem = 6;
                return (
                  <>
                    <button
                      type="button"
                      className="lc-doc-submark-grip"
                      data-grip="start"
                      style={{
                        left: startRect.left - hit / 2,
                        top: startRect.top + startRect.height - hit / 2,
                        ["--lc-grip-stem" as string]: `${startStem}px`,
                        ...subMarkLiveTint,
                      }}
                      aria-label="Adjust selection start"
                    />
                    <button
                      type="button"
                      className="lc-doc-submark-grip"
                      data-grip="end"
                      style={{
                        left: endRect.left + endRect.width - hit / 2,
                        top: endRect.top + endRect.height - hit / 2,
                        ["--lc-grip-stem" as string]: `${endStem}px`,
                        ...subMarkLiveTint,
                      }}
                      aria-label="Adjust selection end"
                    />
                  </>
                );
              })()}
            </>
          )}
        </div>,
      )}
      {/*
        Accept / reject, then actions — one surface that morphs.

        Portalled to the body rather than painted into the page overlay, and
        that is not a cosmetic choice: the overlay lives inside the board, where
        the scroll gatekeeper takes pointer capture, and a control there gets no
        `click` at all — its `pointerup` is retargeted to the capturing element.
        Out here the chip is an ordinary button. Shared `layoutId` grows the
        ✓/✕ pill into the action sheet so the two steps read as one control.
      */}
      {(
        ((phase === "confirm" || phase === "actions") && selection) ||
        (subMarkArmed && subMarkConfirm)
      ) &&
        createPortal(
          <>
            {phase === "actions" && (
              <button
                type="button"
                className="lc-doc-sheet-backdrop"
                aria-label="Dismiss selection actions"
                onPointerDown={(event) => {
                  event.preventDefault();
                  dismiss();
                }}
              />
            )}
            <div
              className={
                phase === "actions"
                  ? "lc-doc-sheet lc-doc-sheet-actions-menu lc-doc-selection-chrome"
                  : "lc-doc-confirm lc-doc-selection-chrome"
              }
              role={phase === "actions" ? "menu" : undefined}
              ref={bindSelectionChrome}
              /* Do not put left/top here — React would reset every render and
                 fight clampInto. Start hidden; placeSelectionChrome reveals. */
              style={{ visibility: "hidden" }}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                {phase !== "actions" ? (
                  <motion.div
                    key="confirm"
                    className="lc-doc-confirm-row"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12 }}
                  >
                    <button
                      type="button"
                      className="lc-doc-confirm-btn lc-doc-confirm-yes"
                      aria-label="Use this selection"
                      title="Use this selection"
                      onClick={() => {
                        if (subMarkArmed && subMarkConfirm) {
                          acceptSubMarkRef.current?.();
                          return;
                        }
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
                        setActionsVia("marquee");
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
                      onClick={() => {
                        if (subMarkArmed && subMarkConfirm) {
                          setSubMarkLive(null);
                          setSubMarkConfirm(false);
                          return;
                        }
                        dismiss();
                      }}
                    >
                      ✕
                    </button>
                  </motion.div>
                ) : (
                  <motion.div
                    key="actions"
                    className="lc-doc-sheet-body"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.14, delay: 0.04 }}
                  >
                    {overlaps.length > 0 && (
                      <ul className="lc-doc-sheet-marks" aria-label="Marks on this selection">
                        {overlaps.map((footnote) => (
                          <li key={footnote.id}>
                            <button
                              type="button"
                              role="menuitem"
                              className="lc-agent-scope-option"
                              onClick={() => {
                                const rect = highlightBox();
                                dismiss();
                                onOpenFootnote?.(footnote, rect);
                              }}
                            >
                              {/*
                                The number, not the words.
                                
                                The excerpt used to sit under the heading, and it
                                is a whole sentence of the page you are already
                                looking at — at any window size it either wrapped
                                the sheet into a paragraph or ran off the end of
                                it clipped mid-word. The row's job is to let you
                                pick between marks stacked on the same words, and
                                the number does that.
                              */}
                              <strong>{`Open ${footnoteNumbers.get(footnote.id) ?? ""}`.trim()}</strong>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="lc-doc-sheet-actions">
                      {onMark && (
                        <button
                          type="button"
                          role="menuitem"
                          className="lc-doc-sheet-action"
                          onClick={() => act(onMark)}
                        >
                          <MarkActionIcon />
                          <span>Mark</span>
                        </button>
                      )}
                      {selection && selection.text.trim().length > 0 && (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            className="lc-doc-sheet-action"
                            onClick={() => {
                              const current = selection;
                              const run = onCopy;
                              if (!current || !run) return;
                              const anchorRect = highlightBox();
                              void Promise.resolve(run(current, anchorRect)).then((ok) => {
                                // `false` = clipboard write failed (App shows toast).
                                if (ok === false) return;
                                setCopied(true);
                              }).finally(() => {
                                dismiss();
                              });
                            }}
                          >
                            <CopyActionIcon />
                            <span>{copied ? "Copied" : "Copy"}</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="lc-doc-sheet-action"
                            onClick={() => act(onSearch)}
                          >
                            <SearchActionIcon />
                            <span>Google</span>
                          </button>
                        </>
                      )}
                      {/* Annotate = make a mark — text quote or hold-marquee. */}
                      {onAnnotate && (
                        <button
                          type="button"
                          role="menuitem"
                          className="lc-doc-sheet-action"
                          onClick={() => act(onAnnotate)}
                        >
                          <AnnotateActionIcon />
                          <span>Annotate</span>
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

/** What a ribbon says on hover, and to a screen reader. */
function footnoteTitle(footnote: DocFootnote, number: number): string {
  const named = footnote.title?.replace(/\s+/g, " ").trim();
  const what = footnote.excerpt || "this area";
  const head = named ? `${number}. ${named}` : `${number}.`;
  switch (footnote.kind) {
    case "search":
      return `${head} Search — ${footnote.query ?? what}`;
    case "note":
      return `${head} Highlight — ${what}`;
    case "ai":
      return `${head} AI tab — ${what}`;
    default:
      return `${head} Agent — ${what}`;
  }
}

function CopyActionIcon() {
  return (
    <svg className="lc-doc-sheet-action-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <rect x="5.5" y="5.5" width="7" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M3.5 10.5V3.8A1.3 1.3 0 0 1 4.8 2.5h5.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SearchActionIcon() {
  return (
    <svg className="lc-doc-sheet-action-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.2 10.2 3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function AnnotateActionIcon() {
  return (
    <svg className="lc-doc-sheet-action-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <path
        d="M4 12.5 11.2 5.3a1.4 1.4 0 0 1 2 2L6 14.5H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="m10.2 4.3 1.5-1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MarkActionIcon() {
  return (
    <svg className="lc-doc-sheet-action-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <path
        d="M4 2.5h5.5L12 5v8.5H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M9.5 2.5V5H12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
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
 * Character range inside `root` that belongs to the parent mark.
 *
 * Text anchors use their offsets. Region marks collect glyphs whose boxes
 * intersect the mark bands — never fall back to the document start (that is
 * how "lc whiteboard" got selected while the box was on Agent instructions).
 */
function parentTextBounds(
  body: HTMLElement,
  root: HTMLElement,
  parent: DocFootnote,
  bands: readonly LocalRect[],
): { start: number; end: number } | null {
  if (isTextAnchor(parent.anchor)) {
    if (parent.anchor.end <= parent.anchor.start) return null;
    return { start: parent.anchor.start, end: parent.anchor.end };
  }

  const scale = scaleOf(body) || 1;
  const bodyBox = body.getBoundingClientRect();
  const clientBands = bands.map((band) => ({
    left: bodyBox.left + band.left * scale,
    top: bodyBox.top + band.top * scale,
    right: bodyBox.left + (band.left + band.width) * scale,
    bottom: bodyBox.top + (band.top + band.height) * scale,
  }));
  const hitsBand = (rect: DOMRect) =>
    clientBands.some(
      (band) =>
        rect.left < band.right &&
        rect.right > band.left &&
        rect.top < band.bottom &&
        rect.bottom > band.top,
    );

  let min = Infinity;
  let max = -Infinity;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (!text.data || !/\S/.test(text.data)) continue;
    const full = document.createRange();
    full.selectNodeContents(text);
    const fullBox = full.getBoundingClientRect();
    if ((fullBox.width > 0 || fullBox.height > 0) && !hitsBand(fullBox)) continue;

    const length = text.data.length;
    let runStart: number | null = null;
    for (let i = 0; i <= length; i += 1) {
      let inside = false;
      if (i < length) {
        const range = document.createRange();
        try {
          range.setStart(text, i);
          range.setEnd(text, i + 1);
        } catch {
          continue;
        }
        const rect = range.getBoundingClientRect();
        inside =
          (rect.width >= 0.25 || rect.height >= 0.25) && hitsBand(rect);
      }
      if (inside && runStart == null) runStart = i;
      if (!inside && runStart != null) {
        const range = document.createRange();
        try {
          range.setStart(text, runStart);
          range.setEnd(text, i);
        } catch {
          runStart = null;
          continue;
        }
        const anchor = anchorFromRange(root, range, parent.anchor.scope);
        if (anchor) {
          min = Math.min(min, anchor.start);
          max = Math.max(max, anchor.end);
        }
        runStart = null;
      }
    }
  }

  if (Number.isFinite(min) && max > min) return { start: min, end: max };

  /*
   * Last resort: blockText / excerpt as a probe, but only if that slice's
   * painted box still sits inside the bands.
   */
  const block = parent.blockText?.trim() || parent.excerpt?.trim() || "";
  if (!block) return null;
  const stream = textOf(root);
  const probe = block.slice(0, Math.min(48, block.length));
  let from = 0;
  while (from < stream.length) {
    const base = stream.indexOf(probe, from);
    if (base < 0) break;
    const end = Math.min(base + block.length, stream.length);
    const range = rangeFromAnchor(root, {
      kind: "text",
      start: base,
      end: Math.max(base + 1, Math.min(end, base + probe.length)),
      ...(parent.anchor.scope ? { scope: parent.anchor.scope } : {}),
    });
    if (range) {
      const box = range.getBoundingClientRect();
      if (hitsBand(box)) {
        return { start: base, end: Math.min(base + block.length, stream.length) };
      }
    }
    from = base + 1;
  }
  return null;
}

function pointInLocalBands(
  body: HTMLElement,
  bands: readonly LocalRect[],
  clientX: number,
  clientY: number,
  pad = 0,
): boolean {
  const { x, y } = viewportToLocal(body, clientX, clientY);
  return bands.some(
    (band) =>
      x >= band.left - pad &&
      x <= band.left + band.width + pad &&
      y >= band.top - pad &&
      y <= band.top + band.height + pad,
  );
}

function resolveSubMarkAnchor(
  parent: DocFootnote,
  mark: DocFootnoteSubMark,
): DocAnchor | null {
  if (mark.anchor) return mark.anchor;
  if (!isTextAnchor(parent.anchor)) return null;
  return {
    kind: "text",
    start: parent.anchor.start + mark.start,
    end: parent.anchor.start + mark.end,
    ...(parent.anchor.scope ? { scope: parent.anchor.scope } : {}),
  };
}
