/**
 * Ink colour control — radial wheel (SVG donut wedges).
 *
 * Toolbar: tap cycles the next palette (fetch past the end); hold opens the
 * wheel. Open hub: tap cycles palettes already in history, no fetch.
 * Wedge: tap/drag picks; hold opens the OS colour editor for that slot.
 *
 * Portaled with `position: fixed` so the toolbar scroller cannot clip the ring.
 * Open/close and palette swaps use the same MorphBar timing as the shape flyout:
 * the disc scales out of the swatch, and a new palette rotates in rather than
 * popping.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { MorphBar } from "../components/MorphBar";
import type { InkHandedness } from "../util/inkHandedness";

import { HOLD_MS } from "../util/gesture";
/**
 * Hold on a wedge to change what colour lives there.
 *
 * Longer than {@link HOLD_MS}, which opens the ring: opening is a thing you do
 * constantly and editing is a thing you do twice, so the rarer gesture is the
 * one that has to be meant. Long enough that a slow tap-to-pick never trips it.
 */
const EDIT_HOLD_MS = 550;
/** Outer / inner radius of the colour ring (CSS px). Toolbar / flyout size. */
export const OUTER_R = 78;
const INNER_R = 34;
/** Preset-sheet ring — large enough the full dial reads, still fits the left column. */
const EMBEDDED_OUTER_R = 92;
const EMBEDDED_INNER_R = 40;
/** Hit slop beyond the ring for drag-pick. */
const HIT_PAD = 10;
/** Keep the ring this far inside the window when the swatch sits on an edge. */
const VIEW_PAD = 8;

interface ColorRadialProps {
  colors: readonly string[];
  value: string;
  onPick: (color: string) => void;
  /** Quick tap on the toolbar swatch — next palette (parent may fetch). */
  onCycleNext?: () => void;
  /** Quick tap on the open hub — previous palette in history. */
  onCyclePrev?: () => void;
  /**
   * A wedge was held: the writer wants a different colour in that slot.
   *
   * Absent means the palette is not editable here, and the hold does nothing —
   * the control still works exactly as it did.
   */
  onEditColor?: (index: number, color: string) => void;
  handedness: InkHandedness;
  compact?: boolean;
  /**
   * Always-on ring inside a host (the 1D preset sheet). No swatch, no portal,
   * no close-on-pick — the full dial stays in layout so MorphBar cannot clip it.
   */
  embedded?: boolean;
  /** Portaled wheel stacks above doc sheets (footnote hub uses ~240). */
  wheelZIndex?: number;
}

interface Wedge {
  color: string;
  /** Mid-angle in radians (0 = up, clockwise). */
  mid: number;
  start: number;
  end: number;
  path: string;
}

type PaletteFrame = { id: string; wedges: Wedge[] };

function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  // 0 rad = straight up; positive clockwise (matches prior fan convention).
  return [cx + Math.sin(angle) * r, cy - Math.cos(angle) * r];
}

function donutSlice(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  a0: number,
  a1: number,
): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, outer, a0);
  const [x1, y1] = polar(cx, cy, outer, a1);
  const [x2, y2] = polar(cx, cy, inner, a1);
  const [x3, y3] = polar(cx, cy, inner, a0);
  return [
    `M ${x0} ${y0}`,
    `A ${outer} ${outer} 0 ${large} 1 ${x1} ${y1}`,
    `L ${x2} ${y2}`,
    `A ${inner} ${inner} 0 ${large} 0 ${x3} ${y3}`,
    "Z",
  ].join(" ");
}

/** Build equal wedges; slight rotation bias so seams sit clear of the writing hand. */
function buildWedges(
  colors: readonly string[],
  handedness: InkHandedness,
  outerR = OUTER_R,
  innerR = INNER_R,
): Wedge[] {
  const n = Math.max(colors.length, 1);
  const step = (Math.PI * 2) / n;
  // Rotate so a seam is not under the wrist; right-hand writers get a small CW bias.
  const bias = handedness === "right" ? -step * 0.15 : step * 0.15;
  const start0 = -Math.PI + bias;
  return colors.map((color, index) => {
    const start = start0 + step * index;
    const end = start + step;
    const mid = (start + end) / 2;
    return {
      color,
      mid,
      start,
      end,
      path: donutSlice(outerR, outerR, innerR, outerR, start, end),
    };
  });
}

function angleFromCentre(dx: number, dy: number): number {
  // Match polar(): 0 = up, clockwise positive.
  return Math.atan2(dx, -dy);
}

function normalizeAngle(a: number): number {
  let x = a;
  while (x <= -Math.PI) x += Math.PI * 2;
  while (x > Math.PI) x -= Math.PI * 2;
  return x;
}

function angleInWedge(angle: number, start: number, end: number): boolean {
  const a = normalizeAngle(angle);
  const s = normalizeAngle(start);
  let e = normalizeAngle(end);
  if (e < s) e += Math.PI * 2;
  let x = a;
  if (x < s) x += Math.PI * 2;
  return x >= s && x <= e;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keep a ring of `radius` inside `view`, so a swatch on the bottom edge does
 * not park half the wheel under the window.
 */
export function clampWheelAnchor(
  x: number,
  y: number,
  radius: number,
  view: { width: number; height: number },
  pad = VIEW_PAD,
): { x: number; y: number } {
  const min = radius + pad;
  return {
    x: Math.min(Math.max(min, view.width - min), Math.max(min, x)),
    y: Math.min(Math.max(min, view.height - min), Math.max(min, y)),
  };
}

export function ColorRadial({
  colors,
  value,
  onPick,
  onCycleNext,
  onCyclePrev,
  onEditColor,
  handedness,
  compact = false,
  embedded = false,
  wheelZIndex = 90,
}: ColorRadialProps) {
  const filterUid = useId().replace(/:/g, "");
  const outerR = embedded ? EMBEDDED_OUTER_R : OUTER_R;
  const innerR = embedded ? EMBEDDED_INNER_R : INNER_R;
  const [open, setOpen] = useState(embedded);
  const [closing, setClosing] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  /** Instant fill before parent `value` catches up after onPick. */
  const [pending, setPending] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [cycleDir, setCycleDir] = useState<"next" | "prev">("next");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  /**
   * Slot-edit hold. Cancelled by the pick, by leaving the wedge, and by the
   * drag that a pick starts with, so the only way to reach the editor is to
   * put a finger down and leave it there.
   */
  const editTimerRef = useRef<number>(0);
  const editingSlotRef = useRef<number | null>(null);
  const colorInputRef = useRef<HTMLInputElement | null>(null);

  const shown = pending ?? value;
  useEffect(() => {
    setPending(null);
  }, [value]);

  const pickColor = useCallback(
    (color: string) => {
      setPending(color);
      onPick(color);
    },
    [onPick],
  );

  const cancelEditHold = useCallback(() => {
    if (editTimerRef.current) {
      window.clearTimeout(editTimerRef.current);
      editTimerRef.current = 0;
    }
  }, []);

  useEffect(() => cancelEditHold, [cancelEditHold]);

  /**
   * Hand the slot to the platform's own colour picker.
   *
   * A native `<input type="color">` rather than a bespoke wheel: it is the one
   * picker that works in the tablet's WebView and on the desktop without
   * shipping a second colour UI, and on a touch device it is the OS picker the
   * writer already knows.
   */
  const openSlotEditor = useCallback((index: number, current: string) => {
    const input = colorInputRef.current;
    if (!input) return;
    editingSlotRef.current = index;
    input.value = current;
    input.click();
  }, []);

  const wedges = useMemo(
    () => buildWedges(colors, handedness, outerR, innerR),
    [colors, handedness, outerR, innerR],
  );
  const paletteId = `${handedness}:${colors.join("|")}`;
  const currentFrame = useMemo<PaletteFrame>(
    () => ({ id: paletteId, wedges }),
    [paletteId, wedges],
  );
  const [frames, setFrames] = useState<PaletteFrame[]>([currentFrame]);

  useLayoutEffect(() => {
    setFrames((prev) => {
      const last = prev[prev.length - 1];
      if (last?.id === currentFrame.id) {
        return prev.map((frame) => (frame.id === currentFrame.id ? currentFrame : frame));
      }
      return last ? [last, currentFrame] : [currentFrame];
    });
  }, [currentFrame]);

  const size = outerR * 2;

  const clearHold = useCallback(() => {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    if (embedded) return;
    clearHold();
    draggingRef.current = false;
    setHovered(null);
    setOpen(false);
    if (prefersReducedMotion()) {
      setClosing(false);
      return;
    }
    setClosing(true);
  }, [clearHold, embedded]);

  const finishClose = useCallback(() => {
    setClosing(false);
  }, []);

  useEffect(() => clearHold, [clearHold]);

  const wheelShown = open || closing;

  useLayoutEffect(() => {
    if (!wheelShown) {
      setAnchor(null);
      return;
    }
    const sync = () => {
      const node = rootRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      setAnchor(
        clampWheelAnchor(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
          outerR,
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [wheelShown, outerR]);

  useEffect(() => {
    if (!open || embedded) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".lc-color-wheel")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close, embedded]);

  const colorAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const node = rootRef.current;
      let cx = anchor?.x;
      let cy = anchor?.y;
      if (embedded && node) {
        const rect = node.getBoundingClientRect();
        cx = rect.left + rect.width / 2;
        cy = rect.top + rect.height / 2;
      }
      if (cx == null || cy == null) return null;
      const dx = clientX - cx;
      const dy = clientY - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < innerR - HIT_PAD || dist > outerR + HIT_PAD) return null;
      const angle = angleFromCentre(dx, dy);
      for (const wedge of wedges) {
        if (angleInWedge(angle, wedge.start, wedge.end)) return wedge.color;
      }
      return null;
    },
    [anchor, wedges, embedded, innerR, outerR],
  );

  useEffect(() => {
    if (!open) return;
    const onMove = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      setHovered(colorAt(event.clientX, event.clientY));
    };
    const onUp = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const landed = colorAt(event.clientX, event.clientY);
      if (landed) {
        pickColor(landed);
        close();
      } else {
        setHovered(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [open, colorAt, pickColor, close]);

  const renderDisc = (frame: PaletteFrame, interactive: boolean) => (
    <div className="lc-color-wheel-disc" aria-hidden={!interactive}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {interactive ? (
          <defs>
            <filter id={`lc-color-wheel-soft-${filterUid}`} x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="4" stdDeviation="6" floodOpacity="0.28" />
            </filter>
          </defs>
        ) : null}
        <circle
          className="lc-color-wheel-well"
          cx={outerR}
          cy={outerR}
          r={outerR - 0.5}
          filter={interactive ? `url(#lc-color-wheel-soft-${filterUid})` : undefined}
        />
        {frame.wedges.map((wedge, wedgeIndex) => {
          const state =
            interactive && wedge.color === hovered
              ? " is-hovered"
              : wedge.color.toLowerCase() === shown.toLowerCase()
                ? " is-current"
                : "";
          return (
            <path
              key={`${wedge.color}-${wedgeIndex}`}
              className={`lc-color-wedge${state}`}
              d={wedge.path}
              fill={wedge.color}
              role={interactive ? "menuitem" : undefined}
              tabIndex={-1}
              aria-label={interactive ? `Ink ${wedge.color}` : undefined}
              onPointerDown={
                interactive
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      draggingRef.current = true;
                      setHovered(wedge.color);
                      if (!onEditColor) return;
                      cancelEditHold();
                      const slot = wedgeIndex;
                      editTimerRef.current = window.setTimeout(() => {
                        editTimerRef.current = 0;
                        draggingRef.current = false;
                        openSlotEditor(slot, wedge.color);
                      }, EDIT_HOLD_MS);
                    }
                  : undefined
              }
              onPointerUp={interactive ? cancelEditHold : undefined}
              onPointerLeave={interactive ? cancelEditHold : undefined}
              onPointerCancel={interactive ? cancelEditHold : undefined}
              onClick={
                interactive
                  ? (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (editingSlotRef.current !== null) return;
                      cancelEditHold();
                      pickColor(wedge.color);
                      close();
                    }
                  : undefined
              }
            />
          );
        })}
        <circle className="lc-color-wheel-hub-ring" cx={outerR} cy={outerR} r={innerR} />
      </svg>
    </div>
  );

  const wheelNode =
    (embedded || (wheelShown && anchor)) && (
      <div
        className={
          embedded
            ? "lc-color-wheel lc-color-wheel-embedded"
            : closing
              ? "lc-color-wheel is-closing"
              : "lc-color-wheel is-open"
        }
        role="menu"
        aria-label="Ink colour"
        data-cycle={cycleDir}
        style={
          embedded || !anchor
            ? { width: size, height: size }
            : {
                left: anchor.x,
                top: anchor.y,
                width: size,
                height: size,
                marginLeft: -outerR,
                marginTop: -outerR,
                zIndex: wheelZIndex,
              }
        }
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          if (closing) finishClose();
        }}
      >
        <MorphBar
          active={paletteId}
          axis="height"
          className="lc-color-wheel-morph"
          data-cycle={cycleDir}
        >
          {frames.map((frame) => (
            <div key={frame.id} data-morph-id={frame.id}>
              {renderDisc(frame, frame.id === paletteId)}
            </div>
          ))}
        </MorphBar>
        <input
          ref={colorInputRef}
          type="color"
          className="lc-color-slot-input"
          aria-hidden
          tabIndex={-1}
          onChange={(event) => {
            const slot = editingSlotRef.current;
            editingSlotRef.current = null;
            if (slot === null) return;
            onEditColor?.(slot, event.target.value);
          }}
          onBlur={() => {
            editingSlotRef.current = null;
          }}
        />
        <button
          type="button"
          className="lc-color-wheel-hub"
          style={{ background: shown }}
          aria-label={
            onCyclePrev || onCycleNext
              ? "Current ink colour — tap to cycle palettes"
              : "Current ink colour"
          }
          title={
            onCyclePrev || onCycleNext ? "Tap to cycle palettes" : undefined
          }
          onClick={() => {
            if (editingSlotRef.current !== null) return;
            cancelEditHold();
            if (onCyclePrev) {
              setCycleDir("prev");
              onCyclePrev();
              return;
            }
            if (onCycleNext) {
              setCycleDir("next");
              onCycleNext();
              return;
            }
            close();
          }}
        />
      </div>
    );

  const wheel = embedded
    ? wheelNode
    : wheelNode
      ? createPortal(wheelNode, document.body)
      : null;

  return (
    <div
      ref={rootRef}
      className={
        embedded
          ? "lc-color-radial lc-color-radial-embedded"
          : compact
            ? "lc-color-radial lc-color-radial-compact"
            : "lc-color-radial"
      }
    >
      {!embedded && (
        <button
          type="button"
          className={open ? "lc-color-dot lc-color-dot-open" : "lc-color-dot"}
          aria-label="Ink colour"
          aria-haspopup="true"
          aria-expanded={open}
          title={
            onCycleNext
              ? "Tap for next palette · hold to open the wheel"
              : "Ink colour — hold to open the wheel"
          }
          onPointerDown={() => {
            draggingRef.current = true;
            clearHold();
            holdTimerRef.current = window.setTimeout(() => {
              holdTimerRef.current = null;
              setClosing(false);
              setOpen(true);
            }, HOLD_MS);
          }}
          onPointerUp={() => {
            if (holdTimerRef.current != null) {
              clearHold();
              draggingRef.current = false;
              if (onCycleNext) {
                setCycleDir("next");
                onCycleNext();
                return;
              }
              if (open) {
                close();
                return;
              }
              setClosing(false);
              setOpen(true);
            }
          }}
          onPointerCancel={() => {
            clearHold();
            draggingRef.current = false;
          }}
        >
          <span className="lc-color-dot-fill" style={{ background: shown }} aria-hidden />
        </button>
      )}
      {wheel}
    </div>
  );
}
