/**
 * Pages reading: hold the view on one page, and turn it like paper.
 *
 * Nothing about the document's layout changes. The pages still sit in one
 * long stack in board scene space, with the ink where it was written; this
 * only narrows how far the camera may scroll (`setPageLock`) and moves it a
 * page at a time. The turn itself is a picture: the page being left and the
 * page being turned to are captured once when the drag starts, and a canvas
 * over the view curls one over the other while the finger moves. When it lets
 * go, past halfway the camera lands on the new page and the picture goes;
 * short of that the sheet settles back and nothing moved at all.
 *
 * Turning is a finger's (or a mouse's) sideways drag, taken from the board
 * only once it is clearly sideways — up and down stays the board's own pan,
 * inside the page. With a drawing tool up the page is for writing on, so
 * turning waits until the pen is put away; the arrow and Page keys turn too.
 */

import { useEffect, useRef, type RefObject } from "react";

import type { BoardHandle } from "../BoardHandle";
import type { PageFrame } from "../inkPageIndex";
import { peekPdfFilmCurrent, subscribePdfFilmCurrent } from "../../modes/pdfFilm";
import { isSubMarkDragLive, selectionOwnsGesture } from "../docSelectionGesture";
import { cornerForDrag, turnCommits, type Point } from "./curl";
import { paintTurn, type TurnLayout } from "./paintTurn";
import { boardResizeDeferred } from "../../util/splitResize";
import { protectGestureSurface } from "../../util/gestureExclusion";

/** Sideways travel before a drag is taken as a page turn, in CSS pixels. */
const TURN_SLOP_PX = 14;
/** How much more sideways than vertical it must be. */
const TURN_AXIS_RATIO = 1.6;
/** A full turn played without a finger (keys), in ms. */
const AUTO_TURN_MS = 460;
/** Finishing or settling back from a release, at most, in ms. */
const SETTLE_MS = 300;
/** A text spread's facing picture is taken again once writing has rested this long. */
const FACING_SETTLE_MS = 1200;
/** Pictures kept for turns: this page and its neighbours — in a spread, three spreads' worth. */
const SHOT_CACHE = 8;
/** How long the view must sit still before the next turn's pictures are taken. */
const PREFETCH_IDLE_MS = 600;
/** How often a still page checks whether its pictures went stale (a sharper paint landed). */
const PREFETCH_RECHECK_MS = 1500;
/** Fastest a settle plays, in ms: a flick is quick, but still a page turning. */
const MIN_SETTLE_MS = 70;
/** Released faster than this toward (or away from) the end, the turn follows the throw: px per ms. */
const FLICK_PX_PER_MS = 0.45;
/** A release this soon after the last movement is a throw; later, the hand had stopped. */
const FLICK_FRESH_MS = 60;
/** Let go before the pictures were taken: how long to wait for them before simply going. */
const PICTURE_WAIT_MS = 450;
/** A key pressed during a turn finishes it this fast… */
const HURRY_MS = 110;
/** …and the turns it queued play at this pace. */
const QUICK_TURN_MS = 240;
/** Most turns a held or hammered key may queue ahead. */
const KEY_QUEUE_MAX = 2;
/** A finger on the text turns only on a swipe this quick — the selection's hold arms at 260 ms. */
const BODY_SWIPE_MS = 220;
/** The page's turning edges: this share of its width, within these bounds (px). Matches the CSS. */
const EDGE_SHARE = 0.12;
const EDGE_MIN_PX = 44;
const EDGE_MAX_PX = 120;

/**
 * Pixels per scene unit for a turn's pictures: the view's own resolution,
 * capped at 1.5 device pixels — the sheet is moving, and four full-resolution
 * screenfuls held for it would cost more memory than the turn is worth.
 */
function shotScale(clientWidth: number, sceneWidth: number): number {
  const dpr = typeof window !== "undefined" ? Math.min(1.5, window.devicePixelRatio || 1) : 1;
  return sceneWidth > 0 ? dpr * (clientWidth / sceneWidth) : dpr;
}

type Direction = "next" | "prev";

interface Scene {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageTurnProps {
  boardRef: RefObject<BoardHandle | null>;
  /** The PDF's film scope — the workspace's tab id. */
  filmScope: string;
  /** The element the board lives in; drags that start elsewhere are not ours. */
  hostSelector: string;
  /** Pages reading is on for an open PDF on screen: hold the camera to a page. */
  lockActive: boolean;
  /** …and turning is allowed: the pen is away and this tab has focus. */
  turnEnabled: boolean;
  /** The sheet is split into two reading slots. Off shows whole sheets. */
  spread: boolean;
  /**
   * The document brings its own pages (a PDF). Text, code, markdown and EPUB
   * are cut into view-high pages instead, and always turn as single sheets.
   */
  paged: boolean;
  /**
   * How much of the view the whole page fills on its limiting side — 1 edge
   * to edge — with everything around it hidden. Null reads at the width fit.
   */
  fit?: number | null;
}

function frameIndexAt(frames: readonly PageFrame[], y: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < frames.length; i += 1) {
    const f = frames[i]!;
    if (y >= f.minY && y < f.maxY) return i;
    const dist = Math.min(Math.abs(y - f.minY), Math.abs(y - f.maxY));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * Where in the view to look for the page it shows: the middle. A fitted page
 * sits centred with the board around it, so anywhere nearer an edge can be
 * off the page — a quarter down landed on the sheet above a wide page, and
 * every check then "followed" the view there, a page further back each time.
 */
function probeY(view: { y: number; height: number }): number {
  return view.y + view.height / 2;
}

/**
 * The view still shows the held page: its middle is inside the box the board
 * holds that page in (a text page's box runs past a short cut), or inside the
 * page itself when there is no box for it.
 */
function showsHeld(board: BoardHandle, held: PageFrame, y: number): boolean {
  const box = board.readingPageBox();
  const span = box && Math.abs(box.minY - held.minY) < 0.5 ? box : held;
  return y >= span.minY && y <= span.maxY;
}

/** The frame the lock holds, when it is still one of these; else the one in view. */
function currentIndex(
  frames: readonly PageFrame[],
  locked: PageFrame | null,
  view: { y: number; height: number },
): number {
  if (locked) {
    const i = frames.findIndex((f) => Math.abs(f.minY - locked.minY) < 0.5 && Math.abs(f.maxY - locked.maxY) < 0.5);
    if (i >= 0) return i;
  }
  return frameIndexAt(frames, probeY(view));
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * What a PDF page's picture was taken from: the size its bitmap is painted
 * at now. A picture taken while the page was still a preview goes stale the
 * moment the sharp paint lands, and is taken again.
 */
function pdfPaintSignature(hostSelector: string, pageId: number): string {
  if (!(pageId >= 1)) return "";
  const host = document.querySelector(hostSelector);
  const canvases = host?.querySelectorAll<HTMLCanvasElement>(`[data-pdf-page="${pageId}"] canvas.lc-pdf-canvas`);
  return canvases ? Array.from(canvases, (c) => c.width).join(",") : "";
}

type ShotCache = Map<string, Promise<HTMLCanvasElement | null>>;

/**
 * A picture of part of the document, taken once.
 *
 * Keyed on what it shows — where, at what scale, with which ink, from which
 * paint — so a stroke added since, a zoom or a sharper paint takes a fresh
 * one. At most a few kept: each is a screenful of pixels.
 */
function takeShot(
  shots: ShotCache,
  b: BoardHandle,
  scene: Scene,
  scale: number,
  cutY: number,
  signature: string,
): Promise<HTMLCanvasElement | null> {
  const key = [scene.x, scene.y, scene.width, scene.height, scale, b.getInkRevision(), Math.min(cutY, 1e9)]
    .map((n) => Math.round(n * 100) / 100)
    .join(":") + `@${signature}`;
  let taken = shots.get(key);
  if (!taken) {
    // Below a text page's cut is the next page's text, which the view
    // hides; the picture has to hide it too.
    taken = b.captureSceneFrame(scene, scale).then((canvas) => {
      const cut = cutY - scene.y;
      if (!canvas || !(cut < scene.height)) return canvas;
      const ctx = canvas.getContext("2d");
      if (!ctx) return canvas;
      const top = Math.max(0, Math.round((cut / scene.height) * canvas.height));
      ctx.fillStyle = paperColor();
      ctx.fillRect(0, top, canvas.width, canvas.height - top);
      return canvas;
    }).catch(() => null);
    shots.set(key, taken);
    while (shots.size > SHOT_CACHE) shots.delete(shots.keys().next().value!);
  }
  return taken;
}

/** A text page's whole box in scene units — its column, one screenful high from its top. */
function pageBoxScene(b: BoardHandle, frame: PageFrame): Scene | null {
  const box = b.readingPageBox();
  if (!box) return null;
  return { x: box.minX, y: frame.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
}

/** Two page pictures side by side, one blank when the spread has only one page. */
function composeSpread(left: HTMLCanvasElement | null, right: HTMLCanvasElement | null): HTMLCanvasElement | null {
  const one = left ?? right;
  if (!one) return null;
  const canvas = document.createElement("canvas");
  canvas.width = one.width * 2;
  canvas.height = one.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = paperColor();
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (left) ctx.drawImage(left, 0, 0, one.width, one.height);
  if (right) ctx.drawImage(right, one.width, 0, one.width, one.height);
  return canvas;
}

function paperColor(): string {
  if (typeof document === "undefined") return "#ffffff";
  return getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#ffffff";
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

/** A turn in flight: what is being turned, and the picture of it. */
interface Turn {
  direction: Direction;
  layout: TurnLayout;
  bottom: boolean;
  from: PageFrame;
  to: PageFrame;
  /** Where the view sits relative to the page top, kept across the turn. */
  offsetInPage: number;
  /** View-space (CSS px) rectangle the overlay covers. */
  rect: { left: number; top: number; width: number; height: number };
  canvas: HTMLCanvasElement;
  images: { from: HTMLCanvasElement; to: HTMLCanvasElement } | null;
  /** Settles true once both pictures are in, false if they cannot be had. */
  ready: Promise<boolean>;
  corner: Point;
  /** The settle playing now, if any. */
  anim: { began: number; ms: number; start: Point; goal: Point; commit: boolean } | null;
  frame: number;
  done: boolean;
}

export function PageTurn({ boardRef, filmScope, hostSelector, lockActive, turnEnabled, spread, paged, fit = null }: PageTurnProps) {
  const turnRef = useRef<Turn | null>(null);
  /** The page the camera is held to. */
  const lockedRef = useRef<PageFrame | null>(null);
  /** Text pages two to a spread. A PDF's spread is its layout, not this. */
  const textSpread = spread && !paged;
  const textSpreadRef = useRef(textSpread);
  textSpreadRef.current = textSpread;
  const turnEnabledRef = useRef(turnEnabled);
  turnEnabledRef.current = turnEnabled;
  const spreadRef = useRef(spread);
  spreadRef.current = spread;
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  /** Pictures of pages taken ahead of a turn, keyed by what they show. */
  const shotsRef = useRef(new Map<string, Promise<HTMLCanvasElement | null>>());
  useEffect(() => () => shotsRef.current.clear(), []);

  // Register before the touch starts: claiming a small band on pointerdown
  // is too late once Android has already claimed an edge swipe as Back.
  useEffect(() => {
    if (!lockActive || !turnEnabled) return;
    const host = document.querySelector<HTMLElement>(hostSelector);
    const surface = host?.querySelector<HTMLElement>(".lc-board") ?? host;
    if (surface) return protectGestureSurface(surface, true);
  }, [hostSelector, lockActive, turnEnabled]);

  /* Hold the camera on the page it is on, and follow jumps made elsewhere. */
  useEffect(() => {
    if (!lockActive) {
      boardRef.current?.setPageLock(null);
      return;
    }
    let lockedCount = -1;
    lockedRef.current = null;
    const relock = () => {
      const board = boardRef.current;
      if (!board || turnRef.current || boardResizeDeferred()) return;
      const view = board.getViewportBounds();
      const frames = board.readingPageFrames();
      if (!view || frames.length === 0) return;
      lockedCount = frames.length;
      // A jump made elsewhere moves the view off the held page: follow it.
      const held = lockedRef.current;
      const probe = probeY(view);
      const stays = held && showsHeld(board, held, probe);
      const locked = frames[stays ? currentIndex(frames, held, view) : pageInView(frames, view)]!;
      lockedRef.current = locked;
      board.setPageLock(locked);
    };
    /*
     * The page to hold when none is: a PDF's current page — the one its
     * filmstrip and page count show, which scroll reading puts at the top of
     * the view — else whichever page is in the middle of it. Of a split sheet's
     * two halves, the one more on screen.
     */
    const pageInView = (frames: readonly PageFrame[], view: { y: number; height: number }) => {
      const current = pagedRef.current ? peekPdfFilmCurrent(filmScope) : 0;
      let best = -1;
      let bestOverlap = -Infinity;
      frames.forEach((f, i) => {
        if (f.pageId !== current) return;
        const overlap = Math.min(f.maxY, view.y + view.height) - Math.max(f.minY, view.y);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = i;
        }
      });
      // Only while it is on screen: before anything publishes it, it reads 1.
      return best >= 0 && bestOverlap > 0 ? best : frameIndexAt(frames, probeY(view));
    };
    const unsubscribe = subscribePdfFilmCurrent(filmScope, relock);
    /*
     * Layout arrives in batches on a first open, and some jumps (a footnote,
     * the filmstrip on a text document) move the camera without passing
     * through a page turn. Lock again when either happens, or the next pan
     * would drag the view back to the page it left.
     */
    /*
     * …and when the pages are cut again: content changes can re-cut the
     * document, while resizing fits the held page with its boundaries intact.
     */
    const poll = window.setInterval(() => {
      const board = boardRef.current;
      if (!board || turnRef.current || boardResizeDeferred()) return;
      const frames = board.readingPageFrames();
      const view = board.getViewportBounds();
      const held = lockedRef.current;
      const probe = view ? probeY(view) : null;
      const drifted = held && probe != null && !showsHeld(board, held, probe);
      const recut = held != null && frames.length > 0 &&
        !frames.some((f) => Math.abs(f.minY - held.minY) < 0.5 && Math.abs(f.maxY - held.maxY) < 0.5);
      if (frames.length !== lockedCount || drifted || recut) {
        // A re-cut page is found again by its top, not by where the view is.
        if (recut && held) lockedRef.current = frames[frameIndexAt(frames, held.minY + 1)] ?? null;
        relock();
      }
    }, 400);
    return () => {
      unsubscribe();
      window.clearInterval(poll);
      lockedRef.current = null;
      boardRef.current?.setPageLock(null);
    };
  }, [boardRef, filmScope, lockActive]);

  /* The page fit, for as long as pages are held; the width fit after. */
  useEffect(() => {
    if (!lockActive) return;
    return () => boardRef.current?.setPageFit(null);
  }, [boardRef, lockActive]);
  useEffect(() => {
    if (!lockActive) return;
    boardRef.current?.setPageSpread(textSpread);
    return () => boardRef.current?.setPageSpread(false);
  }, [boardRef, lockActive, textSpread]);
  useEffect(() => {
    if (lockActive) boardRef.current?.setPageFit(fit);
  }, [boardRef, lockActive, fit]);

  /*
   * A text spread's facing page.
   *
   * Only one page of the document is on the board at a time — the one held —
   * so the page facing it is a picture of itself, kept current while the held
   * page is written on. Touching the facing page makes it the held one, on the
   * spot where its picture was and before the touch reaches the page, so a
   * stroke or a selection started there lands on the page itself; the page it
   * leaves becomes the picture.
   */
  useEffect(() => {
    if (!lockActive || !textSpread) return;
    const facingEl = () =>
      document.querySelector(hostSelector)?.querySelector<HTMLElement>(".lc-page-mask-facing") ?? null;
    const same = (a: PageFrame, b: PageFrame) => Math.abs(a.minY - b.minY) < 0.5 && Math.abs(a.maxY - b.maxY) < 0.5;
    /** The held page's own picture, for when it becomes the facing one. */
    let live: { page: PageFrame; canvas: HTMLCanvasElement } | null = null;
    let lastRevision = -1;
    let revisionAt = 0;
    let shows: number | null = null;
    let disposed = false;
    let refreshing = false;
    let refreshFrame = 0;

    const refresh = () => {
      if (disposed || refreshing || boardResizeDeferred()) return;
      const b = boardRef.current;
      const el = facingEl();
      const held = lockedRef.current;
      if (!b || !el || el.hidden || !held || turnRef.current) return;
      // While a page is being written on, its facing picture waits for a pause.
      const revision = b.getInkRevision();
      const now = performance.now();
      if (revision !== lastRevision) {
        lastRevision = revision;
        revisionAt = now;
      }
      if (shows != null && now - revisionAt < FACING_SETTLE_MS) return;
      const frames = b.readingPageFrames();
      const i = frames.findIndex((f) => same(f, held));
      if (i < 0) return;
      const facing = frames[i % 2 === 0 ? i + 1 : i - 1];
      const hole = el.parentElement?.getBoundingClientRect();
      const heldScene = pageBoxScene(b, held);
      if (!hole || !heldScene) return;
      const scale = shotScale(hole.width / 2, heldScene.width);
      refreshing = true;
      const liveShot = takeShot(shotsRef.current, b, heldScene, scale, held.maxY, "").then((canvas) => {
        if (!disposed && canvas && lockedRef.current === held) live = { page: held, canvas };
      });
      if (!facing) {
        el.replaceChildren();
        shows = -1;
        void liveShot.finally(() => { refreshing = false; });
        return;
      }
      const scene = pageBoxScene(b, facing);
      if (!scene) { void liveShot.finally(() => { refreshing = false; }); return; }
      const facingShot = takeShot(shotsRef.current, b, scene, scale, facing.maxY, "").then((canvas) => {
        if (disposed || !canvas || lockedRef.current !== held || el.hidden) return;
        if (el.firstElementChild !== canvas) el.replaceChildren(canvas);
        shows = facing.minY;
      });
      void Promise.all([liveShot, facingShot]).finally(() => { refreshing = false; });
    };

    const onDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      const b = boardRef.current;
      const el = facingEl();
      const held = lockedRef.current;
      if (!b || !el || el.hidden || !held || turnRef.current) return;
      const r = el.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) return;
      // The outer edge is the turn's, while turning is on.
      const hole = el.parentElement?.getBoundingClientRect();
      if (hole && turnEnabledRef.current && event.pointerType !== "pen") {
        const zone = Math.min(EDGE_MAX_PX, Math.max(EDGE_MIN_PX, hole.width * EDGE_SHARE));
        if (event.clientX <= hole.left + zone || event.clientX >= hole.right - zone) return;
      }
      const frames = b.readingPageFrames();
      const i = frames.findIndex((f) => same(f, held));
      const facing = i >= 0 ? frames[i % 2 === 0 ? i + 1 : i - 1] : undefined;
      if (!facing) return;
      el.replaceChildren(...(live && same(live.page, held) ? [live.canvas] : []));
      shows = held.minY;
      lockedRef.current = facing;
      b.setPageLock(facing);
    };

    refresh();
    const unsubscribe = subscribePdfFilmCurrent(filmScope, () => {
      cancelAnimationFrame(refreshFrame);
      refreshFrame = requestAnimationFrame(refresh);
    });
    const timer = window.setInterval(refresh, 700);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      disposed = true;
      cancelAnimationFrame(refreshFrame);
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", onDown, true);
      facingEl()?.replaceChildren();
    };
  }, [boardRef, filmScope, hostSelector, lockActive, textSpread]);

  useEffect(() => {
    if (!turnEnabled) return;

    const board = () => boardRef.current;

    /*
     * A picture of part of the document, taken once.
     *
     * Keyed on what it shows — where, at what scale, with which ink — so a
     * stroke added since, or a zoom, takes a fresh one. At most a few kept:
     * each is a screenful of pixels.
     */
    const shot = (b: BoardHandle, scene: Scene, scale: number, cutY = Infinity, pageId = 0) =>
      takeShot(shotsRef.current, b, scene, scale, cutY, pagedRef.current ? pdfPaintSignature(hostSelector, pageId) : "");

    /**
     * The part of the page at `at` in view, in scene units: its column, and
     * the box the board holds it in — for a text page, one screenful high
     * whether it was cut short or ran on with the space after it.
     */
    const pageScene = (b: BoardHandle, frames: readonly PageFrame[], at: number): Scene | null => {
      const view = b.getViewportBounds();
      const from = frames[at];
      if (!view || !from) return null;
      const box = b.readingPageBox();
      const held = box && Math.abs(box.minY - from.minY) < 0.5;
      const left = Math.max(view.x, box?.minX ?? view.x);
      const right = Math.min(view.x + view.width, box?.maxX ?? view.x + view.width);
      const top = Math.max(view.y, from.minY);
      const bottom = Math.min(view.y + view.height, held ? box.maxY : from.maxY);
      if (right - left < 8 || bottom - top < 8) return null;
      return { x: left, y: top, width: right - left, height: bottom - top };
    };

    /** Take the pictures a turn from here would need, while nothing is moving. */
    let prefetchTimer = 0;
    let disposed = false;
    let prefetching = false;
    const prefetch = () => {
      window.clearTimeout(prefetchTimer);
      prefetchTimer = window.setTimeout(() => {
        const b = board();
        if (!b || disposed || prefetching || turnRef.current || boardResizeDeferred()) return;
        const view = b.getViewportBounds();
        const frames = b.readingPageFrames();
        if (!view || frames.length === 0) return;
        const at = currentIndex(frames, lockedRef.current, view);
        const from = frames[at]!;
        const current = () => !disposed && !turnRef.current && !boardResizeDeferred() &&
          board() === b && b.getViewportBounds()?.y === view.y && b.getViewportBounds()?.zoom === view.zoom;
        if (textSpreadRef.current) {
          // This spread, and the ones either side of it, page by page.
          const start = at - (at % 2);
          const pageShot = spreadPageShot(b, frames);
          if (!pageShot) return;
          prefetching = true;
          void (async () => {
            try {
              for (const i of [start, start + 1, start + 2, start + 3, start - 2, start - 1]) {
                if (!current()) return;
                await pageShot(i);
              }
            } finally { prefetching = false; }
          })();
          return;
        }
        const scene = pageScene(b, frames, at);
        if (!scene) return;
        const tl = b.sceneToClient(scene.x, scene.y);
        const br = b.sceneToClient(scene.x + scene.width, scene.y + scene.height);
        if (!tl || !br) return;
        const scale = shotScale(br.x - tl.x, scene.width);
        prefetching = true;
        void (async () => {
          try {
            await shot(b, scene, scale, from.maxY, from.pageId);
            for (const neighbour of [frames[at + 1], frames[at - 1]]) {
              if (!current()) return;
              if (!neighbour) continue;
              await shot(b, { ...scene, y: neighbour.minY + (scene.y - from.minY) }, scale, neighbour.maxY, neighbour.pageId);
            }
          } finally { prefetching = false; }
        })();
      }, PREFETCH_IDLE_MS);
    };
    const unsubscribeFilm = subscribePdfFilmCurrent(filmScope, prefetch);
    // Sharp paints land after the first pictures were taken: look again while
    // the page sits still. Unchanged pictures are kept, not taken twice.
    const recheck = window.setInterval(() => {
      if (!turnRef.current) prefetch();
    }, PREFETCH_RECHECK_MS);

    /** The open spread on screen: both pages, as the board shows them. */
    const spreadRect = () => {
      const hole = document.querySelector(hostSelector)?.querySelector<HTMLElement>(".lc-page-mask-hole");
      const r = hole?.getBoundingClientRect();
      return r && r.width > 16 && r.height > 8 ? r : null;
    };

    /** Take (or find) the picture of page `i` of a text spread, at the size it is shown. */
    const spreadPageShot = (b: BoardHandle, frames: readonly PageFrame[]) => {
      const r = spreadRect();
      const first = frames[0] ? pageBoxScene(b, frames[0]) : null;
      if (!r || !first) return null;
      const scale = shotScale(r.width / 2, first.width);
      return (i: number): Promise<HTMLCanvasElement | null> => {
        const f = frames[i];
        const scene = f ? pageBoxScene(b, f) : null;
        return f && scene ? shot(b, scene, scale, f.maxY, f.pageId) : Promise.resolve(null);
      };
    };

    /**
     * A turn in a text spread: two pages at a time, like a book — the right
     * page lifts over the spine onto the left, showing the next spread.
     */
    const planSpreadTurn = (
      b: BoardHandle,
      frames: readonly PageFrame[],
      at: number,
      direction: Direction,
      bottom: boolean,
    ): Turn | null => {
      const start = at - (at % 2);
      const toStart = direction === "next" ? start + 2 : start - 2;
      const from = frames[start];
      const to = frames[toStart];
      const r = spreadRect();
      const pageShot = spreadPageShot(b, frames);
      if (!from || !to || !r || !pageShot) return null;
      const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      const canvas = document.createElement("canvas");
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.className = "lc-page-turn";
      Object.assign(canvas.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      const w = rect.width / 2;
      const turn: Turn = {
        direction,
        layout: "book",
        bottom,
        from,
        to,
        offsetInPage: 0,
        rect,
        canvas,
        images: null,
        corner: { x: direction === "next" ? w : -w, y: bottom ? rect.height : 0 },
        anim: null,
        ready: Promise.resolve(false),
        frame: 0,
        done: false,
      };
      const spreadShot = (s: number) =>
        Promise.all([pageShot(s), pageShot(s + 1)]).then(([left, right]) => composeSpread(left, right));
      turn.ready = Promise.all([spreadShot(start), spreadShot(toStart)]).then(
        ([here, there]) => {
          if (turnRef.current !== turn || turn.done || !here || !there) return false;
          turn.images = direction === "next" ? { from: here, to: there } : { from: there, to: here };
          document.body.append(canvas);
          draw(turn);
          return true;
        },
        () => false,
      );
      return turn;
    };

    const planTurn = (direction: Direction, bottom: boolean): Turn | null => {
      const b = board();
      if (!b) return null;
      const view = b.getViewportBounds();
      const frames = b.readingPageFrames();
      if (!view || frames.length === 0) return null;
      const at = currentIndex(frames, lockedRef.current, view);
      if (textSpreadRef.current) return planSpreadTurn(b, frames, at, direction, bottom);
      const toIndex = direction === "next" ? at + 1 : at - 1;
      const from = frames[at];
      const to = frames[toIndex];
      if (!from || !to) return null;
      // The visible part of this page — the page, not the view around it —
      // and where it is on screen.
      const scene = pageScene(b, frames, at);
      if (!scene) return null;
      const tl = b.sceneToClient(scene.x, scene.y);
      const br = b.sceneToClient(scene.x + scene.width, scene.y + scene.height);
      if (!tl || !br) return null;
      const rect = { left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y };
      if (rect.width < 8 || rect.height < 8) return null;
      // A landscape sheet is two pages side by side: it turns about its spine.
      const columnWidth = (() => {
        const box = b.readingPageBox();
        return box ? box.maxX - box.minX : view.width;
      })();
      const layout: TurnLayout =
        pagedRef.current && !spreadRef.current && from.maxY - from.minY < columnWidth * 0.9 ? "book" : "sheet";
      const canvas = document.createElement("canvas");
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.className = "lc-page-turn";
      Object.assign(canvas.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      const w = layout === "book" ? rect.width / 2 : rect.width;
      const turn: Turn = {
        direction,
        layout,
        bottom,
        from,
        to,
        // With the page fitted the view starts above it; land on the top.
        offsetInPage: Math.max(0, view.y - from.minY),
        rect,
        canvas,
        images: null,
        corner: { x: direction === "next" ? w : -w, y: bottom ? rect.height : 0 },
        anim: null,
        ready: Promise.resolve(false),
        frame: 0,
        done: false,
      };
      // Capture both pages at the size they are drawn. The page being turned to
      // is taken at the same place within it the view shows of this one.
      const scale = shotScale(rect.width, scene.width);
      const toScene = { ...scene, y: to.minY + (scene.y - from.minY) };
      turn.ready = Promise.all([
        shot(b, scene, scale, from.maxY, from.pageId),
        shot(b, toScene, scale, to.maxY, to.pageId),
      ]).then(
        ([here, there]) => {
          if (turnRef.current !== turn || turn.done || !here || !there) return false;
          // Turning back is turning forward from the previous page, reversed.
          turn.images = direction === "next" ? { from: here, to: there } : { from: there, to: here };
          document.body.append(canvas);
          draw(turn);
          return true;
        },
        () => false,
      );
      return turn;
    };

    const draw = (turn: Turn) => {
      if (!turn.images || turn.frame) return;
      turn.frame = requestAnimationFrame(() => {
        turn.frame = 0;
        const ctx = turn.canvas.getContext("2d");
        if (!ctx || !turn.images) return;
        const dpr = turn.canvas.width / turn.rect.width;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        paintTurn(ctx, {
          layout: turn.layout,
          width: turn.rect.width,
          height: turn.rect.height,
          from: turn.images.from,
          to: turn.images.to,
          sourceWidth: turn.images.from.width,
          sourceHeight: turn.images.from.height,
          corner: turn.corner,
          bottom: turn.bottom,
          paper: paperColor(),
        });
      });
    };

    const teardown = (turn: Turn) => {
      turn.done = true;
      setTurning(false);
      if (turn.frame) cancelAnimationFrame(turn.frame);
      // Two frames: the camera's jump has to reach the screen before the
      // picture of where it was going stops covering it.
      requestAnimationFrame(() => requestAnimationFrame(() => turn.canvas.remove()));
      if (turnRef.current === turn) turnRef.current = null;
    };

    const land = (turn: Turn) => {
      const b = board();
      if (!b) return;
      lockedRef.current = turn.to;
      b.setPageLock(turn.to);
      b.jumpToPageFrame({ ...turn.to, minY: turn.to.minY + turn.offsetInPage });
      prefetch();
    };

    /** Turns queued by a key pressed while one was playing. */
    let queued: { direction: Direction; count: number } | null = null;

    const step = (turn: Turn) => (now: number) => {
      const a = turn.anim;
      if (turn.done || !a) return;
      const t = Math.min(1, (now - a.began) / a.ms);
      const k = easeOutCubic(t);
      turn.corner = { x: a.start.x + (a.goal.x - a.start.x) * k, y: a.start.y + (a.goal.y - a.start.y) * k };
      draw(turn);
      if (t < 1) {
        requestAnimationFrame(step(turn));
        return;
      }
      if (a.commit) land(turn);
      teardown(turn);
      nextQueued();
    };

    /**
     * Play the corner from where it is to fully over, or back to rest.
     *
     * `speed` is how fast the hand was moving when it let go (px/ms): the
     * sheet leaves at that speed and eases out, so a flick is a quick turn
     * rather than a slow one or none at all. Without pictures yet, it waits a
     * moment for them — a fast turn still shows the page turning.
     */
    const settle = (turn: Turn, commit: boolean, { fullMs = SETTLE_MS, speed = 0 } = {}) => {
      const run = () => {
        if (turn.done) return;
        const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
        // Finishing means reaching the end the turn is headed for.
        const goal = {
          x: (turn.direction === "next") === commit ? -w : w,
          y: turn.bottom ? turn.rect.height : 0,
        };
        const start = { ...turn.corner };
        const px = Math.abs(goal.x - start.x);
        let ms = Math.max(80, fullMs * (px / (2 * w)));
        // An ease-out cubic starts at three times its average speed.
        if (speed > 0) ms = Math.max(MIN_SETTLE_MS, Math.min(ms, (3 * px) / speed));
        turn.anim = { began: performance.now(), ms, start, goal, commit };
        requestAnimationFrame(step(turn));
      };
      if (turn.images) {
        run();
        return;
      }
      let decided = false;
      const giveUp = window.setTimeout(() => {
        if (decided) return;
        decided = true;
        if (turn.done) return;
        if (commit) land(turn);
        teardown(turn);
        nextQueued();
      }, PICTURE_WAIT_MS);
      void turn.ready.then((ok) => {
        if (decided) return;
        decided = true;
        window.clearTimeout(giveUp);
        if (turn.done) return;
        if (ok) {
          run();
          return;
        }
        if (commit) land(turn);
        teardown(turn);
        nextQueued();
      });
    };

    /** Finish the turn playing now, quickly: another is waiting behind it. */
    const hurry = (turn: Turn) => {
      const a = turn.anim;
      if (!a || turn.done) return;
      const left = a.ms - (performance.now() - a.began);
      if (left <= HURRY_MS) return;
      turn.anim = { ...a, began: performance.now(), ms: HURRY_MS, start: { ...turn.corner } };
    };

    const keyTurn = (direction: Direction, ms: number): boolean => {
      const turn = planTurn(direction, true);
      if (!turn) return false;
      turnRef.current = turn;
      settle(turn, true, { fullMs: ms });
      return true;
    };

    const nextQueued = () => {
      const q = queued;
      if (!q) return;
      q.count -= 1;
      if (q.count <= 0) queued = null;
      // The next frame: the landing camera has to be in place to plan from.
      requestAnimationFrame(() => {
        if (turnRef.current || active) return;
        if (!keyTurn(q.direction, QUICK_TURN_MS)) queued = null;
      });
    };

    /* ---------------------------------------------------------- gesture */

    /*
     * Where a turn may start, so it is never mistaken for a selection.
     *
     *   - The page's outer edges are its turning edges, for a finger or a
     *     mouse, shown as a faint sheen that brightens under the pointer. A
     *     press there is the turn's alone: nothing selects from the edge.
     *   - On the text, a mouse drag is a selection and never turns. A finger
     *     turns only on a quick swipe; one that rests is the selection's hold.
     *   - Whatever claims the gesture first keeps it: a selection that has
     *     taken the finger is not turned over, and a turn clears the selection
     *     and holds text selection off until it lands.
     */
    const host = () => document.querySelector<HTMLElement>(hostSelector);
    const pageRect = (): DOMRect | null => {
      const hole = host()?.querySelector<HTMLElement>(".lc-page-mask-hole");
      if (!hole || (hole.parentElement as HTMLElement | null)?.hidden) return null;
      const rect = hole.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8 ? rect : null;
    };
    const edgeAt = (x: number, y: number): "left" | "right" | null => {
      const r = pageRect();
      if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      const zone = Math.min(EDGE_MAX_PX, Math.max(EDGE_MIN_PX, r.width * EDGE_SHARE));
      if (x <= r.left + zone) return "left";
      if (x >= r.right - zone) return "right";
      return null;
    };
    const setHover = (edge: "left" | "right" | null) => {
      const el = host();
      if (!el) return;
      if (edge) el.dataset.turnHover = edge;
      else delete el.dataset.turnHover;
    };
    const setTurning = (on: boolean) => {
      const el = host();
      if (!el) return;
      if (on) {
        el.dataset.turnActive = "";
        window.getSelection()?.removeAllRanges();
      } else {
        delete el.dataset.turnActive;
      }
    };
    const edgesHost = host();
    if (edgesHost) edgesHost.dataset.turnEdges = "";

    let pending: {
      id: number;
      x: number;
      y: number;
      t: number;
      target: EventTarget | null;
      type: string;
      edge: boolean;
    } | null = null;
    let active: { id: number; x: number; y: number; turn: Turn; vx: number; lastX: number; lastT: number } | null = null;
    /** The board's cancel is on its way through our own listeners. */
    let handingOff = false;

    const inHost = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest(hostSelector)) &&
      !target.closest(
        "button, a, input, textarea, select, [role='menu'], [role='dialog'], .lc-board-chrome-slot, .lc-map-controls," +
          " .lc-doc-footnote, .lc-doc-footnote-pack, .lc-footnote-bubble, .lc-doc-select-overlay, .lc-doc-sheet, .lc-doc-confirm",
      );

    const onDown = (event: PointerEvent) => {
      if (turnRef.current || active) return;
      // A second finger is a pinch, not a turn: the first one's drag is off.
      if (!event.isPrimary && event.pointerType === "touch") pending = null;
      if (event.button !== 0 || !event.isPrimary) return;
      if (event.pointerType === "pen") return; // the stylus writes; fingers and mice turn
      if (!inHost(event.target)) return;
      const edgeSide = edgeAt(event.clientX, event.clientY);
      const edge = edgeSide != null;
      // The text is the selection's under a mouse.
      if (!edge && event.pointerType === "mouse") return;
      pending = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        t: event.timeStamp,
        target: event.target,
        type: event.pointerType,
        edge,
      };
      if (edge) {
        // The edge is the turn's: no text selection, no hold, no pan from it.
        event.stopImmediatePropagation();
        event.preventDefault();
        // A finger has no hover: show the edge it pressed.
        if (event.pointerType === "touch") setHover(edgeSide);
      }
    };

    const onMove = (event: PointerEvent) => {
      if (active && event.pointerId === active.id) {
        event.stopImmediatePropagation();
        event.preventDefault();
        const dt = event.timeStamp - active.lastT;
        if (dt > 0) {
          active.vx = active.vx * 0.5 + ((event.clientX - active.lastX) / dt) * 0.5;
          active.lastX = event.clientX;
          active.lastT = event.timeStamp;
        }
        const turn = active.turn;
        const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
        turn.corner = cornerForDrag(turn.direction, event.clientX - active.x, event.clientY - active.y, w, turn.rect.height, turn.bottom);
        draw(turn);
        return;
      }
      if (!pending) {
        if (event.pointerType === "mouse" && event.buttons === 0) setHover(edgeAt(event.clientX, event.clientY));
        return;
      }
      if (event.pointerId !== pending.id) return;
      // A selection that has the finger, or a mouse already selecting, keeps it.
      if (!pending.edge && (selectionOwnsGesture() || isSubMarkDragLive())) {
        pending = null;
        return;
      }
      const dx = event.clientX - pending.x;
      const dy = event.clientY - pending.y;
      if (Math.abs(dy) > TURN_SLOP_PX && Math.abs(dy) > Math.abs(dx)) {
        pending = null; // a scroll within the page; the board keeps it
        return;
      }
      if (Math.abs(dx) < TURN_SLOP_PX || Math.abs(dx) < Math.abs(dy) * (pending.edge ? 1 : TURN_AXIS_RATIO)) {
        // A finger resting on the text is on its way to a selection, not a turn.
        if (!pending.edge && event.timeStamp - pending.t > BODY_SWIPE_MS) pending = null;
        return;
      }
      if (!pending.edge && event.timeStamp - pending.t > BODY_SWIPE_MS) {
        pending = null;
        return;
      }
      const direction: Direction = dx < 0 ? "next" : "prev";
      const hostRect = (pending.target as Element).closest(hostSelector)?.getBoundingClientRect();
      const bottom = hostRect ? pending.y > hostRect.top + hostRect.height / 2 : true;
      const turn = planTurn(direction, bottom);
      if (!turn) {
        pending = null; // first or last page: nothing to turn to
        return;
      }
      // Take the gesture from the board: its pan ends here, as if cancelled.
      // The cancel passes our own listeners on the way, so the gesture is
      // ours before it is sent and the echo is ignored.
      const claimed = pending;
      pending = null;
      turnRef.current = turn;
      setTurning(true);
      active = { id: claimed.id, x: event.clientX - dx, y: event.clientY - dy, turn, vx: 0, lastX: event.clientX, lastT: event.timeStamp };
      if (claimed.target instanceof Element) {
        handingOff = true;
        try {
          claimed.target.dispatchEvent(
            new PointerEvent("pointercancel", { pointerId: claimed.id, pointerType: claimed.type, bubbles: true }),
          );
        } finally {
          handingOff = false;
        }
      }
      event.stopImmediatePropagation();
      event.preventDefault();
      const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
      turn.corner = cornerForDrag(direction, dx, dy, w, turn.rect.height, bottom);
    };

    const onUp = (event: PointerEvent) => {
      if (handingOff) return;
      if (event.pointerType === "touch") setHover(null);
      if (pending && event.pointerId === pending.id) pending = null;
      if (!active || event.pointerId !== active.id) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      const { turn, vx, lastT } = active;
      active = null;
      // A throw decides the turn by where it was going; a stop, by where it is.
      const fresh = event.timeStamp - lastT < FLICK_FRESH_MS;
      const along = fresh ? (turn.direction === "next" ? -vx : vx) : 0;
      const commit =
        event.type !== "pointercancel" &&
        (along > FLICK_PX_PER_MS ? true : along < -FLICK_PX_PER_MS ? false : turnCommits(turn.direction, turn.corner.x));
      settle(turn, commit, { speed: fresh ? Math.abs(vx) : 0 });
    };

    const swallowClick = (event: MouseEvent) => {
      if (turnRef.current) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (active || event.defaultPrevented || isTypingTarget(event.target)) return;
      // Shift+arrows extend a text selection; the others are shortcuts.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const direction: Direction | null =
        event.key === "ArrowRight" || event.key === "PageDown" ? "next"
          : event.key === "ArrowLeft" || event.key === "PageUp" ? "prev"
            : null;
      if (!direction) return;
      const playing = turnRef.current;
      if (playing) {
        // Faster than a turn takes: finish this one now and line up the next.
        event.preventDefault();
        if (playing.direction !== direction || !playing.anim?.commit) return;
        const count = queued?.direction === direction ? queued.count : 0;
        queued = { direction, count: Math.min(KEY_QUEUE_MAX, count + 1) };
        hurry(playing);
        return;
      }
      if (keyTurn(direction, queued ? QUICK_TURN_MS : AUTO_TURN_MS)) event.preventDefault();
    };

    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("click", swallowClick, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("click", swallowClick, true);
      window.removeEventListener("keydown", onKey);
      disposed = true;
      window.clearTimeout(prefetchTimer);
      window.clearInterval(recheck);
      const el = host();
      if (el) {
        delete el.dataset.turnEdges;
        delete el.dataset.turnHover;
        delete el.dataset.turnActive;
      }
      unsubscribeFilm();
      const turn = turnRef.current;
      if (turn) teardown(turn);
    };
  }, [boardRef, filmScope, hostSelector, turnEnabled]);

  return null;
}
