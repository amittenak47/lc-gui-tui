/**
 * Pages reading: hold the view on one page, and turn it like paper.
 *
 * Nothing about the document's layout changes. The pages still sit in one
 * long stack in board scene space, with the ink where it was written; this
 * only narrows how far the camera may scroll (`setPageLock`) and moves it a
 * page at a time. The turn itself is a picture: the page being left and the
 * page being turned to are captured once when the drag starts, and a canvas
 * over the view curls one over the other while the finger moves. When it lets
 * go, past a third of the way the camera lands on the new page and the
 * picture goes; short of that the sheet unravels back and nothing moved.
 *
 * Turning is a finger's (or a mouse's) drag from one of the page's corners,
 * which takes hold of the sheet the moment it touches — the body of the page
 * stays the board's own pan. The stylus always writes; the arrow and Page
 * keys turn too.
 */

import { useEffect, useRef, type RefObject } from "react";

import type { BoardHandle } from "../BoardHandle";
import type { PageFrame } from "../inkPageIndex";
import { peekPdfFilmCurrent, publishPdfReadAhead, publishPdfPreloadPages, peekPdfPreloadPages, subscribePdfFilmCurrent, wakePdfPaintPump } from "../../modes/pdfFilm";
import { waitForPdfTurnPreview } from "./pdfTurnPreview";
import { constrainCorner, cornerForCrease, cornerForGrip, turnCommits, type Point } from "./curl";
import { flatSheet, paintTurn, type TurnLayout } from "./paintTurn";
import { boardResizeDeferred } from "../../util/splitResize";
import { afterBootSettled, isBootSettled } from "../../util/bootSettled";
import { isCameraBusy } from "../../util/cameraBusy";
import { notePageTurn } from "../../util/pageTurnBusy";
import { keepResumePicture } from "../../util/resumePicture";
import { canvasGestureFrame, protectGestureSurface } from "../../util/gestureExclusion";
import { turnCornerAt, turnEdgeAt, turnCornerSize } from "./corners";
import { cssColorLuminance } from "../../util/webPagePaper";
import { scrollHostAtPoint } from "../scrollHost";

/** In Pages reading the side stacks sit this much further up, as a share of their gap from the bottom. */
const CHROME_LIFT = 0.5;
/** A full turn played without a finger (keys), in ms. */
const AUTO_TURN_MS = 460;
/** A released sheet rolls on for at least this long, in ms: long enough to be seen turning… */
const GLIDE_MIN_MS = 240;
/** …and at most this long, however far it has to go. */
const GLIDE_MAX_MS = 520;
/** The pace a released sheet rolls at when the hand gave it none, in px per ms. */
const GLIDE_PX_PER_MS = 1.4;
/**
 * How much of a hand's up-and-down a sheet held by its side follows. Held
 * mid-edge, paper curls from the finger and barely tilts; at full follow a
 * wobble early in a drag swung the fold toward one corner or the other.
 */
const SIDE_TILT = 0.2;
/** A flick this fast (px per ms) or faster rolls the sheet on at full pace… */
const GLIDE_FLICK_PX_PER_MS = 3;
/** …in as little as this: quick, and still seen going over. */
const GLIDE_FLICK_MIN_MS = 120;
/** Steepest start a throw may give the roll, as a multiple of its average pace (3 would overshoot). */
const GLIDE_MAX_LAUNCH = 2.5;
/** A text spread's facing picture is taken again once writing has rested this long. */
const FACING_SETTLE_MS = 1200;
/** Pictures kept for turns: this page and its neighbours — in a spread, three spreads' worth. */
const SHOT_CACHE = 8;
/** How long the view must sit still before the next turn's pictures are taken. */
const PREFETCH_IDLE_MS = 600;
/**
 * And how long the hand must have been off the screen. Pictures are a few
 * hundred ms of the main thread each; taken while the reader was opening
 * the toolbar or a menu just after launch, they were why the first taps of
 * a session answered slowly. A turn does not need them to start.
 */
const PREFETCH_QUIET_MS = 1200;

/** When the reader last touched or typed — see `PREFETCH_QUIET_MS`. */
let lastInputAt = -Infinity;
if (typeof window !== "undefined") {
  const note = () => { lastInputAt = performance.now(); };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel"]) {
    window.addEventListener(type, note, { capture: true, passive: true });
  }
}
const inputQuiet = () => performance.now() - lastInputAt >= PREFETCH_QUIET_MS;
/** How often a still page checks whether its pictures went stale (a sharper paint landed). */
const PREFETCH_RECHECK_MS = 1500;
/** Thrown back toward where it started faster than this, the sheet settles back: px per ms. */
const FLICK_PX_PER_MS = 0.45;
/**
 * A release this soon after the last movement is a throw; later, the hand
 * had stopped. A hand that stops to let go pauses well past this; a busy
 * frame can hold a flick's lift back nearly 100 ms.
 */
const FLICK_FRESH_MS = 100;
/** A throw carries the crease on for this long at the speed it left the hand. */
const THROW_MS = 120;
/** After landing, how soon the next page's pictures are taken: the camera's jump first. */
const LANDED_PREFETCH_MS = 90;
/** A sheet caught while going over, pushed on its way this far (px): put it down and turn the next. */
const FLICK_ON_PX = 12;
/** A turn this soon after the last landing is flicking through: no new pictures, see `flicking`. */
const FLICK_THROUGH_MS = 800;
/** How long a turn waits for the next page's picture before turning over plain paper. */
const TO_PICTURE_GRACE_MS = 80;
/** Let go before the pictures were taken: how long to wait for them before simply going. */
const PICTURE_WAIT_MS = 1200;
/**
 * A flick commits on its pace alone: let go at least this fast (px per ms)
 * along the turn, having carried the sheet at least `FLICK_COMMIT_MIN_PX`.
 * A short quick flick used to fall short of the distance a slow drag needs
 * and settle back, so a hand flicking through had to try twice.
 */
const FLICK_COMMIT_PX_PER_MS = 0.5;
const FLICK_COMMIT_MIN_PX = 24;
/** The hand's pace at release is measured over about this long. */
const RELEASE_SPEED_MS = 60;
/**
 * A swipe from the body of the page, not its edge, turns it when it is
 * plainly a flick: this far sideways (px)…
 */
const BODY_FLICK_PX = 28;
/** …at least this fast on average (px per ms)… */
const BODY_FLICK_PX_PER_MS = 0.35;
/** …within this long of touching down… */
const BODY_FLICK_WINDOW_MS = 280;
/** …and mostly sideways: at least this many times its rise or fall. */
const BODY_FLICK_SLOPE = 1.8;
/** Turns queued while a preview loads play at this pace. */
const QUICK_TURN_MS = 240;
/** Most turns a held or hammered key may queue ahead. */
const KEY_QUEUE_MAX = 12;

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

/**
 * How far along a roll is at time `t` (both 0 to 1), leaving at `launch`
 * times its average pace and coming to rest at the end.
 *
 * The cubic with those two slopes: a thrown sheet carries on at the hand's
 * speed and slows into place; one let go from a stop (`launch` 0) eases away
 * from rest and into place, with nothing sudden at either end.
 */
export function glide(t: number, launch: number): number {
  const a = Math.min(3, Math.max(0, launch));
  return a * t + (3 - 2 * a) * t * t + (a - 2) * t * t * t;
}

/**
 * What a PDF page's picture was taken from: the size its bitmap is painted
 * at now. A picture taken while the page was still a preview goes stale the
 * moment the sharp paint lands, and is taken again.
 */
/**
 * How long a sheet let go by a hand rolls for, `px` from where it is going,
 * its corner last moving at `cornerSpeed` px per ms.
 *
 * A hand that had stopped lets it ease away at an unhurried pace. The faster
 * the flick, the more of the hand's pace the sheet keeps, and the shorter the
 * least it may take: a flick through the pages sends each one over quickly.
 */
export function rollMs(px: number, cornerSpeed: number): number {
  const flick = Math.min(1, Math.max(0, (cornerSpeed - GLIDE_PX_PER_MS) / (GLIDE_FLICK_PX_PER_MS - GLIDE_PX_PER_MS)));
  const least = GLIDE_MIN_MS - (GLIDE_MIN_MS - GLIDE_FLICK_MIN_MS) * flick;
  const pace = Math.max(GLIDE_PX_PER_MS, cornerSpeed * (0.6 + 0.6 * flick));
  return Math.min(GLIDE_MAX_MS, Math.max(least, px / pace));
}

/** Taken by its side strip rather than peeled from a corner. */
function heldBySide(turn: { restY: number; rect: { height: number } }): boolean {
  return turn.restY > 0 && turn.restY < turn.rect.height;
}

/** Where a sheet in `rect` is held: its corner, or the finger's height when taken by the side. */
function heldAt(rect: { top: number; height: number }, bottom: boolean, edgeClientY?: number): number {
  if (edgeClientY == null) return bottom ? rect.height : 0;
  return Math.min(rect.height, Math.max(0, edgeClientY - rect.top));
}

function pdfPaintSignature(hostSelector: string, pageId: number): string {
  if (!(pageId >= 1)) return "";
  const host = document.querySelector(hostSelector);
  const canvases = host?.querySelectorAll<HTMLCanvasElement>(`[data-pdf-page="${pageId}"] canvas.lc-pdf-canvas`);
  return canvases ? Array.from(canvases, (c) => c.width).join(",") : "";
}

/**
 * Whether a PDF page has pixels to turn to: a bitmap painted, however blurry
 * its preview. One that has none would turn over as blank paper — black in
 * a dark theme — so a hand flicking on past the painted pages waits there.
 */
function pdfPagePainted(hostSelector: string, pageId: number): boolean {
  if (!(pageId >= 1)) return false;
  const host = document.querySelector(hostSelector);
  const canvases = host?.querySelectorAll<HTMLCanvasElement>(`[data-pdf-page="${pageId}"][data-painted] canvas.lc-pdf-canvas`);
  return Boolean(canvases && Array.from(canvases).some((c) => c.width > 8 && c.height > 8));
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
  onlyIfTaken = false,
  /** A PDF's quick picture, `captureSceneQuick`: kept apart from the full one. */
  quick = false,
): Promise<HTMLCanvasElement | null> {
  const key = [scene.x, scene.y, scene.width, scene.height, scale, b.getInkRevision(), Math.min(cutY, 1e9)]
    .map((n) => Math.round(n * 100) / 100)
    .join(":") + `@${signature}#${paletteSignature()}${quick ? "~quick" : ""}`;
  let taken = shots.get(key);
  if (!taken && onlyIfTaken) return Promise.resolve(null);
  if (!taken) {
    // Below a text page's cut is the next page's text, which the view
    // hides; the picture has to hide it too.
    taken = (quick ? b.captureSceneQuick(scene, scale) : b.captureSceneFrame(scene, scale)).then((canvas) => {
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

/** Plain paper the size of `like`: the page underneath until its picture arrives. */
function blankSheet(like: { width: number; height: number }): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = like.width;
  canvas.height = like.height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = paperColor();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/**
 * The palette a picture was taken in. Switching palettes repaints the page
 * but not a picture of it, so a turn after the switch showed the old colours
 * under a flap already in the new ones.
 */
function paletteSignature(): string {
  if (typeof document === "undefined") return "";
  return [document.documentElement.dataset.theme ?? "", themeToken("--bg"), themeToken("--ink")].join(",");
}

function paperColor(): string {
  if (typeof document === "undefined") return "#ffffff";
  return themeToken("--bg") || "#ffffff";
}

/**
 * A palette colour as the theme set it on the root (`applyAppTheme`).
 * getComputedStyle restyles the whole document first, text layers and all:
 * 130–250 ms on the tablet, on every frame of every turn.
 */
function themeToken(name: string): string {
  const root = document.documentElement;
  return root.style.getPropertyValue(name).trim() || getComputedStyle(root).getPropertyValue(name).trim();
}

export function turnPaperColor(paper: string, pdf: boolean): string {
  return pdf && (cssColorLuminance(paper) ?? 1) < 0.5 ? "#ffffff" : paper;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

/** A turn in flight: what is being turned, and the picture of it. */
/** The softened copy is this share of the picture's size: small is cheap, and scaling it back up softens it further. */
const SOFT_SCALE = 1 / 5;
/** Its blur, in the small copy's own pixels. */
const SOFT_RADIUS_PX = 2;
const softened = new WeakMap<HTMLCanvasElement, HTMLCanvasElement | null>();

/**
 * A softened copy of a page picture, for the page coming into view on a turn
 * (`TurnFrame.toBlur`). Made once per picture: a turn's pictures are never
 * redrawn in place, a sharper one replaces them, and gets its own.
 */
function softenedPicture(picture: HTMLCanvasElement | null): HTMLCanvasElement | null {
  if (!picture || !(picture.width > 1) || !(picture.height > 1)) return null;
  const known = softened.get(picture);
  if (known !== undefined) return known;
  const copy = document.createElement("canvas");
  copy.width = Math.max(1, Math.round(picture.width * SOFT_SCALE));
  copy.height = Math.max(1, Math.round(picture.height * SOFT_SCALE));
  const ctx = copy.getContext("2d");
  if (!ctx) {
    softened.set(picture, null);
    return null;
  }
  ctx.filter = `blur(${SOFT_RADIUS_PX}px)`;
  ctx.drawImage(picture, 0, 0, copy.width, copy.height);
  softened.set(picture, copy);
  return copy;
}

interface Turn {
  direction: Direction;
  layout: TurnLayout;
  bottom: boolean;
  /**
   * Where on its free edge the sheet is held, from the top of `rect`: a
   * corner (0 or the height) for a corner peel or a key, and the finger's
   * height when it was taken by the side, so the fold starts there.
   */
  restY: number;
  from: PageFrame;
  to: PageFrame;
  /** Where the view sits relative to the page top, kept across the turn. */
  offsetInPage: number;
  /** View-space (CSS px) rectangle the overlay covers. */
  rect: { left: number; top: number; width: number; height: number };
  /** The part of the page being left that is pictured, in scene units — single pages only. */
  scene: Scene | null;
  /** Decided on release: over, or back. Null while a hand holds it. */
  commit: boolean | null;
  /** The hand holds the crease, not the corner — see `cornerForCrease`. */
  byFold: boolean;
  canvas: HTMLCanvasElement;
  /** Null on one side of a single sheet: that page is the live one under the canvas. */
  images: { from: HTMLCanvasElement | null; to: HTMLCanvasElement | null } | null;
  /** The page being turned to as live HTML under the canvas, when it had no picture — see `liveUnder`. */
  under: HTMLElement | null;
  /** A retained live copy belongs to the moving sheet, rather than its backdrop. */
  underSheet: boolean;
  /** Settles true once both pictures are in, false if they cannot be had. */
  ready: Promise<boolean>;
  corner: Point;
  /** The settle playing now, if any. */
  anim: {
    began: number;
    ms: number;
    start: Point;
    goal: Point;
    commit: boolean;
    /** How steeply the roll starts — see {@link glide}. */
    launch: number;
    /** How high the corner rises off the page mid-roll, in CSS px. */
    lift: number;
  } | null;
  frame: number;
  done: boolean;
  landed: boolean;
  detached: boolean;
  sheetOnly: boolean;
  abort: AbortController;
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
  /**
   * The zoom a page rests at once landed or held, taken at the first prefetch
   * after. Pictures are for turning from there; zoomed away (a pinch) they
   * would be stale the moment the hand moves again, and taking them is what
   * made a following pinch stall.
   */
  const restZoomRef = useRef<number | null>(null);
  /** Pictures of pages taken ahead of a turn, keyed by what they show. */
  const shotsRef = useRef(new Map<string, Promise<HTMLCanvasElement | null>>());
  useEffect(() => () => shotsRef.current.clear(), []);

  // Lift the side stacks — the menu toolbar, the mode toggle and their
  // checkers — clear of the sheet's bottom corners, where a thumb turns
  // pages, even while annotation is on. The centred pen dock stays put.
  useEffect(() => {
    if (!lockActive) return;
    const host = document.querySelector<HTMLElement>(hostSelector);
    if (!host) return;
    host.dataset.readingPages = "";
    // A focused board paints its chrome into the app's shared slot, outside
    // this host; an embedded one keeps it inside.
    const slot = document.querySelector<HTMLElement>(".lc-board-chrome-slot");
    const findControls = () =>
      host.querySelector<HTMLElement>(".lc-map-controls") ??
      slot?.querySelector<HTMLElement>(".lc-map-controls") ??
      null;
    let controls: HTMLElement | null = null;
    let frame = 0;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    const position = () => {
      frame = 0;
      const found = findControls();
      if (found !== controls) {
        controls?.style.removeProperty("--lc-page-corner-clearance");
        if (controls) resize?.unobserve(controls);
        controls = found;
        if (controls) resize?.observe(controls);
      }
      if (!controls) return;
      // Half as high again as the stacks' own gap above the screen's foot.
      const base = controls.getBoundingClientRect().bottom;
      const lift = Math.max(0, window.innerHeight - base) * CHROME_LIFT;
      controls.style.setProperty("--lc-page-corner-clearance", `${Math.ceil(lift)}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
    resize?.observe(host);
    // The chrome mounts, remounts and moves between slots on its own schedule.
    const mounts = new MutationObserver(schedule);
    if (slot) mounts.observe(slot, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    position();
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mounts.disconnect();
      window.removeEventListener("resize", schedule);
      controls?.style.removeProperty("--lc-page-corner-clearance");
      delete host.dataset.readingPages;
    };
  }, [hostSelector, lockActive]);

  // Register before the touch starts: claiming a small band on pointerdown
  // is too late once Android has already claimed an edge swipe as Back.
  useEffect(() => {
    if (!lockActive) return;
    const host = document.querySelector<HTMLElement>(hostSelector);
    const surface = host?.querySelector<HTMLElement>(".lc-board") ?? host;
    if (surface) return protectGestureSurface(surface, () => canvasGestureFrame(surface.getBoundingClientRect()));
  }, [hostSelector, lockActive]);

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
      restZoomRef.current = null;
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
      // Mid-pinch every read of the page frames is a fresh layout of the
      // document; the hold is checked again once the camera rests.
      if (!board || turnRef.current || boardResizeDeferred() || isCameraBusy()) return;
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
        if (turnEdgeAt(hole, event.clientX, event.clientY)) return;
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
    const shot = (b: BoardHandle, scene: Scene, scale: number, cutY = Infinity, pageId = 0, onlyIfTaken = pagedRef.current) => {
      const signature = pagedRef.current ? pdfPaintSignature(hostSelector, pageId) : "";
      const taken = takeShot(shotsRef.current, b, scene, scale, cutY, signature, onlyIfTaken);
      if (!onlyIfTaken || !pagedRef.current) return taken;
      // A PDF page is a bitmap already: copying it is a few ms, so a page
      // flicked to always has a picture, however blurry its paint still is.
      return taken.then((full) => full ?? (disposed ? null : takeShot(shotsRef.current, b, scene, scale, cutY, signature, false, true)));
    };

    /*
     * Flicking through: a turn taken soon after the last one landed.
     *
     * Each new picture is a few hundred milliseconds of the main thread, and a
     * hand going page after page asks for one per page; taken then, they held
     * every frame and touch behind them and whole turns went by undrawn. While
     * flicking, turns use only pictures already taken (the page being left
     * shows live, the page underneath is paper), and taking more waits until
     * the hand rests.
     */
    let lastLandAt = -Infinity;
    const flicking = () => performance.now() - lastLandAt < FLICK_THROUGH_MS;
    const liveTurns = new Set<Turn>();
    const layers = new Set<Turn>();

    const requestPreview = (pageId: number) => {
      notePageTurn(filmScope);
      publishPdfPreloadPages(filmScope, [...new Set([pageId, ...peekPdfPreloadPages(filmScope)])].slice(0, KEY_QUEUE_MAX));
      wakePdfPaintPump(filmScope);
    };

    // Keep the fold inside its board's stacking context. A body-level overlay
    // can cover inline PDF controls even though shared/portalled controls win.
    const mountTurnCanvas = (turn: Turn) => {
      const pane = document.querySelector<HTMLElement>(hostSelector);
      if (!pane) return;
      const surface = pane.querySelector<HTMLElement>(".lc-board") ?? pane;
      const origin = surface.getBoundingClientRect();
      const left = `${turn.rect.left - origin.left + surface.scrollLeft - surface.clientLeft}px`;
      const top = `${turn.rect.top - origin.top + surface.scrollTop - surface.clientTop}px`;
      for (const layer of turn.under ? [turn.under, turn.canvas] : [turn.canvas]) {
        layer.style.left = left;
        layer.style.top = top;
        // Forward sheets peel above the next one; returning sheets arrive
        // on top, leaving the earlier return visible as their backdrop.
        const above = turn.direction === "next"
          ? [...liveTurns].reverse().find(other => other !== turn && other.detached && other.canvas.parentNode === surface)
          : undefined;
        if (layer === turn.under) layer.style.zIndex = "45";
        surface.insertBefore(layer, above?.under?.parentNode === surface ? above.under : above?.canvas ?? null);
      }
    };

    /*
     * The page being turned to, as live HTML under the canvas, when it has no
     * picture yet. A text page's picture is most of a second of a tablet's
     * main thread, and a hand flicking through outruns it: without one the
     * page underneath turned over blank. A copy of the page's own HTML is a
     * few milliseconds and shows its text at once; the canvas leaves clear the
     * part of the turn where that page shows. Its ink follows a moment later.
     */
    const liveUnder = (b: BoardHandle, turn: Turn, scene: Scene, scale: number, page: PageFrame): HTMLElement | null => {
      const pane = document.querySelector<HTMLElement>(hostSelector);
      const surface = pane?.querySelector<HTMLElement>(".lc-board") ?? pane;
      if (!surface || !(scene.width > 0)) return null;
      const copy = b.livePageCopy(scene, surface);
      if (!copy) return null;
      const k = turn.rect.width / scene.width;
      const paper = turnPaperColor(paperColor(), false);
      const under = document.createElement("div");
      under.className = "lc-page-turn-under";
      under.setAttribute("aria-hidden", "true");
      Object.assign(under.style, {
        width: `${turn.rect.width}px`,
        height: `${turn.rect.height}px`,
        background: paper,
        clipPath: "inset(100%)",
      });
      copy.style.transformOrigin = "0 0";
      copy.style.transform = `scale(${k})`;
      under.appendChild(copy);
      // A text page cut short is blank paper below its cut.
      const cut = (page.maxY - scene.y) * k;
      const blank = cut < turn.rect.height ? document.createElement("div") : null;
      if (blank) {
        Object.assign(blank.style, { position: "absolute", left: "0", right: "0", top: `${Math.max(0, cut)}px`, bottom: "0", background: paper });
        under.appendChild(blank);
      }
      void b.captureSceneMarks(scene, scale).then((marks) => {
        if (!marks || turn.done) return;
        Object.assign(marks.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%" });
        under.insertBefore(marks, blank);
      }, () => {});
      return under;
    };

    /** Show the live page underneath only where that page shows: uncovered going on, laid down coming back. */
    const clipUnder = (turn: Turn) => {
      if (!turn.under) return;
      const { width: W, height: H } = turn.rect;
      const flat = flatSheet({ layout: turn.layout, width: W, height: H, corner: turn.corner, bottom: turn.bottom, restY: turn.restY });
      const sheet = flat.length >= 3
        ? `M${flat.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("L")}Z`
        : "";
      if (turn.direction === "next" && !turn.underSheet) {
        turn.under.style.clipPath = sheet ? `path(evenodd, "M0 0H${W}V${H}H0Z${sheet}")` : "none";
      } else {
        turn.under.style.clipPath = sheet ? `path("${sheet}")` : "inset(100%)";
      }
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
    let disposed = false;
    let prefetching = false;
    /** The way the last turn went: its side is taken first, two pages deep. */
    let heading: Direction = "next";
    /**
     * `delay` short after a landing: then only the page ahead is taken, since
     * each picture holds the main thread and a hand flicking through is
     * already on its way back. The rest follow once the view has rested.
     */
    const prefetch = (delay = PREFETCH_IDLE_MS) => {
      const quick = delay < PREFETCH_IDLE_MS;
      window.clearTimeout(prefetchTimer);
      prefetchTimer = window.setTimeout(() => {
        // Each picture holds the main thread, and the launch is still opening
        // the page: pictures wait for it, and a turn before then takes its own.
        if (!isBootSettled()) {
          void afterBootSettled().then(() => { if (!disposed) prefetch(); });
          return;
        }
        /*
         * Each picture is a few hundred milliseconds of the main thread — the
         * page cloned, its styles inlined, serialized — and a zoom makes every
         * one stale. Taken while a hand is still pinching or panning, they were
         * the frames a pinch dropped. Wait for the camera to rest.
         */
        // A landing moves the camera too: the quick picture after one is the
        // page the hand is coming back for, so it does not wait for that.
        if ((isCameraBusy() || !inputQuiet()) && !quick) {
          prefetch(delay);
          return;
        }
        const b = board();
        if (!b || disposed || prefetching || turnRef.current || boardResizeDeferred()) return;
        const view = b.getViewportBounds();
        if (!view) return;
        // Zoomed away from where the page rests: a turn from here takes its own.
        const zoom = view.zoom ?? 1;
        const rest = restZoomRef.current ?? (restZoomRef.current = zoom);
        if (Math.abs(zoom / rest - 1) > 0.02) return;
        const frames = b.readingPageFrames();
        if (frames.length === 0) return;
        const at = currentIndex(frames, lockedRef.current, view);
        const from = frames[at]!;
        const current = () => !disposed && !turnRef.current && !boardResizeDeferred() && (quick || (!isCameraBusy() && inputQuiet())) &&
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
            const here = await shot(b, scene, scale, from.maxY, from.pageId);
            // The page as it rests, for this tab to show at once if it is
            // reopened — see `resumePicture`.
            const tab = document.querySelector<HTMLElement>(hostSelector)?.getBoundingClientRect();
            if (here && tab && tab.width > 0 && current()) {
              keepResumePicture(filmScope, {
                canvas: here,
                left: tl.x - tab.left,
                top: tl.y - tab.top,
                width: br.x - tl.x,
                height: br.y - tl.y,
                tabWidth: tab.width,
                tabHeight: tab.height,
                paper: turnPaperColor(paperColor(), pagedRef.current),
              });
            }
            // Pages flicked through quickly: the next turn's picture, and the
            // one after it, are ready before the hand comes back for them.
            const ahead = heading === "next" ? 1 : -1;
            const neighbours = quick ? [frames[at + ahead]] : [frames[at + ahead], frames[at - ahead], frames[at + 2 * ahead]];
            for (const neighbour of neighbours) {
              if (!current()) return;
              if (!neighbour) continue;
              await shot(b, { ...scene, y: neighbour.minY + (scene.y - from.minY) }, scale, neighbour.maxY, neighbour.pageId);
            }
          } finally {
            prefetching = false;
            if (quick && !disposed) prefetch();
          }
        })();
      }, delay);
    };
    const unsubscribeFilm = subscribePdfFilmCurrent(filmScope, () => prefetch());
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
      edgeClientY?: number,
    ): Turn | null => {
      const start = at - (at % 2);
      const toStart = direction === "next" ? start + 2 : start - 2;
      const from = frames[start];
      const to = frames[toStart];
      // Nothing painted to turn to yet: hold here rather than turn over blank paper.
      if (to && pagedRef.current && !pdfPagePainted(hostSelector, to.pageId)) requestPreview(to.pageId);
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
      const restY = heldAt(rect, bottom, edgeClientY);
      const turn: Turn = {
        direction,
        layout: "book",
        bottom,
        restY,
        from,
        to,
        offsetInPage: 0,
        rect,
        scene: null,
        commit: null,
        byFold: false,
        canvas,
        images: null,
        under: null,
        underSheet: false,
        corner: { x: direction === "next" ? w : -w, y: restY },
        anim: null,
        ready: Promise.resolve(false),
        frame: 0,
        done: false,
        landed: false,
        detached: false,
        sheetOnly: direction === "prev" && [...liveTurns].some(other => other.detached && other.direction === "prev"),
        abort: new AbortController(),
      };
      liveTurns.add(turn);
      layers.add(turn);
      const spreadShot = (s: number) =>
        Promise.all([pageShot(s), pageShot(s + 1)]).then(([left, right]) => composeSpread(left, right));
      turn.ready = Promise.all([spreadShot(start), spreadShot(toStart)]).then(
        ([here, there]) => {
          if (disposed || turn.done || !here || !there) return false;
          turn.images = direction === "next" ? { from: here, to: there } : { from: there, to: here };
          mountTurnCanvas(turn);
          draw(turn);
          return true;
        },
        () => false,
      );
      return turn;
    };

    /**
     * Plan a turn from the page in view — or, `after` a turn that has just
     * landed, from the page it landed on. That page is where the old picture
     * was, on the same spot of the screen, even before the camera's jump has
     * reached the board's reported view.
     */
    const planTurn = (direction: Direction, bottom: boolean, after?: Turn, edgeClientY?: number): Turn | null => {
      const b = board();
      if (!b) return null;
      const view = b.getViewportBounds();
      const frames = b.readingPageFrames();
      if (!view || frames.length === 0) return null;
      const landed = after ? frames.findIndex((f) => Math.abs(f.minY - after.to.minY) < 0.5) : -1;
      const at = landed >= 0 ? landed : currentIndex(frames, lockedRef.current, view);
      if (textSpreadRef.current) return planSpreadTurn(b, frames, at, direction, bottom, edgeClientY);
      const toIndex = direction === "next" ? at + 1 : at - 1;
      const from = frames[at];
      const to = frames[toIndex];
      if (!from || !to) return null;
      // Nothing painted to turn to yet: hold here rather than turn over blank paper.
      if (pagedRef.current && !pdfPagePainted(hostSelector, to.pageId)) requestPreview(to.pageId);
      // The visible part of this page — the page, not the view around it —
      // and where it is on screen.
      let scene: Scene | null;
      let rect: Turn["rect"];
      if (landed >= 0 && after?.scene) {
        scene = { ...after.scene, y: from.minY + (after.scene.y - after.from.minY) };
        rect = { ...after.rect };
      } else {
        scene = pageScene(b, frames, at);
        if (!scene) return null;
        const tl = b.sceneToClient(scene.x, scene.y);
        const br = b.sceneToClient(scene.x + scene.width, scene.y + scene.height);
        if (!tl || !br) return null;
        rect = { left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y };
      }
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
      const restY = heldAt(rect, bottom, edgeClientY);
      const turn: Turn = {
        direction,
        layout,
        bottom,
        restY,
        from,
        to,
        // With the page fitted the view starts above it; land on the top.
        offsetInPage: after && landed >= 0 ? after.offsetInPage : Math.max(0, view.y - from.minY),
        rect,
        scene,
        commit: null,
        // One sheet coming back starts off the page, over the binding: the
        // hand can only hold its crease. Everything else, its corner.
        byFold: layout === "sheet" && direction === "prev",
        canvas,
        images: null,
        under: null,
        underSheet: false,
        corner: { x: direction === "next" ? w : -w, y: restY },
        anim: null,
        ready: Promise.resolve(false),
        frame: 0,
        done: false,
        landed: false,
        detached: false,
        sheetOnly: direction === "prev" && [...liveTurns].some(other => other.detached && other.direction === "prev"),
        abort: new AbortController(),
      };
      liveTurns.add(turn);
      layers.add(turn);
      // Capture both pages at the size they are drawn. The page being turned to
      // is taken at the same place within it the view shows of this one.
      const scale = shotScale(rect.width, scene.width);
      const toScene = { ...scene, y: to.minY + (scene.y - from.minY) };
      // PDFs already have pixels: never clone/style the document on input.
      const fast = pagedRef.current || flicking();
      const hereShot = shot(b, scene, scale, from.maxY, from.pageId, fast);
      const thereShot = pagedRef.current
        ? waitForPdfTurnPreview(document.querySelector(hostSelector), to.pageId, turn.abort.signal)
          .then(ready => ready && !disposed && !turn.done ? shot(b, toScene, scale, to.maxY, to.pageId, fast) : null)
        : shot(b, toScene, scale, to.maxY, to.pageId, fast);
      // Turning back is turning forward from the previous page, reversed.
      const place = (here: HTMLCanvasElement | null, there: HTMLCanvasElement | null) => {
        turn.images = direction === "next" ? { from: here, to: there } : { from: there, to: here };
      };
      /*
       * The page being left is almost always pictured already: it was the
       * last turn's destination. The page being turned to may not be — a hand
       * flicking through outruns taking it (a few hundred ms of the main
       * thread a page), and a turn that waited for it played no animation at
       * all. So it turns at once over plain paper, and the page appears on
       * that paper the moment its picture lands, even mid-turn.
       */
      // The page this turn leaves is the one the last turn landed on, and that
      // turn already held a picture of it (real, or paper still filling in).
      const landedPicture = landed >= 0 && after?.images
        ? (after.direction === "next" ? after.images.to : after.images.from)
        : null;
      turn.ready = (async () => {
        // The caller makes this the current turn after planning returns.
        await Promise.resolve();
        const grace = () => new Promise<null>((resolve) => window.setTimeout(() => resolve(null), TO_PICTURE_GRACE_MS));
        /*
         * The page being left is the live page under the canvas: a single
         * sheet can turn without a picture of it, the page showing through
         * where it still lies. Hands flicking faster than pages can be
         * pictured get every turn, not every other one.
         */
        let here = landedPicture ?? (await Promise.race([hereShot, grace()]));
        if (!here && layout === "book") here = await hereShot;
        if (disposed || turn.done || (!here && layout === "book")) return false;
        // Hold on this page until the requested preview exists. The gesture
        // remains registered; sharp rendering is not required to turn it.
        let there = pagedRef.current ? await thereShot : await Promise.race([thereShot, grace()]);
        if (disposed || turn.done || (pagedRef.current && !there)) return false;
        // No picture of a text page in time: the page itself, live.
        if (!there && !pagedRef.current && layout === "sheet") turn.under = liveUnder(b, turn, toScene, scale, to);
        const blank = there || turn.under
          ? null
          : blankSheet(here ?? { width: Math.max(1, Math.round(scene.width * scale)), height: Math.max(1, Math.round(scene.height * scale)) });
        place(here, there ?? blank);
        // Whichever picture arrives late takes its place, even mid-turn.
        const arrive = (which: "here" | "there") => (picture: HTMLCanvasElement | null) => {
          if (!picture || disposed || turn.done || turn.detached) return;
          if (which === "here") {
            if (picture === here) return;
            here = picture;
          } else {
            if (picture === there) return;
            there = picture;
          }
          place(here, there ?? blank);
          draw(turn);
        };
        void hereShot.then(arrive("here"));
        // The live page is the page itself: nothing to swap in.
        if (!there && !turn.under) void thereShot.then(arrive("there"));
        mountTurnCanvas(turn);
        draw(turn);
        return true;
      })().catch(() => false);
      return turn;
    };

    /** Paint the sheet where its corner is now. */
    const paint = (turn: Turn) => {
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
        sourceWidth: (turn.images.from ?? turn.images.to)?.width ?? 1,
        sourceHeight: (turn.images.from ?? turn.images.to)?.height ?? 1,
        corner: turn.corner,
        bottom: turn.bottom,
        restY: turn.restY,
        paper: turnPaperColor(paperColor(), pagedRef.current),
        sheetOnly: turn.sheetOnly,
        toBlur: softenedPicture(turn.images.to),
      });
      clipUnder(turn);
    };

    /** Paint on the next frame — for a hand, whose moves come between frames. */
    const draw = (turn: Turn) => {
      if (!turn.images || turn.frame) return;
      turn.frame = requestAnimationFrame(() => {
        turn.frame = 0;
        paint(turn);
      });
    };

    const teardown = (turn: Turn) => {
      if (turn.done) return;
      turn.done = true;
      turn.abort.abort();
      liveTurns.delete(turn);
      if (turnRef.current === turn) {
        turnRef.current = null;
      }
      if (!turnRef.current) setTurning(false);
      if (turn.frame) cancelAnimationFrame(turn.frame);
      // Two frames: the camera's jump has to reach the screen before the
      // picture of where it was going stops covering it.
      const removeLayers = () => {
        // A newer returning sheet can finish before the older one below it.
        // Keep its resting picture above that sheet until the latter lands.
        if (!disposed && turn.direction === "prev" && [...liveTurns].some(other => other.detached && other.direction === "prev")) {
          requestAnimationFrame(removeLayers);
          return;
        }
        turn.canvas.remove();
        turn.under?.remove();
        layers.delete(turn);
      };
      requestAnimationFrame(() => requestAnimationFrame(removeLayers));
    };

    const land = (turn: Turn) => {
      if (turn.landed) return;
      const b = board();
      if (!b) return;
      turn.landed = true;
      notePageTurn(filmScope);
      if (pagedRef.current) publishPdfReadAhead(filmScope, turn.direction === "next" ? 1 : -1);
      lockedRef.current = turn.to;
      restZoomRef.current = null;
      b.setPageLock(turn.to);
      b.jumpToPageFrame({ ...turn.to, minY: turn.to.minY + turn.offsetInPage });
      heading = turn.direction;
      const flipping = flicking();
      lastLandAt = performance.now();
      // Mid-flick, the next picture waits for the hand to rest.
      prefetch(flipping ? PREFETCH_IDLE_MS : LANDED_PREFETCH_MS);
    };

    /** Move navigation on while this sheet finishes its own animation. */
    const continueTurn = (turn: Turn) => {
      if (turn.done) return;
      if (!turn.commit || !turn.images) {
        turn.anim = null;
        teardown(turn);
        return;
      }
      // A text snapshot can still be pending. Retain that page's HTML,
      // clipped to its own sheet, before the camera leaves it.
      if (turn.layout === "sheet" && !turn.images.from) {
        if (turn.direction === "next" && turn.scene) {
          turn.under?.remove();
          const b = board();
          turn.under = b ? liveUnder(b, turn, turn.scene, shotScale(turn.rect.width, turn.scene.width), turn.from) : null;
          if (turn.under && turn.canvas.parentNode) {
            turn.under.style.left = turn.canvas.style.left;
            turn.under.style.top = turn.canvas.style.top;
            turn.under.style.zIndex = "45";
            turn.canvas.before(turn.under);
          }
        }
        turn.underSheet = true;
      } else {
        turn.under?.remove();
        turn.under = null;
      }
      land(turn);
      turn.detached = true;
      if (turn.direction === "next") turn.sheetOnly = true;
      if (turnRef.current === turn) turnRef.current = null;
      if (!turn.anim) settle(turn, true);
      draw(turn);
    };

    /** Turns queued by a key pressed while one was playing. */
    let queued: { direction: Direction; count: number } | null = null;

    /**
     * A sheet in motion, held or rolling: the PDF's sharp paint waits until it
     * has been still a moment (see `pageTurnBusy`). Said at most every 100 ms.
     */
    let turningNotedAt = -Infinity;
    const stillTurning = () => {
      const now = performance.now();
      if (now - turningNotedAt < 100) return;
      turningNotedAt = now;
      notePageTurn(filmScope);
    };

    const step = (turn: Turn, animation = turn.anim) => (now: number) => {
      const a = animation;
      // A caught or reversed sheet invalidates the old animation, including a
      // callback already queued before the new finger went down.
      if (turn.done || !a || turn.anim !== a) return;
      stillTurning();
      const t = Math.min(1, Math.max(0, (now - a.began) / a.ms));
      const k = glide(t, a.launch);
      // The corner rises off the page as it rolls and settles back down onto
      // it, rather than sliding across in a straight line.
      // A corner rises off the page as it rolls; a sheet held mid-side does
      // not lift its middle, so the rise fades toward the middle of the edge.
      const half = turn.rect.height / 2;
      const edge = half > 0 ? Math.min(1, Math.abs(turn.restY - half) / half) : 1;
      const rise = Math.sin(Math.PI * k) * a.lift * edge;
      turn.corner = {
        x: a.start.x + (a.goal.x - a.start.x) * k,
        y: a.start.y + (a.goal.y - a.start.y) * k + (turn.bottom ? -rise : rise),
      };
      // Already inside a frame: paint now, not a frame late.
      if (turn.frame) {
        cancelAnimationFrame(turn.frame);
        turn.frame = 0;
      }
      paint(turn);
      if (t < 1) {
        requestAnimationFrame(step(turn, a));
        return;
      }
      if (a.commit) land(turn);
      teardown(turn);
      if (!turnRef.current) nextQueued(turn);
    };

    /**
     * Play the corner from where it is to fully over, or back to rest.
     *
     * Let go by a hand (`fullMs` unset), the sheet leaves at the speed the
     * hand was moving (`speed`, px/ms), then slows into place — a flick rolls
     * on quickly, a hand that had stopped lets the page ease away from rest.
     * Either way it takes long enough to be seen rolling. Played for a key,
     * it takes `fullMs` for a whole turn. Without pictures yet, it waits a
     * moment for them — a fast turn still shows the page turning.
     */
    const settle = (turn: Turn, commit: boolean, { fullMs, speed = 0 }: { fullMs?: number; speed?: number } = {}) => {
      turn.commit = commit;
      if (!commit && !turn.images && pagedRef.current) {
        queued = null;
        teardown(turn);
        return;
      }
      const run = () => {
        if (turn.done) return;
        const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
        // Finishing means reaching the end the turn is headed for.
        const goal = {
          x: (turn.direction === "next") === commit ? -w : w,
          y: turn.restY,
        };
        const start = { ...turn.corner };
        const px = Math.max(1, Math.hypot(goal.x - start.x, goal.y - start.y));
        let ms: number;
        let launch = 0;
        if (fullMs != null) {
          ms = Math.max(80, fullMs * (Math.abs(goal.x - start.x) / (2 * w)));
        } else {
          // Held by the crease, the corner moves twice as fast as the hand.
          const corner = speed * (turn.byFold ? 2 : 1);
          ms = rollMs(px, corner);
          launch = Math.min(GLIDE_MAX_LAUNCH, (corner * ms) / px);
        }
        const lift = Math.min(turn.rect.height * 0.06, 44) * Math.min(1, Math.abs(goal.x - start.x) / (2 * w));
        turn.anim = { began: performance.now(), ms, start, goal, commit, launch, lift };
        requestAnimationFrame(step(turn));
      };
      if (turn.images) {
        run();
        return;
      }
      let decided = false;
      const giveUp = pagedRef.current ? 0 : window.setTimeout(() => {
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
        if (commit && !pagedRef.current) land(turn);
        if (pagedRef.current) queued = null;
        teardown(turn);
        nextQueued();
      });
    };

    const keyTurn = (direction: Direction, ms: number, after?: Turn): boolean => {
      const turn = planTurn(direction, true, after);
      if (!turn) return false;
      notePageTurn(filmScope);
      turnRef.current = turn;
      settle(turn, true, { fullMs: ms });
      return true;
    };

    const nextQueued = (after?: Turn) => {
      const q = queued;
      if (!q) return;
      // The next frame: the landing camera has to be in place to plan from.
      requestAnimationFrame(() => {
        if (disposed || turnRef.current || active || queued !== q) return;
        q.count -= 1;
        if (q.count <= 0) queued = null;
        const landed = after?.landed && lockedRef.current && Math.abs(lockedRef.current.minY - after.to.minY) < 0.5 ? after : undefined;
        if (!keyTurn(q.direction, QUICK_TURN_MS, landed)) queued = null;
      });
    };

    /* ---------------------------------------------------------- gesture */

    // Side strips and corner triangles own turning. The body keeps scrolling
    // and selection; a stylus always belongs to the ink layer.
    const host = () => document.querySelector<HTMLElement>(hostSelector);
    const holeEl = () => host()?.querySelector<HTMLElement>(".lc-page-mask-hole") ?? null;
    const pageRect = (): DOMRect | null => {
      const hole = holeEl();
      if (!hole || (hole.parentElement as HTMLElement | null)?.hidden) return null;
      if (hole.dataset.turnEdges == null) hole.dataset.turnEdges = "";
      const rect = hole.getBoundingClientRect();
      hole.style.setProperty("--lc-turn-corner", `${turnCornerSize(rect)}px`);
      return rect.width > 8 && rect.height > 8 ? rect : null;
    };
    const edgeAt = (x: number, y: number): "left" | "right" | null => {
      const r = pageRect();
      if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      return turnEdgeAt(r, x, y);
    };
    /*
     * Marks go on the page's hole, never the tab's host: a toggle there
     * restyled the whole document under it, 300-500 ms on a long PDF. A
     * mouse's cursor is set on the host; a finger has none to change.
     */
    let mouse = false;
    const setHover = (edge: "left" | "right" | null) => {
      const hole = holeEl();
      if (hole) {
        if (edge) hole.dataset.turnHover = edge;
        else delete hole.dataset.turnHover;
      }
      const el = host();
      if (el && mouse && !turnRef.current) el.style.cursor = edge ? "grab" : "";
    };
    const setTurning = (on: boolean) => {
      if (on) window.getSelection()?.removeAllRanges();
      const el = host();
      if (el && mouse) el.style.cursor = on ? "grabbing" : "";
    };
    // While a page turns, nothing on it selects.
    const noSelect = (event: Event) => {
      if (turnRef.current || active) event.preventDefault();
    };
    document.addEventListener("selectstart", noSelect, true);
    const edgesHole = holeEl();
    if (edgesHole) edgesHole.dataset.turnEdges = "";

    let active: {
      id: number;
      x: number;
      y: number;
      turn: Turn;
      vx: number;
      lastX: number;
      lastT: number;
      /** Where the hand was last seen, sampled for speed or not. */
      atX: number;
      /** Where the hand has been lately, for its pace at release — see `releaseSpeed`. */
      trail: { x: number; t: number }[];
      /** Where along x the hand first took hold, for how far it carried the sheet. */
      fromX: number;
      caughtCorner?: Point;
      /**
       * Caught while going over. Pushed on its way it is put down and the
       * next page taken; a thumb flicking through lands on the rolling sheet
       * as often as on the strip, and that swipe must not just finish it.
       */
      goingOver?: boolean;
    } | null = null;

    /**
     * Where the sheet's corner is for a hand at this point of the screen.
     *
     * Held by its corner, the corner is under the fingertip — touched in
     * the corner's triangle, it peels to the finger at once, and stays with
     * it. Held by its crease (one sheet coming back), the crease is.
     */
    const cornerAt = (turn: Turn, clientX: number, clientY: number, fromY: number): Point => {
      const book = turn.layout === "book";
      const w = book ? turn.rect.width / 2 : turn.rect.width;
      const x = clientX - turn.rect.left - (book ? w : 0);
      const tilt = heldBySide(turn) ? SIDE_TILT : 1;
      if (turn.byFold) return cornerForCrease(x, (clientY - fromY) * tilt, w, turn.rect.height, turn.bottom, turn.restY);
      if (tilt < 1) return cornerForGrip({ x, y: turn.restY + (clientY - fromY) * tilt }, 0, 0, w, turn.rect.height, turn.bottom, turn.restY);
      return cornerForGrip({ x, y: clientY - turn.rect.top }, 0, 0, w, turn.rect.height, turn.bottom, turn.restY);
    };

    const inHost = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest(hostSelector)) &&
      !target.closest(
        "button, a, input, textarea, select, [role='menu'], [role='dialog'], .lc-board-chrome-slot, .lc-map-controls," +
          " .lc-doc-footnote, .lc-doc-footnote-pack, .lc-footnote-bubble, .lc-doc-select-overlay, .lc-doc-sheet, .lc-doc-confirm",
      );

    /**
     * Take hold of the page at a corner: the turn starts under the finger on
     * touch, before it has moved, so there is no dead distance between a
     * swipe and the page following it. The right corners turn forward and the
     * left ones back, whichever way the hand then goes.
     */
    const grip = (event: PointerEvent, side: "left" | "right", after?: Turn): boolean => {
      const r = pageRect();
      if (!r) return false;
      const direction: Direction = side === "right" ? "next" : "prev";
      const bottom = event.clientY > r.top + r.height / 2;
      // A corner peels from its corner; the side strip is held where it was taken.
      const byCorner = turnCornerAt(r, event.clientX, event.clientY) !== null;
      const turn = planTurn(direction, bottom, after, byCorner ? undefined : event.clientY);
      if (!turn) return false; // first or last page: nothing to turn to
      notePageTurn(filmScope);
      turnRef.current = turn;
      setTurning(true);
      turn.corner = cornerAt(turn, event.clientX, event.clientY, event.clientY);
      active = {
        id: event.pointerId, x: event.clientX, y: event.clientY, turn,
        vx: 0, lastX: event.clientX, lastT: event.timeStamp, atX: event.clientX,
        trail: [{ x: event.clientX, t: event.timeStamp }], fromX: event.clientX,
      };
      draw(turn);
      return true;
    };

    /**
     * The hand's pace when it let go, px per ms: how far it went over about
     * the last `RELEASE_SPEED_MS`. A running average lags behind a quick
     * flick's first moves, and a short flick is nothing but first moves.
     */
    const releaseSpeed = (trail: readonly { x: number; t: number }[]): number => {
      const last = trail[trail.length - 1];
      if (!last) return 0;
      let first = last;
      for (let i = trail.length - 2; i >= 0; i -= 1) {
        first = trail[i]!;
        if (last.t - first.t >= RELEASE_SPEED_MS) break;
      }
      const dt = last.t - first.t;
      return dt > 0 ? (last.x - first.x) / dt : 0;
    };

    /** A stylus turns pages while no drawing tool is up; with one, it writes. */
    const penTurns = () => {
      const tool = board()?.getActiveTool?.();
      return tool === "hand" || tool === "selection";
    };

    /*
     * A flick that starts on the body of the page, not at its edge.
     *
     * The edge strips are where a page is taken hold of; a hand flicking
     * through does not aim for them, and the left one is where Android's own
     * Back swipe lives. A swipe from anywhere on the page that is quick and
     * mostly sideways turns it too: forward going left, back going right.
     * Until it is plainly that, the touch is the page's: scrolling, selecting,
     * a code block's own sideways scroll.
     */
    let pending: { id: number; x: number; y: number; t: number; target: EventTarget | null } | null = null;
    /** True while `startFlick` cancels the page's own handling of a touch it took. */
    let cancelling = false;

    /** Turn the page for a body flick that has just shown itself, from where it started. */
    const startFlick = (event: PointerEvent, start: NonNullable<typeof pending>): boolean => {
      const r = pageRect();
      if (!r) return false;
      // A code block or a wide equation scrolls sideways itself.
      const scroller = scrollHostAtPoint(start.x, start.y);
      if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) return false;
      const direction: Direction = event.clientX < start.x ? "next" : "prev";
      const heldY = Math.min(r.bottom - 1, Math.max(r.top + 1, start.y));
      const turn = planTurn(direction, heldY > r.top + r.height / 2, undefined, heldY);
      if (!turn) return false;
      notePageTurn(filmScope);
      turnRef.current = turn;
      setTurning(true);
      const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
      const rest = { x: direction === "next" ? w : -w, y: turn.restY };
      turn.corner = rest;
      active = {
        id: event.pointerId, x: start.x, y: start.y, turn, caughtCorner: rest,
        vx: 0, lastX: start.x, lastT: start.t, atX: start.x,
        trail: [{ x: start.x, t: start.t }], fromX: start.x,
      };
      // Whatever the page started for this touch (a selection, a press) ends.
      cancelling = true;
      try {
        start.target?.dispatchEvent(new PointerEvent("pointercancel", {
          pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: true, bubbles: true,
        }));
      } finally {
        cancelling = false;
      }
      follow(event);
      return true;
    };

    const onDown = (event: PointerEvent) => {
      // A second finger is a pinch, not a turn: the held sheet goes back.
      if (!event.isPrimary && event.pointerType === "touch") {
        pending = null;
        queued = null;
        active = null;
        // Fixed page-turn overlays must not hide the live pinch beneath
        // them. Keep committed navigation, then hand the surface to zoom.
        for (const turn of layers) {
          if (turn.commit && turn.images) land(turn);
          turn.anim = null;
          teardown(turn);
          turn.canvas.remove();
          turn.under?.remove();
          layers.delete(turn);
        }
        return;
      }
      if (active) return;
      if (event.button !== 0 || !event.isPrimary) return;
      mouse = event.pointerType === "mouse";
      if (event.pointerType === "pen" && !penTurns()) return; // with a pen up, the stylus writes
      if (!inHost(event.target)) return;
      // Zoomed into the page, the hand moves about it; turning waits for the
      // zoom back out to the whole page.
      if (!turnRef.current && boardRef.current?.zoomedIntoPage()) return;
      // Touch and mouse can grip the side strips as well as the corner peels.
      const side = edgeAt(event.clientX, event.clientY);
      const playing = turnRef.current;
      if (playing) {
        const r = playing.rect;
        const catchable = Boolean(playing.anim && playing.images) && !playing.done &&
          event.clientX >= r.left && event.clientX <= r.left + r.width &&
          event.clientY >= r.top && event.clientY <= r.top + r.height;
        if (side && (playing.commit || !catchable)) {
          // The previous sheet keeps its own pictures and finishes above
          // the next one. A pending preview instead queues the next swipe.
          event.stopImmediatePropagation();
          event.preventDefault();
          if (playing.commit && !playing.images) {
            pending = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, target: event.target };
            return;
          }
          if (queued && queued.direction !== (side === "right" ? "next" : "prev")) queued = null;
          const landed = playing.commit ? playing : undefined;
          continueTurn(playing);
          if (grip(event, side, landed) && event.pointerType === "touch") setHover(side);
          return;
        }
        if (!catchable) {
          if (playing.commit && !playing.images && event.pointerType === "touch") {
            pending = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, target: event.target };
          }
          return;
        }
        event.stopImmediatePropagation();
        event.preventDefault();
        const goingOver = playing.anim?.commit === true;
        playing.anim = null;
        playing.commit = null;
        if (!goingOver) queued = null;
        const w = playing.layout === "book" ? r.width / 2 : r.width;
        // Anchor at the displayed fold, so catching it never snaps the page
        // back to its original corner or to the new finger's position.
        playing.corner = constrainCorner(playing.corner, w, r.height, playing.bottom, playing.restY);
        active = {
          id: event.pointerId, x: event.clientX, y: event.clientY,
          turn: playing, caughtCorner: { ...playing.corner }, goingOver,
          vx: 0, lastX: event.clientX, lastT: event.timeStamp, atX: event.clientX,
          trail: [{ x: event.clientX, t: event.timeStamp }], fromX: event.clientX,
        };
        setTurning(true);
        return;
      }
      if (!side) {
        if (event.pointerType !== "mouse") {
          pending = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, target: event.target };
        }
        return;
      }
      if (!grip(event, side)) return;
      // The corner is the turn's: no text selection, no hold, no pan from it.
      event.stopImmediatePropagation();
      event.preventDefault();
      // A finger has no hover: show the edge it pressed.
      if (event.pointerType === "touch") setHover(side);
    };

    /**
     * Move the held corner to where the hand is now. A lift where the last
     * move already was is not movement: it leaves the throw as it stood.
     */
    const follow = (event: PointerEvent, release = false) => {
      if (!active) return;
      stillTurning();
      const dt = event.timeStamp - active.lastT;
      const moved = !(release && event.clientX === active.atX);
      active.atX = event.clientX;
      if (dt > 0 && moved) {
        active.vx = active.vx * 0.5 + ((event.clientX - active.lastX) / dt) * 0.5;
        active.lastX = event.clientX;
        active.lastT = event.timeStamp;
        active.trail.push({ x: event.clientX, t: event.timeStamp });
        if (active.trail.length > 12) active.trail.shift();
      }
      const turn = active.turn;
      const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
      // A caught sheet moves on from where it was caught, at the hand's pace:
      // one to one by its corner, twice that by its crease.
      const pace = turn.byFold ? 2 : 1;
      turn.corner = active.caughtCorner
        ? constrainCorner({
            x: Math.min(w, Math.max(-w, active.caughtCorner.x + pace * (event.clientX - active.x))),
            y: active.caughtCorner.y + (event.clientY - active.y) * (pace === 1 ? 1 : 0.5) * (heldBySide(turn) ? SIDE_TILT : 1),
          }, w, turn.rect.height, turn.bottom, turn.restY)
        : cornerAt(turn, event.clientX, event.clientY, active.y);
      draw(turn);
    };

    /** Land a caught sheet that was going over, and take hold of the next one from rest. */
    const flickOn = (event: PointerEvent, releaseStart?: { x: number; y: number; t: number }) => {
      if (!active) return;
      const { id, turn: caught } = active;
      active = null;
      caught.commit = true;
      continueTurn(caught);
      // Held by the side, the next sheet is taken where the hand is now.
      const bySide = caught.restY > 0 && caught.restY < caught.rect.height;
      const turn = planTurn(caught.direction, caught.bottom, caught, bySide ? event.clientY : undefined);
      if (!turn) return; // landed on the last page
      turnRef.current = turn;
      setTurning(true);
      const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
      const rest = { x: turn.direction === "next" ? w : -w, y: turn.restY };
      turn.corner = rest;
      active = {
        id, x: releaseStart?.x ?? event.clientX, y: releaseStart?.y ?? event.clientY, turn, caughtCorner: rest,
        vx: 0, lastX: releaseStart?.x ?? event.clientX, lastT: releaseStart?.t ?? event.timeStamp, atX: releaseStart?.x ?? event.clientX,
        trail: [{ x: releaseStart?.x ?? event.clientX, t: releaseStart?.t ?? event.timeStamp }], fromX: releaseStart?.x ?? event.clientX,
      };
      draw(turn);
    };

    const onMove = (event: PointerEvent) => {
      if (pending && !active && event.pointerId === pending.id) {
        const start = pending;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const dt = event.timeStamp - start.t;
        if (dt > BODY_FLICK_WINDOW_MS || Math.abs(dy) > BODY_FLICK_PX) {
          pending = null;
        } else if (Math.abs(dx) >= BODY_FLICK_PX && Math.abs(dx) >= BODY_FLICK_SLOPE * Math.abs(dy) &&
          Math.abs(dx) / Math.max(1, dt) >= BODY_FLICK_PX_PER_MS) {
          if (turnRef.current?.commit && !turnRef.current.images) {
            notePageTurn(filmScope);
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
          }
          pending = null;
          if (!turnRef.current && startFlick(event, start)) {
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
          }
        }
      }
      if (active && event.pointerId === active.id) {
        event.stopImmediatePropagation();
        event.preventDefault();
        if (active.goingOver) {
          const dx = event.clientX - active.x;
          const along = active.turn.direction === "next" ? -dx : dx;
          if (along > FLICK_ON_PX) {
            flickOn(event);
            return;
          }
          // Pulled back first: it stays caught, to be turned back or let go.
          if (along < -FLICK_ON_PX) {
            active.goingOver = false;
            queued = null;
          }
        }
        follow(event);
        return;
      }
      if (!active && event.pointerType === "mouse" && event.buttons === 0) {
        mouse = true;
        setHover(boardRef.current?.zoomedIntoPage() ? null : edgeAt(event.clientX, event.clientY));
      }
    };

    const onUp = (event: PointerEvent) => {
      if (cancelling) return;
      if (pending?.id === event.pointerId) {
        const start = pending;
        pending = null;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        const dt = event.timeStamp - start.t;
        if (event.type === "pointerup" && dt <= BODY_FLICK_WINDOW_MS &&
          Math.abs(dx) >= BODY_FLICK_PX && Math.abs(dx) >= BODY_FLICK_SLOPE * Math.abs(dy) &&
          Math.abs(dx) / Math.max(1, dt) >= BODY_FLICK_PX_PER_MS) {
          if (turnRef.current?.commit && !turnRef.current.images) {
            const direction: Direction = dx < 0 ? "next" : "prev";
            notePageTurn(filmScope);
            const count = queued?.direction === direction ? queued.count : 0;
            queued = { direction, count: Math.min(KEY_QUEUE_MAX, count + 1) };
            event.stopImmediatePropagation();
            event.preventDefault();
          } else if (!turnRef.current) startFlick(event, start);
        }
      }
      if (event.pointerType === "touch") setHover(null);
      if (!active || event.pointerId !== active.id) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      // Where the hand let go is where the sheet is. A busy frame can merge a
      // flick's moves away, leaving only the lift to say how far it went.
      if (event.type === "pointerup" && active.goingOver) {
        const along = (event.clientX - active.x) * (active.turn.direction === "next" ? -1 : 1);
        if (along > FLICK_ON_PX) {
          flickOn(event, { x: active.x, y: active.y, t: active.trail[0]!.t });
          if (!active) return;
        }
      }
      if (event.type === "pointerup") follow(event, true);
      const { turn, lastT, trail, fromX } = active;
      active = null;
      // Short of a proper turn the sheet unravels back. A throw counts for a
      // little of where it was going; thrown back, it always goes back. A
      // flick goes over on its pace, however short it was.
      const fresh = event.timeStamp - lastT < FLICK_FRESH_MS;
      const vx = fresh ? releaseSpeed(trail) : 0;
      const sign = turn.direction === "next" ? -1 : 1;
      const along = sign * vx;
      const carried = sign * (event.clientX - fromX);
      const w = turn.layout === "book" ? turn.rect.width / 2 : turn.rect.width;
      const flicked = along >= FLICK_COMMIT_PX_PER_MS && carried >= FLICK_COMMIT_MIN_PX;
      const commit =
        event.type !== "pointercancel" &&
        along > -FLICK_PX_PER_MS &&
        (flicked || turnCommits(turn.direction, turn.corner.x, w, along * THROW_MS, turn.byFold));
      if (!commit) queued = null;
      settle(turn, commit, { speed: Math.abs(vx) });
    };

    const swallowClick = (event: MouseEvent) => {
      if (turnRef.current && inHost(event.target)) {
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
        // Each ready sheet keeps rolling while the next key takes a new one.
        event.preventDefault();
        if (!playing.anim) {
          if (playing.commit) {
            notePageTurn(filmScope);
            const count = queued?.direction === direction ? queued.count : 0;
            queued = { direction, count: Math.min(KEY_QUEUE_MAX, count + 1) };
          }
          return;
        }
        const commit = playing.direction === direction;
        if (playing.anim.commit !== commit) {
          queued = null;
          settle(playing, commit, { fullMs: QUICK_TURN_MS });
          return;
        }
        if (!commit) return;
        continueTurn(playing);
        keyTurn(direction, QUICK_TURN_MS, playing);
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
      document.removeEventListener("selectstart", noSelect, true);
      const hole = holeEl();
      if (hole) {
        delete hole.dataset.turnEdges;
        delete hole.dataset.turnHover;
      }
      const el = host();
      if (el && mouse) el.style.cursor = "";
      unsubscribeFilm();
      queued = null;
      for (const turn of layers) {
        teardown(turn);
        turn.canvas.remove();
        turn.under?.remove();
        layers.delete(turn);
      }
    };
  }, [boardRef, filmScope, hostSelector, turnEnabled]);

  return null;
}
