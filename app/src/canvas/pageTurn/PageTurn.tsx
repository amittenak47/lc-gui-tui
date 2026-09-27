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
import { subscribePdfFilmCurrent } from "../../modes/pdfFilm";
import { cornerForDrag, turnCommits, type Point } from "./curl";
import { paintTurn, type TurnLayout } from "./paintTurn";

/** Sideways travel before a drag is taken as a page turn, in CSS pixels. */
const TURN_SLOP_PX = 14;
/** How much more sideways than vertical it must be. */
const TURN_AXIS_RATIO = 1.6;
/** A full turn played without a finger (keys), in ms. */
const AUTO_TURN_MS = 460;
/** Finishing or settling back from a release, at most, in ms. */
const SETTLE_MS = 300;
/** Pictures kept for turns: this page and its two neighbours, and a spare. */
const SHOT_CACHE = 4;
/** How long the view must sit still before the next turn's pictures are taken. */
const PREFETCH_IDLE_MS = 600;

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
 * Where in the view to look for the page it shows. A quarter down, not the
 * middle: a fitted text page cut short of the next block can end above the
 * middle of the view, and the middle would then name the page after it.
 */
function probeY(view: { y: number; height: number }): number {
  return view.y + view.height * 0.25;
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

/** What the view shows around a fitted page — see `.lc-page-mask-hole`. */
function maskColor(): string {
  if (typeof document === "undefined") return "#ffffff";
  const root = getComputedStyle(document.documentElement);
  return root.getPropertyValue("--lc-page-mask").trim() || root.getPropertyValue("--bg").trim() || "#ffffff";
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
  corner: Point;
  frame: number;
  done: boolean;
}

export function PageTurn({ boardRef, filmScope, hostSelector, lockActive, turnEnabled, spread, paged, fit = null }: PageTurnProps) {
  const turnRef = useRef<Turn | null>(null);
  /** The page the camera is held to. */
  const lockedRef = useRef<PageFrame | null>(null);
  const spreadRef = useRef(spread);
  spreadRef.current = spread;
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  /** Pictures of pages taken ahead of a turn, keyed by what they show. */
  const shotsRef = useRef(new Map<string, Promise<HTMLCanvasElement | null>>());

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
      if (!board || turnRef.current) return;
      const view = board.getViewportBounds();
      const frames = board.readingPageFrames();
      if (!view || frames.length === 0) return;
      lockedCount = frames.length;
      // A jump made elsewhere moves the view off the held page: follow it.
      const held = lockedRef.current;
      const probe = probeY(view);
      const stays = held && probe >= held.minY && probe < held.maxY;
      const locked = frames[stays ? currentIndex(frames, held, view) : frameIndexAt(frames, probe)]!;
      lockedRef.current = locked;
      board.setPageLock(locked);
    };
    const unsubscribe = subscribePdfFilmCurrent(filmScope, relock);
    /*
     * Layout arrives in batches on a first open, and some jumps (a footnote,
     * the filmstrip on a text document) move the camera without passing
     * through a page turn. Lock again when either happens, or the next pan
     * would drag the view back to the page it left.
     */
    /*
     * …and when the pages are cut again: a text document is re-cut to the new
     * view whenever the window changes size, and the held page with it.
     */
    const poll = window.setInterval(() => {
      const board = boardRef.current;
      if (!board || turnRef.current) return;
      const frames = board.readingPageFrames();
      const view = board.getViewportBounds();
      const held = lockedRef.current;
      const probe = view ? probeY(view) : null;
      const drifted = held && probe != null && (probe < held.minY || probe > held.maxY);
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
    if (lockActive) boardRef.current?.setPageFit(fit);
  }, [boardRef, lockActive, fit]);

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
    const shot = (b: BoardHandle, scene: Scene, scale: number, cutY = Infinity) => {
      const key = [scene.x, scene.y, scene.width, scene.height, scale, b.getInkRevision(), Math.min(cutY, 1e9)]
        .map((n) => Math.round(n * 100) / 100)
        .join(":");
      const shots = shotsRef.current;
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
          ctx.fillStyle = maskColor();
          ctx.fillRect(0, top, canvas.width, canvas.height - top);
          return canvas;
        }).catch(() => null);
        shots.set(key, taken);
        while (shots.size > SHOT_CACHE) shots.delete(shots.keys().next().value!);
      }
      return taken;
    };

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
    const prefetch = () => {
      window.clearTimeout(prefetchTimer);
      prefetchTimer = window.setTimeout(() => {
        const b = board();
        if (!b || turnRef.current) return;
        const view = b.getViewportBounds();
        const frames = b.readingPageFrames();
        if (!view || frames.length === 0) return;
        const at = currentIndex(frames, lockedRef.current, view);
        const from = frames[at]!;
        const scene = pageScene(b, frames, at);
        if (!scene) return;
        const tl = b.sceneToClient(scene.x, scene.y);
        const br = b.sceneToClient(scene.x + scene.width, scene.y + scene.height);
        if (!tl || !br) return;
        const scale = shotScale(br.x - tl.x, scene.width);
        void (async () => {
          await shot(b, scene, scale, from.maxY);
          for (const neighbour of [frames[at + 1], frames[at - 1]]) {
            if (!neighbour || turnRef.current) continue;
            await shot(b, { ...scene, y: neighbour.minY + (scene.y - from.minY) }, scale, neighbour.maxY);
          }
        })();
      }, PREFETCH_IDLE_MS);
    };
    const unsubscribeFilm = subscribePdfFilmCurrent(filmScope, prefetch);

    const planTurn = (direction: Direction, bottom: boolean): Turn | null => {
      const b = board();
      if (!b) return null;
      const view = b.getViewportBounds();
      const frames = b.readingPageFrames();
      if (!view || frames.length === 0) return null;
      const at = currentIndex(frames, lockedRef.current, view);
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
        offsetInPage: view.y - from.minY,
        rect,
        canvas,
        images: null,
        corner: { x: direction === "next" ? w : -w, y: bottom ? rect.height : 0 },
        frame: 0,
        done: false,
      };
      // Capture both pages at the size they are drawn. The page being turned to
      // is taken at the same place within it the view shows of this one.
      const scale = shotScale(rect.width, scene.width);
      const toScene = { ...scene, y: to.minY + (scene.y - from.minY) };
      void Promise.all([shot(b, scene, scale, from.maxY), shot(b, toScene, scale, to.maxY)]).then(
        ([here, there]) => {
          if (turnRef.current !== turn || turn.done || !here || !there) return;
          // Turning back is turning forward from the previous page, reversed.
          turn.images = direction === "next" ? { from: here, to: there } : { from: there, to: here };
          document.body.append(canvas);
          draw(turn);
        },
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

    /** Play the corner from where it is to fully over, or back to rest. */
    const settle = (turn: Turn, commit: boolean, fullMs = SETTLE_MS) => {
      const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
      // Finishing means reaching the end the turn is headed for.
      const goal = {
        x: (turn.direction === "next") === commit ? -w : w,
        y: turn.bottom ? turn.rect.height : 0,
      };
      const start = { ...turn.corner };
      const distance = Math.abs(goal.x - start.x) / (2 * w);
      const ms = Math.max(80, fullMs * distance);
      const began = performance.now();
      const step = (now: number) => {
        if (turn.done) return;
        const t = Math.min(1, (now - began) / ms);
        const k = easeOutCubic(t);
        turn.corner = { x: start.x + (goal.x - start.x) * k, y: start.y + (goal.y - start.y) * k };
        if (turn.images) draw(turn);
        if (t < 1) {
          requestAnimationFrame(step);
          return;
        }
        if (commit) land(turn);
        teardown(turn);
      };
      requestAnimationFrame(step);
    };

    /* ---------------------------------------------------------- gesture */

    let pending: { id: number; x: number; y: number; target: EventTarget | null; type: string } | null = null;
    let active: { id: number; x: number; y: number; turn: Turn } | null = null;
    /** The board's cancel is on its way through our own listeners. */
    let handingOff = false;

    const inHost = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest(hostSelector)) &&
      !target.closest("button, a, input, textarea, select, [role='menu'], [role='dialog'], .lc-board-chrome-slot, .lc-map-controls");

    const onDown = (event: PointerEvent) => {
      if (turnRef.current || active) return;
      if (event.button !== 0 || !event.isPrimary) return;
      if (event.pointerType === "pen") return; // the stylus writes; fingers and mice turn
      if (!inHost(event.target)) return;
      pending = { id: event.pointerId, x: event.clientX, y: event.clientY, target: event.target, type: event.pointerType };
    };

    const onMove = (event: PointerEvent) => {
      if (active && event.pointerId === active.id) {
        event.stopImmediatePropagation();
        event.preventDefault();
        const turn = active.turn;
        const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
        turn.corner = cornerForDrag(turn.direction, event.clientX - active.x, event.clientY - active.y, w, turn.rect.height, turn.bottom);
        draw(turn);
        return;
      }
      if (!pending || event.pointerId !== pending.id) return;
      const dx = event.clientX - pending.x;
      const dy = event.clientY - pending.y;
      if (Math.abs(dy) > TURN_SLOP_PX && Math.abs(dy) > Math.abs(dx)) {
        pending = null; // a scroll within the page; the board keeps it
        return;
      }
      if (Math.abs(dx) < TURN_SLOP_PX || Math.abs(dx) < Math.abs(dy) * TURN_AXIS_RATIO) return;
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
      active = { id: claimed.id, x: event.clientX - dx, y: event.clientY - dy, turn };
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
      if (pending && event.pointerId === pending.id) pending = null;
      if (!active || event.pointerId !== active.id) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      const turn = active.turn;
      active = null;
      const commit = event.type !== "pointercancel" && turnCommits(turn.direction, turn.corner.x);
      if (!turn.images) {
        // Let go before the pictures were ready: just go, or stay.
        if (commit) land(turn);
        teardown(turn);
        return;
      }
      settle(turn, commit);
    };

    const swallowClick = (event: MouseEvent) => {
      if (turnRef.current) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (turnRef.current || active || event.defaultPrevented || isTypingTarget(event.target)) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const direction: Direction | null =
        event.key === "ArrowRight" || event.key === "PageDown" ? "next"
          : event.key === "ArrowLeft" || event.key === "PageUp" ? "prev"
            : null;
      if (!direction) return;
      const turn = planTurn(direction, true);
      if (!turn) return;
      event.preventDefault();
      turnRef.current = turn;
      settle(turn, true, AUTO_TURN_MS);
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
      window.clearTimeout(prefetchTimer);
      unsubscribeFilm();
      shotsRef.current.clear();
      const turn = turnRef.current;
      if (turn) teardown(turn);
    };
  }, [boardRef, filmScope, hostSelector, turnEnabled]);

  return null;
}
