/**
 * Per-tool ink presets: Global (live keys) plus five named snapshots.
 *
 * Applying a custom wedge writes the live keys the board already reads.
 * It does not rewrite the stored Global snapshot — only Save on slot 0 does.
 */

import {
  ERASER_WIDTH_MAX,
  STROKE_WIDTH_DEFAULT,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
} from "../canvas/rasterInk";
import type { InkSmoothingMode } from "../canvas/inkSmoothing";
import {
  ERASER_PARTIAL_DEFAULT,
  ERASER_PARTIAL_EVENT,
  loadEraserPartial,
  saveEraserPartial,
} from "./eraserPartialPref";
import {
  WHEEL_HOLD_CLEAR_PX,
  WHEEL_HOLD_DRAW_PATH_PX,
  WHEEL_HOLD_SLOP_PX,
  WHEEL_HOLD_STRAIGHTNESS,
  WHEEL_HOLD_WIND_RAD,
  WHEEL_OPEN_MS,
} from "./gesture";
import {
  INK_BOLDNESS_DEFAULT,
  INK_BOLDNESS_EVENT,
  INK_BOLDNESS_MAX,
  INK_BOLDNESS_MIN,
  loadInkBoldness,
  saveInkBoldness,
} from "./inkBoldnessPref";
import {
  PRESSURE_CLIP_DEFAULT,
  loadInkPressureClip,
  saveInkPressureClip,
} from "./inkPressureClip";
import {
  INK_SMOOTHING_DEFAULT,
  INK_SMOOTHING_MODE_DEFAULT,
  loadInkSmoothing,
  loadInkSmoothingMode,
  saveInkSmoothing,
  saveInkSmoothingMode,
} from "./inkSmoothingPref";
import {
  INK_SPEED_BLOT_BLEND_DEFAULT,
  INK_SPEED_BLOT_BLEND_EVENT,
  INK_SPEED_DEFAULT,
  INK_SPEED_FADE_DEFAULT,
  INK_SPEED_BODY_ACCENT_DEFAULT,
  INK_SPEED_BODY_ACCENT_EVENT,
  INK_SPEED_BODY_MAX,
  INK_SPEED_BODY_MIN,
  INK_SPEED_FADE_EVENT,
  loadInkSpeed,
  loadInkSpeedBlotBlend,
  loadInkSpeedFade,
  saveInkSpeed,
  saveInkSpeedBlotBlend,
  loadInkSpeedBodyAccent,
  saveInkSpeedBodyAccent,
  saveInkSpeedFade,
} from "./inkSpeedPref";
import {
  INK_FULLNESS_DEFAULT,
  loadInkToolPrefs,
  saveInkToolPrefs,
  type InkToolPrefs,
} from "./inkToolPrefs";

const KEY = "whiteboard.inkToolPresets.v2";
export const CUSTOM_WEDGE_COUNT = 5;
export const WEDGE_COUNT = 1 + CUSTOM_WEDGE_COUNT;

export type InkPresetKind = "pen" | "highlighter" | "eraser";

export interface InkDrawSnapshot {
  name: string;
  width: number;
  colour: string;
  fullness: number;
  pressureSensitive: boolean;
  straightInk: boolean;
  pressureClip: number;
  smoothing: number;
  smoothingMode: InkSmoothingMode;
  speed: number;
  blot: number;
  fade: number;
  /** Endpoint tuner, bipolar −1…+1. Only bites while Speed ink is on. */
  body: number;
  boldness: number;
}

export interface InkEraserSnapshot {
  name: string;
  eraserWidth: number;
  partialErase: boolean;
}

export type InkWedgeSnapshot = InkDrawSnapshot | InkEraserSnapshot;

export interface InkToolPresetStore {
  wheelLocked: boolean;
  colorWheelOnToolbar: boolean;
  /**
   * Hub tap to apply a new tool+wedge pair.
   *
   * Off applies as soon as the inner wedge is picked (outer tool first; the
   * tool already in hand counts).
   */
  tapOk: boolean;
  lastWedge: Record<InkPresetKind, number>;
  globalDraw: InkDrawSnapshot;
  globalEraser: InkEraserSnapshot;
  custom: Record<InkPresetKind, Array<InkWedgeSnapshot | null>>;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function emptyCustom(): Array<InkWedgeSnapshot | null> {
  return [null, null, null, null, null];
}

export function liveDrawSnapshot(name = "Global"): InkDrawSnapshot {
  const prefs = loadInkToolPrefs();
  return {
    name,
    width: prefs.penWidth,
    colour: prefs.inkColor ?? "#3d3d3d",
    fullness: prefs.inkFullness,
    pressureSensitive: prefs.pressureSensitive,
    straightInk: prefs.straightInk,
    pressureClip: loadInkPressureClip(),
    smoothing: loadInkSmoothing(),
    smoothingMode: loadInkSmoothingMode(),
    speed: loadInkSpeed(),
    blot: loadInkSpeedBlotBlend(),
    fade: loadInkSpeedFade(),
    body: loadInkSpeedBodyAccent(),
    boldness: loadInkBoldness(),
  };
}

/**
 * Stock defaults, ignoring what this device has saved.
 *
 * Reset has to be a way *out* of a preset that cannot draw, so it deliberately
 * does not read device prefs: if the same unusable value had reached them,
 * seeding from them would hand the pen straight back its problem.
 */
export function defaultDrawSnapshot(name = "Preset"): InkDrawSnapshot {
  return {
    name,
    width: STROKE_WIDTH_DEFAULT,
    colour: "#3d3d3d",
    fullness: INK_FULLNESS_DEFAULT,
    pressureSensitive: true,
    straightInk: false,
    pressureClip: PRESSURE_CLIP_DEFAULT,
    smoothing: INK_SMOOTHING_DEFAULT,
    smoothingMode: INK_SMOOTHING_MODE_DEFAULT,
    speed: INK_SPEED_DEFAULT,
    blot: INK_SPEED_BLOT_BLEND_DEFAULT,
    fade: INK_SPEED_FADE_DEFAULT,
    body: INK_SPEED_BODY_ACCENT_DEFAULT,
    boldness: INK_BOLDNESS_DEFAULT,
  };
}

/** Stock eraser, same contract as {@link defaultDrawSnapshot}. */
export function defaultEraserSnapshot(name = "Preset"): InkEraserSnapshot {
  return { name, eraserWidth: STROKE_WIDTH_DEFAULT, partialErase: true };
}

export function liveEraserSnapshot(name = "Global"): InkEraserSnapshot {
  const prefs = loadInkToolPrefs();
  return {
    name,
    eraserWidth: prefs.eraserWidth,
    partialErase: loadEraserPartial(),
  };
}

function defaultStore(): InkToolPresetStore {
  return {
    wheelLocked: true,
    colorWheelOnToolbar: false,
    tapOk: true,
    lastWedge: { pen: 0, highlighter: 0, eraser: 0 },
    globalDraw: liveDrawSnapshot(),
    globalEraser: liveEraserSnapshot(),
    custom: {
      pen: emptyCustom(),
      highlighter: emptyCustom(),
      eraser: emptyCustom(),
    },
  };
}

function isDrawSnapshot(value: unknown): value is InkDrawSnapshot {
  if (!value || typeof value !== "object") return false;
  const snap = value as Partial<InkDrawSnapshot>;
  return typeof snap.width === "number" && typeof snap.colour === "string";
}

function isEraserSnapshot(value: unknown): value is InkEraserSnapshot {
  if (!value || typeof value !== "object") return false;
  const snap = value as Partial<InkEraserSnapshot>;
  return typeof snap.eraserWidth === "number" && typeof snap.partialErase === "boolean";
}

function clampDraw(snap: InkDrawSnapshot): InkDrawSnapshot {
  return {
    ...snap,
    name: snap.name.trim() || "Preset",
    width: clamp(snap.width, STROKE_WIDTH_MIN, STROKE_WIDTH_MAX),
    fullness: clamp(snap.fullness, 0, 1),
    pressureClip: clamp(snap.pressureClip, 0.3, 1),
    smoothing: clamp(snap.smoothing, 0, 1),
    smoothingMode: snap.smoothingMode === "live" ? "live" : "lift",
    speed: clamp(snap.speed, 0, 1),
    blot: clamp(snap.blot, 0, 1),
    // The one knob that may go negative, so it does not share the 0..1 clamp.
    body: clamp(snap.body ?? 0, INK_SPEED_BODY_MIN, INK_SPEED_BODY_MAX),
    fade: clamp(snap.fade, 0, 1),
    boldness: clamp(snap.boldness, INK_BOLDNESS_MIN, INK_BOLDNESS_MAX),
  };
}

function clampEraser(snap: InkEraserSnapshot): InkEraserSnapshot {
  return {
    ...snap,
    name: snap.name.trim() || "Preset",
    eraserWidth: clamp(snap.eraserWidth, STROKE_WIDTH_MIN, ERASER_WIDTH_MAX),
  };
}

function parseCustom(
  kind: InkPresetKind,
  raw: unknown,
): Array<InkWedgeSnapshot | null> {
  const slots = emptyCustom();
  if (!Array.isArray(raw)) return slots;
  for (let i = 0; i < CUSTOM_WEDGE_COUNT; i++) {
    const item = raw[i];
    if (item == null) {
      slots[i] = null;
      continue;
    }
    if (kind === "eraser") {
      slots[i] = isEraserSnapshot(item) ? clampEraser(item) : null;
    } else {
      slots[i] = isDrawSnapshot(item) ? clampDraw(item) : null;
    }
  }
  return slots;
}

export function loadInkToolPresets(): InkToolPresetStore {
  const fallback = defaultStore();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<InkToolPresetStore>;
    const last = parsed.lastWedge ?? fallback.lastWedge;
    return {
      wheelLocked: parsed.wheelLocked !== false,
      colorWheelOnToolbar: parsed.colorWheelOnToolbar === true,
      tapOk: parsed.tapOk !== false,
      lastWedge: {
        pen: clamp(typeof last.pen === "number" ? last.pen : 0, 0, CUSTOM_WEDGE_COUNT),
        highlighter: clamp(
          typeof last.highlighter === "number" ? last.highlighter : 0,
          0,
          CUSTOM_WEDGE_COUNT,
        ),
        eraser: clamp(typeof last.eraser === "number" ? last.eraser : 0, 0, CUSTOM_WEDGE_COUNT),
      },
      globalDraw: isDrawSnapshot(parsed.globalDraw)
        ? clampDraw(parsed.globalDraw)
        : fallback.globalDraw,
      globalEraser: isEraserSnapshot(parsed.globalEraser)
        ? clampEraser(parsed.globalEraser)
        : fallback.globalEraser,
      custom: {
        pen: parseCustom("pen", parsed.custom?.pen),
        highlighter: parseCustom("highlighter", parsed.custom?.highlighter),
        eraser: parseCustom("eraser", parsed.custom?.eraser),
      },
    };
  } catch {
    return fallback;
  }
}

export function saveInkToolPresets(store: InkToolPresetStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* private browsing */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("lc-ink-presets"));
  }
}

export function wedgeAt(
  store: InkToolPresetStore,
  kind: InkPresetKind,
  index: number,
): InkWedgeSnapshot | null {
  if (index <= 0) {
    return kind === "eraser" ? store.globalEraser : store.globalDraw;
  }
  return store.custom[kind][index - 1] ?? null;
}

export function isEraserWedge(snap: InkWedgeSnapshot): snap is InkEraserSnapshot {
  return "eraserWidth" in snap;
}

/** Pink fill proportional to eraser nib vs {@link ERASER_WIDTH_MAX}. */
export function eraserWedgeFill(width: number): string {
  const t = clamp(width / ERASER_WIDTH_MAX, 0, 1);
  const r = Math.round(252 + (190 - 252) * t);
  const g = Math.round(231 + (24 - 231) * t);
  const b = Math.round(243 + (93 - 243) * t);
  return `rgb(${r} ${g} ${b})`;
}

function emit(name: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name));
}

export function writeLiveFromDraw(snap: InkDrawSnapshot, prefs: InkToolPrefs): InkToolPrefs {
  const next: InkToolPrefs = {
    ...prefs,
    penWidth: snap.width,
    inkFullness: snap.fullness,
    pressureSensitive: snap.pressureSensitive,
    straightInk: snap.straightInk,
    inkColor: snap.colour,
  };
  saveInkToolPrefs(next);
  saveInkPressureClip(snap.pressureClip);
  saveInkSmoothing(snap.smoothing);
  saveInkSmoothingMode(snap.smoothingMode);
  saveInkSpeed(snap.speed);
  saveInkSpeedBlotBlend(snap.blot);
  saveInkSpeedFade(snap.fade);
  saveInkSpeedBodyAccent(snap.body ?? 0);
  saveInkBoldness(snap.boldness);
  emit("lc-ink-pressure-clip");
  emit("lc-ink-smoothing");
  emit("lc-ink-speed");
  emit(INK_SPEED_BLOT_BLEND_EVENT);
  emit(INK_SPEED_FADE_EVENT);
  emit(INK_SPEED_BODY_ACCENT_EVENT);
  emit(INK_BOLDNESS_EVENT);
  return next;
}

export function writeLiveFromEraser(
  snap: InkEraserSnapshot,
  prefs: InkToolPrefs,
): InkToolPrefs {
  const next: InkToolPrefs = { ...prefs, eraserWidth: snap.eraserWidth };
  saveInkToolPrefs(next);
  saveEraserPartial(snap.partialErase);
  emit(ERASER_PARTIAL_EVENT);
  return next;
}

/**
 * Apply a wedge to live keys.
 * Custom apply does not rewrite stored Global. Slot 0 writes Global + live.
 */
export function applyWedge(
  store: InkToolPresetStore,
  kind: InkPresetKind,
  index: number,
): InkToolPresetStore {
  const wedge = wedgeAt(store, kind, index);
  if (!wedge) return store;
  const prefs = loadInkToolPrefs();
  if (kind === "eraser" && isEraserWedge(wedge)) {
    writeLiveFromEraser(wedge, prefs);
  } else if (!isEraserWedge(wedge)) {
    writeLiveFromDraw(wedge, prefs);
  }
  const next: InkToolPresetStore = {
    ...store,
    lastWedge: { ...store.lastWedge, [kind]: index },
  };
  if (index === 0) {
    if (kind === "eraser" && isEraserWedge(wedge)) next.globalEraser = clampEraser(wedge);
    else if (!isEraserWedge(wedge)) next.globalDraw = clampDraw(wedge);
  }
  saveInkToolPresets(next);
  return next;
}

export function saveWedge(
  store: InkToolPresetStore,
  kind: InkPresetKind,
  index: number,
  snap: InkWedgeSnapshot,
): InkToolPresetStore {
  const next: InkToolPresetStore = {
    ...store,
    custom: {
      pen: [...store.custom.pen],
      highlighter: [...store.custom.highlighter],
      eraser: [...store.custom.eraser],
    },
    lastWedge: { ...store.lastWedge, [kind]: index },
  };
  if (index <= 0) {
    if (kind === "eraser" && isEraserWedge(snap)) {
      next.globalEraser = clampEraser(snap);
      writeLiveFromEraser(next.globalEraser, loadInkToolPrefs());
    } else if (!isEraserWedge(snap)) {
      next.globalDraw = clampDraw(snap);
      writeLiveFromDraw(next.globalDraw, loadInkToolPrefs());
    }
  } else {
    const slot = index - 1;
    if (slot >= CUSTOM_WEDGE_COUNT) return store;
    if (kind === "eraser" && isEraserWedge(snap)) {
      next.custom.eraser[slot] = clampEraser(snap);
    } else if (!isEraserWedge(snap)) {
      next.custom[kind][slot] = clampDraw(snap);
    } else {
      return store;
    }
  }
  saveInkToolPresets(next);
  return next;
}

export function duplicateWedge(
  store: InkToolPresetStore,
  kind: InkPresetKind,
  index: number,
): { store: InkToolPresetStore; slot: number } | null {
  const source = wedgeAt(store, kind, index);
  if (!source) return null;
  const empty = store.custom[kind].findIndex((slot) => slot == null);
  if (empty < 0) return null;
  const copy: InkWedgeSnapshot = isEraserWedge(source)
    ? { ...source, name: `${source.name} copy` }
    : { ...source, name: `${source.name} copy` };
  return { store: saveWedge(store, kind, empty + 1, copy), slot: empty + 1 };
}

export function kindFromTool(tool: string): InkPresetKind | null {
  if (tool === "freedraw") return "pen";
  if (tool === "highlighter") return "highlighter";
  if (tool === "eraser") return "eraser";
  return null;
}

export function toolFromKind(kind: InkPresetKind): "freedraw" | "highlighter" | "eraser" {
  if (kind === "pen") return "freedraw";
  return kind;
}

export function wheelConfirmEnabled(args: {
  openKind: InkPresetKind;
  openWedge: number;
  selectedKind: InkPresetKind | null;
  selectedWedge: number | null;
  /** User tapped an inner wedge this open. Current tool already counts as outer. */
  innerChosen?: boolean;
}): boolean {
  if (args.selectedKind == null || args.selectedWedge == null) return false;
  if (args.innerChosen) return true;
  return args.selectedKind !== args.openKind || args.selectedWedge !== args.openWedge;
}

/**
 * Tap OK off: inner wedge is ready to apply. Callers must apply on
 * pointerup, not when `innerChosen` first becomes true — pointerdown starts
 * hold-to-edit, and applying there closes the wheel before the fill can finish.
 *
 * Current tool is outer on open. Switching the tool ring pre-selects that
 * tool's last wedge; an inner press (including the already-highlighted one)
 * is what commits when Tap OK is off.
 */
export function wheelAutoApply(args: {
  tapOk: boolean;
  outerDone: boolean;
  openKind: InkPresetKind;
  openWedge: number;
  selectedKind: InkPresetKind | null;
  selectedWedge: number | null;
  innerChosen?: boolean;
}): boolean {
  if (args.tapOk || !args.outerDone || !args.innerChosen) return false;
  return wheelConfirmEnabled(args);
}

export function specCardSide(
  anchorX: number,
  wheelR: number,
  cardW: number,
  viewW: number,
  pad = 12,
): "right" | "left" {
  return anchorX + wheelR + cardW < viewW - pad ? "right" : "left";
}

/** Signed turn from one raw hop to the next (radians). No smoothing. */
export function wheelHoldTurn(
  prevDx: number,
  prevDy: number,
  dx: number,
  dy: number,
): number {
  const cross = prevDx * dy - prevDy * dx;
  const dot = prevDx * dx + prevDy * dy;
  if (cross === 0 && dot === 0) return 0;
  const turn = Math.atan2(cross, dot);
  // A zig-zag reversal is ~π and would pile up. A bullet/spiral hop is a
  // small arc. Drop flips so only orbits count.
  if (Math.abs(turn) > (Math.PI * 2) / 3) return 0;
  return turn;
}

/**
 * This hop continues a letter (tiny line or arc), not a zig-zag rest.
 * Used to restart the dwell clock while writing finely in one patch.
 */
export function wheelHoldIsDrawingHop(
  prevDx: number,
  prevDy: number,
  dx: number,
  dy: number,
  minPathPx = WHEEL_HOLD_DRAW_PATH_PX,
  straightness = WHEEL_HOLD_STRAIGHTNESS,
): boolean {
  const prevLen = Math.hypot(prevDx, prevDy);
  const len = Math.hypot(dx, dy);
  if (prevLen < 1e-6 || len < 1e-6) return false;
  const cross = prevDx * dy - prevDy * dx;
  const dot = prevDx * dx + prevDy * dy;
  const turn = Math.atan2(cross, dot);
  if (Math.abs(turn) > (Math.PI * 2) / 3) return false;
  const localPath = prevLen + len;
  if (localPath < minPathPx) return false;
  if (Math.abs(turn) >= 0.12) return true;
  const localNet = Math.hypot(prevDx + dx, prevDy + dy);
  return localNet / localPath >= straightness;
}

/**
 * Raw samples only — no smoothing. A rest is a point or a zig-zag (heading
 * cancels). A stroke goes somewhere (net/path) or orbits (winding).
 */
export function wheelHoldIsStroke(
  netPx: number,
  pathPx: number,
  moves = 0,
  windRad = 0,
  slopPx = WHEEL_HOLD_SLOP_PX,
  clearPx = WHEEL_HOLD_CLEAR_PX,
  straightness = WHEEL_HOLD_STRAIGHTNESS,
  windMin = WHEEL_HOLD_WIND_RAD,
): boolean {
  if (Math.abs(windRad) >= windMin) return true;
  if (netPx <= slopPx) return false;
  if (moves < 2) return netPx >= clearPx;
  const path = Math.max(pathPx, netPx);
  return netPx / path >= straightness;
}

export function wheelHoldOutcome(
  movedPx: number,
  elapsedMs: number,
  pathPx = 0,
  moves = 0,
  windRad = 0,
  slopPx = WHEEL_HOLD_SLOP_PX,
  holdMs = WHEEL_OPEN_MS,
): "pending" | "ink" | "wheel" {
  if (wheelHoldIsStroke(movedPx, pathPx, moves, windRad, slopPx)) return "ink";
  if (elapsedMs >= holdMs) return "wheel";
  return "pending";
}

export const INK_PRESET_DEFAULTS = {
  fullness: INK_FULLNESS_DEFAULT,
  speed: INK_SPEED_DEFAULT,
  blot: INK_SPEED_BLOT_BLEND_DEFAULT,
  fade: INK_SPEED_FADE_DEFAULT,
  body: INK_SPEED_BODY_ACCENT_DEFAULT,
  boldness: INK_BOLDNESS_DEFAULT,
  pressureClip: PRESSURE_CLIP_DEFAULT,
  smoothing: INK_SMOOTHING_DEFAULT,
  smoothingMode: INK_SMOOTHING_MODE_DEFAULT,
  eraserPartial: ERASER_PARTIAL_DEFAULT,
  width: STROKE_WIDTH_DEFAULT,
};
