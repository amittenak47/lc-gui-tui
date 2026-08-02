/**
 * Ink colour control for the floating toolbar.
 *
 * One dot filled with the current colour. Press and hold (or tap) fans the
 * theme's swatches out on an arc above the bar; releasing over a swatch takes
 * it, releasing anywhere else keeps the current colour. A short tap never
 * recolours on its own — the old strip of six swatches was wide enough to catch
 * a resting palm, and this is the fix for that, not a smaller version of it.
 *
 * The arc leans away from the writing hand so the fan opens into empty board
 * instead of under the wrist.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { InkHandedness } from "../util/inkHandedness";

/** Hold this long and the fan opens under the finger, ready for a drag-pick. */
const HOLD_MS = 240;
/** Distance from the dot centre to a swatch centre. */
const RADIUS = 62;
/** Total sweep of the fan. */
const SPREAD_DEG = 128;
/** Lean of the fan away from the writing hand. */
const HAND_TILT_DEG = 16;

interface ColorRadialProps {
  colors: readonly string[];
  value: string;
  onPick: (color: string) => void;
  handedness: InkHandedness;
  compact?: boolean;
}

interface SwatchSeat {
  color: string;
  x: number;
  y: number;
}

/** Fan the swatches on an arc opening upward, tilted off the writing hand. */
function seats(colors: readonly string[], handedness: InkHandedness): SwatchSeat[] {
  const tilt = handedness === "right" ? -HAND_TILT_DEG : HAND_TILT_DEG;
  const span = colors.length > 1 ? SPREAD_DEG : 0;
  const step = colors.length > 1 ? span / (colors.length - 1) : 0;
  return colors.map((color, index) => {
    const deg = tilt - span / 2 + step * index;
    const rad = (deg * Math.PI) / 180;
    // 0deg points straight up; positive is clockwise.
    return {
      color,
      x: Math.sin(rad) * RADIUS,
      y: -Math.cos(rad) * RADIUS,
    };
  });
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  /** Set while a press is still down, so pointerup can pick what it landed on. */
  const draggingRef = useRef(false);

  const layout = seats(colors, handedness);

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

  // Any press outside the fan closes it, as does Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
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

  /** Which swatch is under this client point, if any. */
  const seatAt = useCallback(
    (clientX: number, clientY: number): string | null => {
      const node = rootRef.current;
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let best: string | null = null;
      let bestDist = Infinity;
      for (const seat of layout) {
        const dist = Math.hypot(clientX - (cx + seat.x), clientY - (cy + seat.y));
        if (dist < bestDist) {
          bestDist = dist;
          best = seat.color;
        }
      }
      return bestDist <= 26 ? best : null;
    },
    [layout],
  );

  // Drag-pick: track the finger while it stays down after the fan opened.
  useEffect(() => {
    if (!open) return;
    const onMove = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      setHovered(seatAt(event.clientX, event.clientY));
    };
    const onUp = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      const landed = seatAt(event.clientX, event.clientY);
      if (landed) {
        onPick(landed);
        close();
      } else {
        // Released back on the dot — leave the fan up so it can be tapped.
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
  }, [open, seatAt, onPick, close]);

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
        title="Ink colour — hold to open the palette"
        onPointerDown={() => {
          draggingRef.current = true;
          clearHold();
          holdTimerRef.current = window.setTimeout(() => {
            holdTimerRef.current = null;
            setOpen(true);
          }, HOLD_MS);
        }}
        onPointerUp={() => {
          // Short tap: the hold never fired, so treat it as a toggle.
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

      {open && (
        <div className="lc-color-fan" role="menu" aria-label="Ink colour">
          {layout.map((seat) => {
            const state =
              seat.color === hovered
                ? " is-hovered"
                : seat.color === value
                  ? " is-current"
                  : "";
            return (
              <button
                key={seat.color}
                type="button"
                role="menuitem"
                className={`lc-color-seat${state}`}
                style={{
                  background: seat.color,
                  transform: `translate(${seat.x}px, ${seat.y}px)`,
                }}
                aria-label={`Ink ${seat.color}`}
                aria-pressed={seat.color === value}
                onClick={() => {
                  onPick(seat.color);
                  close();
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
