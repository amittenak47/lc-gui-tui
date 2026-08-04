/**
 * Ink colour control — modern radial wheel (SVG donut wedges), not a fan of
 * floating circles. Hold or tap the centre dot to open; drag/tap a wedge to pick.
 *
 * Portaled with `position: fixed` so the toolbar scroller cannot clip the ring.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { InkHandedness } from "../util/inkHandedness";

const HOLD_MS = 220;
/** Outer / inner radius of the colour ring (CSS px). */
const OUTER_R = 78;
const INNER_R = 34;
/** Hit slop beyond the ring for drag-pick. */
const HIT_PAD = 10;

interface ColorRadialProps {
  colors: readonly string[];
  value: string;
  onPick: (color: string) => void;
  handedness: InkHandedness;
  compact?: boolean;
}

interface Wedge {
  color: string;
  /** Mid-angle in radians (0 = up, clockwise). */
  mid: number;
  start: number;
  end: number;
  path: string;
}

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
function buildWedges(colors: readonly string[], handedness: InkHandedness): Wedge[] {
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
      path: donutSlice(OUTER_R, OUTER_R, INNER_R, OUTER_R, start, end),
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

export function ColorRadial({
  colors,
  value,
  onPick,
  handedness,
  compact = false,
}: ColorRadialProps) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const draggingRef = useRef(false);

  const wedges = useMemo(() => buildWedges(colors, handedness), [colors, handedness]);
  const size = OUTER_R * 2;

  const clearHold = useCallback(() => {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearHold();
    draggingRef.current = false;
    setHovered(null);
    setOpen(false);
  }, [clearHold]);

  useEffect(() => clearHold, [clearHold]);

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const sync = () => {
      const node = rootRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      setAnchor({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
  }, [open, close]);

  const colorAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      if (!anchor) return null;
      const dx = clientX - anchor.x;
      const dy = clientY - anchor.y;
      const dist = Math.hypot(dx, dy);
      if (dist < INNER_R - HIT_PAD || dist > OUTER_R + HIT_PAD) return null;
      const angle = angleFromCentre(dx, dy);
      for (const wedge of wedges) {
        if (angleInWedge(angle, wedge.start, wedge.end)) return wedge.color;
      }
      return null;
    },
    [anchor, wedges],
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
        onPick(landed);
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
  }, [open, colorAt, onPick, close]);

  const wheel =
    open &&
    anchor &&
    createPortal(
      <div
        className="lc-color-wheel"
        role="menu"
        aria-label="Ink colour"
        style={{
          left: anchor.x,
          top: anchor.y,
          width: size,
          height: size,
          marginLeft: -OUTER_R,
          marginTop: -OUTER_R,
        }}
      >
        <div className="lc-color-wheel-disc" aria-hidden>
          <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
            <defs>
              <filter id="lc-color-wheel-soft" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="4" stdDeviation="6" floodOpacity="0.28" />
              </filter>
            </defs>
            <circle
              className="lc-color-wheel-well"
              cx={OUTER_R}
              cy={OUTER_R}
              r={OUTER_R - 0.5}
              filter="url(#lc-color-wheel-soft)"
            />
            {wedges.map((wedge) => {
              const state =
                wedge.color === hovered
                  ? " is-hovered"
                  : wedge.color === value
                    ? " is-current"
                    : "";
              return (
                <path
                  key={wedge.color}
                  className={`lc-color-wedge${state}`}
                  d={wedge.path}
                  fill={wedge.color}
                  role="menuitem"
                  tabIndex={-1}
                  aria-label={`Ink ${wedge.color}`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    draggingRef.current = true;
                    setHovered(wedge.color);
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onPick(wedge.color);
                    close();
                  }}
                />
              );
            })}
            <circle className="lc-color-wheel-hub-ring" cx={OUTER_R} cy={OUTER_R} r={INNER_R} />
          </svg>
          <button
            type="button"
            className="lc-color-wheel-hub"
            style={{ background: value }}
            aria-label="Current ink colour"
            onClick={() => close()}
          />
        </div>
      </div>,
      document.body,
    );

  return (
    <div
      ref={rootRef}
      className={compact ? "lc-color-radial lc-color-radial-compact" : "lc-color-radial"}
    >
      <button
        type="button"
        className={open ? "lc-color-dot lc-color-dot-open" : "lc-color-dot"}
        aria-label="Ink colour"
        aria-haspopup="true"
        aria-expanded={open}
        title="Ink colour — hold to open the wheel"
        onPointerDown={() => {
          draggingRef.current = true;
          clearHold();
          holdTimerRef.current = window.setTimeout(() => {
            holdTimerRef.current = null;
            setOpen(true);
          }, HOLD_MS);
        }}
        onPointerUp={() => {
          if (holdTimerRef.current != null) {
            clearHold();
            draggingRef.current = false;
            setOpen((current) => !current);
          }
        }}
        onPointerCancel={() => {
          clearHold();
          draggingRef.current = false;
        }}
      >
        <span className="lc-color-dot-fill" style={{ background: value }} aria-hidden />
      </button>
      {wheel}
    </div>
  );
}
