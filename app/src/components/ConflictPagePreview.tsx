/**
 * One side of the conflict split: the same document harness as the reader,
 * scrolled in this pane — not the 48px filmstrip JPEG.
 *
 * Marks and packed ink overlay the stack, filtered by the current picks. The
 * change list sits on top of this in the parent.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { InkPageDto } from "../api/client";
import { inkOpsBounds, type InkOp } from "../canvas/rasterInk";
import { makeDocFlagHolds, type DocFlagHolds } from "../canvas/docSelectionGesture";
import { AnnotateDocument } from "../modes/AnnotateDocument";
import { DocSelectionLayer } from "../modes/DocSelectionLayer";
import { PdfDocument, type PdfPageNatural } from "../modes/PdfDocument";
import { conflictPdfFrames } from "./conflictDocumentLayout";
import { publishPdfFilmCurrent, publishPdfViewPages } from "../modes/pdfFilm";
import { borrowPdfDocument } from "../modes/pdfOpenDocs";
import { pdfVisibleFromSpans } from "../modes/pdfPaintWindow";
import { cameraPulseSettleMs } from "../util/cameraBusy";
import type { PageFrame } from "../canvas/inkPageIndex";
import type { DocFootnote } from "../util/docFootnotes";
import { SCRATCH_PAGE_W } from "../templates/whiteboard";
import {
  activeLinedPitch,
  linedPaperScenePitch,
  type LinedPitchPair,
  type LinedRuling,
  type LinedPaperMode,
} from "../util/linedPaperPref";
import {
  conflictFitSpan,
  conflictInkPlacement,
  conflictInkXBounds,
  conflictLinedBackground,
  conflictOpsForPage,
  conflictPaperFrames,
  conflictPaperPageStyle,
  decodeConflictInkPages,
  inkSlotsEqual,
  inkedPageIds,
  inkPageIdsFromOps,
  pageFramesEqual,
  type ConflictInkSlot,
} from "./conflictInkLayout";
import { attachOverflowFlick } from "./conflictPreviewFlick";
import { ConflictInkPainter, conflictInkBackingSize, conflictVisibleInkTiles } from "./conflictInkPaint";
import { previewScrollAnchor, previewScrollTop, type PreviewPageBox, type PreviewScrollAnchor } from "./conflictScrollAnchor";

const EMPTY_PDF_BYTES = new ArrayBuffer(0);

/**
 * Pages either side of the focused one this pane keeps a bitmap for.
 *
 * The reader's ring is `PDF_PREVIEW_RADIUS`, because a flick has to land on
 * something already decoded. The split mounts two of these over a reader that
 * is often still mounted, so the full ring would be three decode rings and
 * three text-layer fills of a textbook — for a question about a single page,
 * which is the page each pane opens on and the one it scrolls back to when the
 * focus moves. One either side is enough to scroll off without a white slot,
 * and it is what the pane actually needs.
 */
export const CONFLICT_PAINT_RADIUS = 1;

export function ConflictPagePreview({
  hash,
  page,
  notes,
  inkPages,
  showInk = false,
  droppedPages,
  keptPages,
  bytes,
  filmScope,
  sourceText,
  sceneWidth,
  pageFrames,
  pageCount,
  linedPitch,
  linedPitchPair,
  linedRule,
  linedPaperMode = "off",
  focusKey,
  decodedInk,
  inkLoading = false,
  onVisiblePages,
  selectedPageOnly = false,
  revealInk = false,
}: {
  hash?: string;
  page: number;
  notes?: readonly DocFootnote[];
  inkPages?: readonly InkPageDto[];
  showInk?: boolean;
  droppedPages?: readonly number[];
  keptPages?: readonly number[];
  bytes?: ArrayBuffer;
  filmScope?: string;
  sourceText?: string;
  /** Board scene width the ink was drawn in, so overlay maps onto this pane. */
  sceneWidth?: number;
  /**
   * Where each page sits in the scene the ink was drawn in.
   *
   * Strokes are stored in board scene coordinates — absolute scene Y down the
   * whole stack — and bucketed by which page frame contains them. Without the
   * frames there is no way to know where page 40's ink *starts*, so it would
   * be painted as though the page began at scene zero.
   */
  pageFrames?: readonly PageFrame[];
  /** Notebook length when frames are missing or shorter than the pad. */
  pageCount?: number;
  /** Scene pitch the rules were written to, so merge lines sit under the ink. */
  linedPitch?: number;
  linedPitchPair?: LinedPitchPair | null;
  linedRule?: LinedRuling | null;
  linedPaperMode?: LinedPaperMode;
  /** Re-scroll when the focused row changes, even if the page number did not. */
  focusKey?: string;
  /**
   * Already-decoded strokes from the split. When this is passed (even empty),
   * the pane does not gunzip again — that second decode is what wedged Android.
   */
  decodedInk?: readonly { pageId: number; ops: InkOp[] }[];
  inkLoading?: boolean;
  onVisiblePages?: (pages: readonly number[]) => void;
  selectedPageOnly?: boolean;
  revealInk?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<HTMLDivElement | null>(null);
  /*
   * This pane's own share of the module camera flags, keyed by filmScope so
   * Local's leftover flick does not cancel Server's page.render.
   */
  const holdsRef = useRef<DocFlagHolds | null>(null);
  if (!holdsRef.current) holdsRef.current = makeDocFlagHolds(filmScope);
  const holds = holdsRef.current;
  const [cssWidth, setCssWidth] = useState(0);
  const layoutWidthRef = useRef(0);
  const pageBoxesRef = useRef<PreviewPageBox[]>([]);
  const resizeAnchorRef = useRef<PreviewScrollAnchor | null>(null);
  const scrollTopRef = useRef(0);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const [stackH, setStackH] = useState(0);
  const onVisiblePagesRef = useRef(onVisiblePages);
  onVisiblePagesRef.current = onVisiblePages;
  const [localShards, setDecodedShards] = useState<{ pageId: number; ops: InkOp[] }[]>(
    [],
  );
  const [decodeGen, setDecodeGen] = useState(0);
  const decodedShards = decodedInk ?? localShards;
  const [decodeDone, setDecodeDone] = useState(true);
  // Keep a lightweight loading indicator until the first visible ink is ready.
  const [loadPhase, setLoadPhase] = useState<"busy" | "done" | "idle">(
    "busy",
  );
  const [paintedInk, setPaintedInk] = useState<{
    ops: readonly InkOp[];
    slots: readonly ConflictInkSlot[];
  } | null>(null);
  const inkPagesRef = useRef(inkPages);
  inkPagesRef.current = inkPages;
  const pageFramesRef = useRef(pageFrames);
  if (!pageFramesEqual(pageFramesRef.current, pageFrames)) {
    pageFramesRef.current = pageFrames;
  }
  const [pdfPageSizes, setPdfPageSizes] = useState<readonly PdfPageNatural[]>([]);
  // The live reader's frames can belong to another replica/width. Use the
  // same MediaBoxes as this preview, laid out at this copy's saved scene width.
  const sourcePdfFrames = useMemo(() => pdfPageSizes.length && sceneWidth && sceneWidth > 0
    ? conflictPdfFrames(pdfPageSizes, sceneWidth) : undefined, [pdfPageSizes, sceneWidth]);
  const stablePageFrames = sourcePdfFrames ?? pageFramesRef.current;
  const decodedOps = useMemo(
    () => decodedShards.flatMap((shard) => shard.ops),
    [decodedShards],
  );

  useLayoutEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const apply = () => {
      const width = Math.round(node.clientWidth);
      if (width > 0 && width !== layoutWidthRef.current) {
        // The old DOM geometry has already changed when ResizeObserver runs.
        // Use the last measured page boxes and the last user scroll position.
        resizeAnchorRef.current ??= previewScrollAnchor(pageBoxesRef.current, scrollTopRef.current);
        layoutWidthRef.current = width;
        setCssWidth(width);
      }
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = hostRef.current;
    if (!root || page < 1) return;
    // An explicit row jump supersedes a resize still waiting on PDF layout.
    resizeAnchorRef.current = null;
    let gone = false;
    const jump = () => {
      if (gone) return true;
      const node = root.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`);
      if (!node) return false;
      const top =
        node.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      if (typeof root.scrollTo === "function") root.scrollTo({ top });
      else root.scrollTop = top;
      return true;
    };
    if (jump()) return;
    const observer = new MutationObserver(() => {
      if (jump()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      gone = true;
      observer.disconnect();
    };
    // Focused row, not only page number: tapping Handwriting (page 1) again
    // after a flick must still jump. Stack-height ticks must not.
  }, [page, focusKey]);

  useEffect(() => {
    const root = scrollRoot;
    if (!root) return;
    return attachOverflowFlick(root);
  }, [scrollRoot]);

  const borrowed = hash ? borrowPdfDocument(hash) : null;
  const usePdf =
    Boolean(filmScope) &&
    Boolean(hash) &&
    cssWidth > 0 &&
    (Boolean(bytes && bytes.byteLength > 0) || Boolean(borrowed));
  const useMarkdown = !usePdf && Boolean(sourceText);
  const usePaper = !usePdf && !useMarkdown;

  useLayoutEffect(() => {
    const host=hostRef.current,doc=docRef.current;
    if(!host || !doc)return;
    const base=host.getBoundingClientRect();
    const boxes=[...doc.querySelectorAll<HTMLElement>("[data-pdf-page]")].map(el=>{
      const box=el.getBoundingClientRect();
      return {page:Number(el.dataset.pdfPage),top:box.top-base.top+host.scrollTop,height:box.height};
    }).filter(box=>box.height>0);
    if(!boxes.length)return;
    // PDF updates page sizes asynchronously; don't consume the anchor against
    // the old-width slots on the first render of a resize.
    const first=doc.querySelector<HTMLElement>("[data-pdf-page]");
    if(usePdf && first && Math.abs(first.getBoundingClientRect().width-cssWidth)>2)return;
    const anchor=resizeAnchorRef.current;
    if(anchor) {
      const next=previewScrollTop(boxes,anchor);
      if(next!==null)host.scrollTop=next;
      resizeAnchorRef.current=null;
    }
    pageBoxesRef.current=boxes;
    scrollTopRef.current=host.scrollTop;
    // Trigger viewport/ink sampling even if the browser suppressed a scroll
    // event because the resulting scrollTop happened to be unchanged.
    if(anchor)host.dispatchEvent(new Event("scroll"));
  },[cssWidth,stackH,usePdf,useMarkdown]);

  useEffect(()=>{
    const host=scrollRoot;if(!host)return;
    const remember=()=>{if(!resizeAnchorRef.current)scrollTopRef.current=host.scrollTop;};
    host.addEventListener("scroll",remember,{passive:true});
    return()=>host.removeEventListener("scroll",remember);
  },[scrollRoot]);
  const inkMaxY = useMemo(() => {
    if (decodedOps.length === 0) return 0;
    const bounds = inkOpsBounds(decodedOps);
    return bounds?.maxY ?? 0;
  }, [decodedOps]);
  const paperPageCount = pageCount ?? page;
  const allPaperFrames = useMemo(
    () => conflictPaperFrames(stablePageFrames, paperPageCount, usePaper ? inkMaxY : 0),
    [stablePageFrames, paperPageCount, usePaper, inkMaxY],
  );
  const paperFrames = useMemo(() => selectedPageOnly ? allPaperFrames.filter(frame => frame.pageId === page) : allPaperFrames, [allPaperFrames, selectedPageOnly, page]);

  const keptNotes = notes ?? [];

  const inkSignature = (inkPages ?? [])
    .map((row) => `${row.page_id}:${row.updated_at}:${row.gz?.length ?? 0}`)
    .join("|");
  const parentOwnsInk = decodedInk !== undefined;

  useEffect(() => {
    setPaintedInk(null);
    setLoadPhase("busy");
    if (parentOwnsInk) {
      setDecodeDone(true);
      return;
    }
    setDecodedShards([]);
    const rows = inkPagesRef.current ?? [];
    setDecodeDone(!(showInk && rows.some((row) => row.gz)));
    setDecodeGen((n) => n + 1);
  }, [inkSignature, showInk, hash, sourceText, parentOwnsInk, decodedInk]);

  useEffect(() => {
    if (parentOwnsInk) return;
    if (!showInk) {
      setDecodedShards([]);
      setDecodeDone(true);
      return;
    }
    const rows = inkPagesRef.current ?? [];
    if (rows.length === 0 || !rows.some((row) => row.gz)) {
      setDecodedShards([]);
      setDecodeDone(true);
      return;
    }
    let gone = false;
    setDecodeDone(false);
    void (async () => {
      const shards = await decodeConflictInkPages(rows);
      if (!gone) {
        setDecodedShards(shards);
        setDecodeDone(true);
      }
    })();
    return () => {
      gone = true;
    };
  }, [showInk, decodeGen, parentOwnsInk]);

  /*
   * Scrolling this pane has to reach the same paint path the reader uses.
   *
   * The pane looked sharp at rest and went to placeholders the moment you
   * flicked it, which reads as a thumbnail strip but is not one — it is the
   * paint window. `PdfDocument` decides what to blit and at what scale from
   * `publishPdfViewPages` plus `isDocCameraLive`, and both of those are
   * published by `Board` from its camera. A standalone pane has no camera, so
   * nobody ever published them: the observer only moved C, the rest set stayed
   * empty, and every slot outside it sat at preview scale.
   *
   * So the pane publishes the same two facts from its own boxes. This is not a
   * second paint loop — nothing here decodes or draws. It says where the
   * viewport is; `blitOuterFromLru` and the decode pump do the rest, exactly
   * as they do for the board.
   */
  useEffect(() => {
    const root = scrollRoot;
    if (!root || !filmScope || !usePdf) return;
    let frame = 0;
    let settle = 0;

    const sample = () => {
      frame = 0;
      const view = root.getBoundingClientRect();
      const spans: Array<{ page: number; top: number; bottom: number }> = [];
      for (const el of root.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
        const n = Number(el.dataset.pdfPage);
        if (!Number.isFinite(n) || n < 1) continue;
        const box = el.getBoundingClientRect();
        spans.push({ page: n, top: box.top, bottom: box.bottom });
      }
      if (spans.length === 0) return;
      const { intersecting, current } = pdfVisibleFromSpans(spans, view.top, view.bottom);
      if (current < 1) return;
      onVisiblePagesRef.current?.(intersecting.length ? intersecting : [current]);
      publishPdfFilmCurrent(filmScope, current);
      publishPdfViewPages(
        filmScope,
        intersecting,
        intersecting.length ? intersecting : [current],
      );
    };

    /*
     * Live while the finger moves, settled a beat after it stops.
     *
     * The same pulse the board runs: while live the pump only does
     * preview-scale hole pages, and rest-2 fills on the settle. Without it the
     * pane would try to decode at full scale mid-flick and stutter.
     */
    const pulse = () => {
      holds.camera(true);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => holds.camera(false), cameraPulseSettleMs());
    };
    const onMove = () => {
      pulse();
      if (frame) return;
      frame = requestAnimationFrame(sample);
    };
    // Freeze on touch-down, before pan has armed — the pump must not fight the
    // finger during the gap the board also covers.
    const onDown = () => holds.pointer(true);
    const onUp = () => holds.pointer(false);

    root.addEventListener("scroll", onMove, { passive: true });
    root.addEventListener("wheel", onMove, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: true });
    root.addEventListener("pointerdown", onDown);
    // On `window`: a finger that leaves the pane still ended the gesture.
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    // Publish once for where the pane already is, rather than waiting for a
    // scroll that may never come — the landing page is the one being read.
    sample();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      root.removeEventListener("scroll", onMove);
      root.removeEventListener("wheel", onMove);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      holds.pointer(false);
      holds.camera(false);
    };
    // `stackH` re-runs this once the stack has a height, so the first sample
    // measures real slots rather than an empty host.
  }, [scrollRoot, filmScope, usePdf, stackH, page, selectedPageOnly]);

  // Measure page placement once; only nearby 512px strips receive backing stores.
  const [inkSlots, setInkSlots] = useState<ConflictInkSlot[]>([]);
  const inkedPages = useMemo(() => {
    if (usePaper && decodedOps.length > 0) {
      const ids = inkPageIdsFromOps(decodedOps, paperFrames);
      if (ids.length > 0) return ids;
    }
    if (useMarkdown) return decodedOps.length ? [1] : [];
    const ids = new Set(inkedPageIds(inkPages));
    for (const shard of decodedShards) {
      if (shard.pageId > 0) ids.add(shard.pageId);
      else for (const pageId of inkPageIdsFromOps(shard.ops, stablePageFrames ?? [])) ids.add(pageId);
    }
    return [...ids].sort((a, b) => a - b);
  }, [usePaper, useMarkdown, decodedOps, decodedShards, stablePageFrames, paperFrames, inkPages]);
  const inkX = useMemo(
    () => (usePaper ? conflictInkXBounds(decodedOps) : null),
    [usePaper, decodedOps],
  );
  const paperZoom = useMemo(() => {
    if (!usePaper || !(cssWidth > 0)) return 1;
    const fitted = conflictFitSpan(sceneWidth, inkX);
    const boxW = fitted?.width ?? (sceneWidth && sceneWidth > 0 ? sceneWidth : SCRATCH_PAGE_W);
    return cssWidth / Math.max(1, boxW);
  }, [usePaper, cssWidth, sceneWidth, inkX]);
  const scenePitch = useMemo(() => {
    if (linedPaperMode === "off") return 0;
    const fromPair = activeLinedPitch(linedPitchPair ?? null, linedRule ?? null);
    if (fromPair > 0) return fromPair;
    if (linedPitch && linedPitch > 0) return linedPitch;
    return linedPaperScenePitch(linedPaperMode, paperZoom);
  }, [linedPitchPair, linedRule, linedPitch, linedPaperMode, paperZoom]);

  useLayoutEffect(() => {
    const doc = docRef.current;
    if (!showInk || !cssWidth || !doc || inkedPages.length === 0) {
      setInkSlots((current) => (current.length === 0 ? current : []));
      return;
    }
    const base = doc.getBoundingClientRect();
    const next: ConflictInkSlot[] = [];
    for (const pageId of inkedPages) {
      const slot = doc.querySelector<HTMLElement>(`[data-pdf-page="${pageId}"]`);
      if (!slot) continue;
      const box = slot.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      next.push({
        page: pageId,
        left: box.left - base.left,
        top: box.top - base.top,
        width: box.width,
        height: box.height,
      });
    }
    setInkSlots((current) => (inkSlotsEqual(current, next) ? current : next));
    // PDF slots arrive asynchronously. Retry when the document reports its
    // measured height; scrolling alone does not change this value.
  }, [showInk, inkedPages, cssWidth, paperFrames, decodedOps, stackH, usePdf, useMarkdown, page, selectedPageOnly]);

  const [paintWindow, setPaintWindow] = useState({ top: 0, height: 800 });
  useEffect(() => {
    if (!scrollRoot) return;
    let raf = 0;
    const sample = () => {
      raf = 0;
      setPaintWindow({ top: scrollRoot.scrollTop, height: scrollRoot.clientHeight || 800 });
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(sample); };
    sample();
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    return () => { cancelAnimationFrame(raf); scrollRoot.removeEventListener("scroll", onScroll); };
  }, [scrollRoot, cssWidth, page, stackH]);
  const paintTiles = conflictVisibleInkTiles(inkSlots, paintWindow.top, paintWindow.height);
  const tileKeys = paintTiles.map(tile => tile.key).sort().join("|");
  const paintPageKey = [...new Set(paintTiles.map(tile => tile.page))].sort((a, b) => a - b).join(",");
  const tilesRef = useRef(paintTiles);
  tilesRef.current = paintTiles;
  const painterRef = useRef<ConflictInkPainter | null>(null);
  useEffect(() => {
    const frames = usePaper ? paperFrames : stablePageFrames;
    const visiblePages = new Set(tilesRef.current.map(tile => tile.page));
    const painter = new ConflictInkPainter(inkSlots.filter(slot => visiblePages.has(slot.page)).map(slot => ({
      page: slot.page,
      ...conflictInkPlacement(slot, frames?.find(frame => frame.pageId === slot.page), sceneWidth, usePaper ? inkX : null),
      ops: useMarkdown ? decodedOps : usePaper ? conflictOpsForPage(decodedOps, slot.page, paperFrames)
        : decodedShards.flatMap(shard => shard.pageId === slot.page ? shard.ops
          : shard.pageId === 0 ? (stablePageFrames?.length
            ? conflictOpsForPage(shard.ops, slot.page, stablePageFrames)
            : slot.page === 1 ? shard.ops : []) : []),
    })).map(entry => revealInk ? {...entry,ops:entry.ops.map(op => op.kind === "draw"
      ? {...op,color:"#00e5ff",maxFullness:1,pressureSensitive:false,highlight:false,speedInk:0,speedFade:0,grain:0,baseWidth:Math.max(op.baseWidth,3 / Math.max(.01,entry.scale))}
      : op)} : entry));
    painterRef.current = painter;
    setPaintedInk(null);
    return () => { painter.dispose(); painterRef.current = null; };
  }, [inkSlots, decodedOps, decodedShards, sceneWidth, stablePageFrames, paperFrames, usePaper, useMarkdown, inkX, paintPageKey, revealInk]);

  useEffect(() => {
    const painter = painterRef.current;
    const doc = docRef.current;
    if (!showInk || !doc || !painter || !inkSlots.length) {
      setPaintedInk({ ops: decodedOps, slots: inkSlots });
      return;
    }
    const controller = new AbortController();
    const tiles = tilesRef.current;
    let remaining = tiles.length;
    for (const tile of tiles) {
      const dpr = window.devicePixelRatio || 1;
      void painter.paint({ ...tile, dpr }, controller.signal).then(bitmap => {
        if (controller.signal.aborted) return;
        const canvas = doc.querySelector<HTMLCanvasElement>(`canvas[data-ink-tile="${tile.key}"]`);
        if (bitmap && canvas) {
          const size = conflictInkBackingSize(tile.width, tile.height, dpr);
          canvas.width = size.width; canvas.height = size.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        }
        if (--remaining === 0) setPaintedInk({ ops: decodedOps, slots: inkSlots });
      });
    }
    if (!tiles.length) setPaintedInk({ ops: decodedOps, slots: inkSlots });
    return () => controller.abort();
  }, [tileKeys, showInk, inkSlots, decodedOps, decodedShards, sceneWidth, stablePageFrames, paperFrames, usePaper, useMarkdown, inkX, paintPageKey, revealInk]);

  const inkPainted = paintedInk?.ops === decodedOps && paintedInk?.slots === inkSlots;
  const paperReady = cssWidth > 0 && !inkLoading && !(showInk && !decodeDone) &&
    !(showInk && inkedPages.length > 0 && (inkSlots.length === 0 || !inkPainted));

  useEffect(() => {
    if (loadPhase !== "busy") return;
    if (!paperReady) return;
    setLoadPhase("done");
  }, [loadPhase, paperReady]);

  useEffect(() => {
    if (loadPhase !== "done") return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fade = reduce ? 0 : 160;
    const id = window.setTimeout(() => setLoadPhase("idle"), fade);
    return () => window.clearTimeout(id);
  }, [loadPhase]);

  return (
    <>
    <div
      ref={(node) => {
        hostRef.current = node;
        setScrollRoot((current) => (current === node ? current : node));
      }}
      className={
        usePdf || useMarkdown || usePaper
          ? "lc-hub-conflict-preview is-harness"
          : "lc-hub-conflict-preview"
      }
      data-page={String(page)}
      data-reveal-ink={revealInk || undefined}
      aria-busy={loadPhase !== "idle"}
    >
      {usePdf && filmScope ? (
        <div className="lc-hub-conflict-doc" ref={docRef}>
          <DocSelectionLayer
            enabled={false}
            placeExisting
            paletteScope={filmScope}
            /*
             * The same page, narrower. A region anchor is a box against its
             * own page, so it comes across in proportion — this is that
             * proportion, and it is the transform the ink already uses.
             */
            markScale={sceneWidth && sceneWidth > 0 ? cssWidth / sceneWidth : 1}
            markPageFrames={stablePageFrames}
            footnotes={keptNotes}
          >
            <PdfDocument
              filmScope={filmScope}
              bytes={bytes && bytes.byteLength > 0 ? bytes : EMPTY_PDF_BYTES}
              docHash={hash}
              frameWidth={cssWidth}
              initialPage={page}
              standalone
              scrollRoot={scrollRoot}
              paintRadius={selectedPageOnly ? 0 : CONFLICT_PAINT_RADIUS}
              previewPage={selectedPageOnly ? page : undefined}
              idleThumbs={false}
              selectable={false}
              spread={false}
              onMeasure={setStackH}
              onPageSizes={setPdfPageSizes}
            />
          </DocSelectionLayer>
          {showInk
            ? paintTiles.map((slot) => (
                <canvas
                  key={slot.key}
                  width={0} height={0}
                  data-ink-page={slot.page}
                  data-ink-tile={slot.key}
                  className="lc-hub-conflict-ink-layer"
                  style={{
                    left: slot.left,
                    top: slot.top,
                    width: slot.width,
                    height: slot.height,
                    opacity: droppedPages?.includes(slot.page) ? 0.38 : 1,
                  }}
                  aria-hidden
                />
              ))
            : null}
        </div>
      ) : useMarkdown && sourceText ? (
        <div className="lc-hub-conflict-doc" ref={docRef}>
          <div data-pdf-page="1" style={{ position: "relative", height: stackH * cssWidth / (sceneWidth || cssWidth || 1) }}>
            <div style={{ width: sceneWidth || cssWidth, transformOrigin: "top left", transform: `scale(${cssWidth / (sceneWidth || cssWidth || 1)})` }}>
              <DocSelectionLayer enabled={false} placeExisting paletteScope={filmScope} footnotes={keptNotes}>
                <AnnotateDocument source={sourceText} selectable={false} onMeasure={setStackH} />
              </DocSelectionLayer>
            </div>
          </div>
          {showInk ? paintTiles.map(slot => (
            <canvas key={slot.key} width={0} height={0} data-ink-page={slot.page} data-ink-tile={slot.key}
              className="lc-hub-conflict-ink-layer" aria-hidden
              style={{ left: slot.left, top: slot.top, width: slot.width, height: slot.height, opacity: droppedPages?.includes(slot.page) ? 0.38 : 1 }} />
          )) : null}
        </div>
      ) : (
        <div className="lc-hub-conflict-doc" ref={docRef}>
          {paperFrames.map((frame, index) => {
            const lined = conflictLinedBackground(frame.minY, scenePitch, paperZoom);
            const pick = droppedPages?.includes(frame.pageId)
              ? "drop"
              : keptPages?.includes(frame.pageId)
                ? "keep"
                : undefined;
            return (
              <div
                key={frame.pageId}
                className="lc-hub-conflict-lined"
                data-pdf-page={String(frame.pageId)}
                data-pick={pick}
                style={{
                  ...conflictPaperPageStyle(
                    frame,
                    sceneWidth,
                    index === paperFrames.length - 1,
                    conflictFitSpan(sceneWidth, inkX)?.width,
                  ),
                  ...(lined ?? { backgroundImage: "none" }),
                }}
              />
            );
          })}
          {showInk
            ? paintTiles.map((slot) => (
                <canvas
                  key={slot.key}
                  width={0} height={0}
                  data-ink-page={slot.page}
                  data-ink-tile={slot.key}
                  className="lc-hub-conflict-ink-layer"
                  style={{
                    left: slot.left,
                    top: slot.top,
                    width: slot.width,
                    height: slot.height,
                    opacity: droppedPages?.includes(slot.page) ? 0.38 : 1,
                  }}
                  aria-hidden
                />
              ))
            : null}
        </div>
      )}
    </div>
      {loadPhase !== "idle" ? (
        <div
          className={
            loadPhase === "done"
              ? "lc-hub-conflict-load is-done"
              : "lc-hub-conflict-load"
          }
          role="status"
          aria-live="polite"
          aria-label={loadPhase === "done" ? "Preview ready" : "Loading preview"}
        >
          {loadPhase === "done" ? (
            <div className="lc-spinner-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22">
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
          ) : (
            <div className="lc-spinner" aria-hidden="true" />
          )}
        </div>
      ) : null}
    </>
  );
}
