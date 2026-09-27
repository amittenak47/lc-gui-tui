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

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
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

export function PageTurn({ boardRef, filmScope, hostSelector, lockActive, turnEnabled, spread }: PageTurnProps) {
  const turnRef = useRef<Turn | null>(null);
  const spreadRef = useRef(spread);
  spreadRef.current = spread;

  /* Hold the camera on the page it is on, and follow jumps made elsewhere. */
  useEffect(() => {
    if (!lockActive) {
      boardRef.current?.setPageLock(null);
      return;
    }
    let lockedCount = -1;
    const relock = () => {
      const board = boardRef.current;
      if (!board || turnRef.current) return;
      const view = board.getViewportBounds();
      const frames = board.readingPageFrames();
      if (!view || frames.length === 0) return;
      lockedCount = frames.length;
      board.setPageLock(frames[frameIndexAt(frames, view.y + view.height / 2)]!);
    };
    const unsubscribe = subscribePdfFilmCurrent(filmScope, relock);
    // Layout arrives in batches on a first open; lock again as it grows.
    const poll = window.setInterval(() => {
      const count = boardRef.current?.readingPageFrames().length ?? 0;
      if (count !== lockedCount) relock();
    }, 500);
    return () => {
      unsubscribe();
      window.clearInterval(poll);
      boardRef.current?.setPageLock(null);
    };
  }, [boardRef, filmScope, lockActive]);

  useEffect(() => {
    if (!turnEnabled) return;

    const board = () => boardRef.current;

    const planTurn = (direction: Direction, bottom: boolean): Turn | null => {
      const b = board();
      if (!b) return null;
      const view = b.getViewportBounds();
      const frames = b.readingPageFrames();
      if (!view || frames.length === 0) return null;
      const at = frameIndexAt(frames, view.y + view.height / 2);
      const toIndex = direction === "next" ? at + 1 : at - 1;
      const from = frames[at];
      const to = frames[toIndex];
      if (!from || !to) return null;
      // The visible part of this page, and where it is on screen.
      const top = Math.max(view.y, from.minY);
      const bottomY = Math.min(view.y + view.height, from.maxY);
      if (bottomY - top < 8) return null;
      const scene: Scene = { x: view.x, y: top, width: view.width, height: bottomY - top };
      const tl = b.sceneToClient(scene.x, scene.y);
      const br = b.sceneToClient(scene.x + scene.width, scene.y + scene.height);
      if (!tl || !br) return null;
      const rect = { left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y };
      if (rect.width < 8 || rect.height < 8) return null;
      const layout: TurnLayout =
        !spreadRef.current && from.maxY - from.minY < view.width * 0.9 ? "book" : "sheet";
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
      const scale = dpr * (rect.width / scene.width);
      const toScene = { ...scene, y: to.minY + (scene.y - from.minY) };
      void Promise.all([b.captureSceneFrame(scene, scale), b.captureSceneFrame(toScene, scale)]).then(
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
      b.setPageLock(turn.to);
      b.jumpToPageFrame({ ...turn.to, minY: turn.to.minY + turn.offsetInPage });
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
      const turn = turnRef.current;
      if (turn) teardown(turn);
    };
  }, [boardRef, hostSelector, turnEnabled]);

  return null;
}
