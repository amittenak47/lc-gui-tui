/**
 * iOS-style vertical number picker — scroll/drag to change a discrete value.
 * Flick continues with spring-damped momentum. Prevents default on pointerdown
 * so an open text box keeps focus.
 *
 * Direction: dragging down raises the value, dragging up lowers it. The list
 * scrolls under the finger the way a physical wheel would — pull the near edge
 * toward you and the larger numbers come round — which is the opposite of
 * treating the drag as a slider handle.
 */

import { useCallback, useEffect, useMemo, useRef, type PointerEvent } from "react";

export interface NumberWheelProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  /** Format the selected value label (default: trim trailing .0). */
  format?: (value: number) => string;
}

const ITEM_H = 22;
const VISIBLE = 5;
/** Exponential friction per ms — lower = longer coast after a flick. */
const FRICTION = 0.0038;
/** Stop coasting below this indices-per-ms speed. */
const REST_SPEED = 0.00035;
/** Minimum |px/ms| to start momentum. */
const FLICK_MIN = 0.12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, min: number, step: number): number {
  const n = Math.round((value - min) / step);
  return min + n * step;
}

function defaultFormat(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

export function NumberWheel({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  format = defaultFormat,
}: NumberWheelProps) {
  const clamped = clamp(roundToStep(value, min, step), min, max);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startValueRef = useRef(clamped);
  const velocityRef = useRef(0);
  const lastYRef = useRef(0);
  const lastTRef = useRef(0);
  const momentumRef = useRef<number | null>(null);
  const indexRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const clampedRef = useRef(clamped);
  clampedRef.current = clamped;

  const values = useMemo(() => {
    const out: number[] = [];
    const count = Math.floor((max - min) / step + 1e-9) + 1;
    for (let index = 0; index < count; index++) {
      const next = Math.round((min + index * step) * 1000) / 1000;
      if (next > max + 1e-9) break;
      out.push(clamp(next, min, max));
    }
    if (out[out.length - 1] !== max) out.push(max);
    return out;
  }, [min, max, step]);

  const valuesRef = useRef(values);
  valuesRef.current = values;

  const indexOf = useCallback(
    (v: number) => {
      const snapped = clamp(roundToStep(v, min, step), min, max);
      let best = 0;
      let bestDist = Infinity;
      for (let index = 0; index < values.length; index++) {
        const dist = Math.abs(values[index] - snapped);
        if (dist < bestDist) {
          bestDist = dist;
          best = index;
        }
      }
      return best;
    },
    [max, min, step, values],
  );

  const selectedIndex = indexOf(clamped);
  indexRef.current = selectedIndex;

  const stopMomentum = useCallback(() => {
    if (momentumRef.current != null) {
      cancelAnimationFrame(momentumRef.current);
      momentumRef.current = null;
    }
  }, []);

  useEffect(() => () => stopMomentum(), [stopMomentum]);

  const commitIndex = useCallback(
    (index: number) => {
      const list = valuesRef.current;
      const next = list[clamp(Math.round(index), 0, list.length - 1)];
      if (next !== undefined && next !== clampedRef.current) {
        onChangeRef.current(next);
      }
    },
    [],
  );

  const runMomentum = useCallback(
    (fromIndex: number, velocityPxPerMs: number) => {
      stopMomentum();
      // Finger moving down (positive dy) raises the value index — same as drag math.
      let index = fromIndex;
      let vel = velocityPxPerMs / ITEM_H; // indices per ms
      let last = performance.now();
      const listLen = valuesRef.current.length;

      const stepFrame = (now: number) => {
        const dt = Math.min(34, Math.max(1, now - last));
        last = now;
        index += vel * dt;
        if (index <= 0) {
          index = 0;
          vel = 0;
        } else if (index >= listLen - 1) {
          index = listLen - 1;
          vel = 0;
        } else {
          vel *= Math.exp(-FRICTION * dt);
        }
        commitIndex(index);
        if (Math.abs(vel) < REST_SPEED) {
          commitIndex(Math.round(index));
          momentumRef.current = null;
          return;
        }
        momentumRef.current = requestAnimationFrame(stepFrame);
      };
      momentumRef.current = requestAnimationFrame(stepFrame);
    },
    [commitIndex, stopMomentum],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    stopMomentum();
    draggingRef.current = true;
    startYRef.current = event.clientY;
    startValueRef.current = clamped;
    lastYRef.current = event.clientY;
    lastTRef.current = performance.now();
    velocityRef.current = 0;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    event.preventDefault();
    const now = performance.now();
    const dt = Math.max(1, now - lastTRef.current);
    const instant = (event.clientY - lastYRef.current) / dt;
    // EMA so a flick's last samples dominate without one jitter spike.
    velocityRef.current = velocityRef.current * 0.65 + instant * 0.35;
    lastYRef.current = event.clientY;
    lastTRef.current = now;

    const delta = event.clientY - startYRef.current;
    const steps = Math.round(delta / ITEM_H);
    const nextIndex = clamp(indexOf(startValueRef.current) + steps, 0, values.length - 1);
    commitIndex(nextIndex);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* capture may already be gone */
    }
    const v = velocityRef.current;
    if (Math.abs(v) >= FLICK_MIN) {
      runMomentum(indexRef.current, v);
    } else {
      commitIndex(indexRef.current);
    }
  };

  const pad = Math.floor(VISIBLE / 2);
  const windowStart = clamp(selectedIndex - pad, 0, Math.max(0, values.length - VISIBLE));
  const windowEnd = Math.min(values.length, windowStart + VISIBLE);
  // Larger values sit above the selector, so a drag downward pulls them into it
  // and the list moves with the finger rather than against it.
  const visible = values.slice(windowStart, windowEnd).reverse();

  return (
    <div className="lc-stroke-slider lc-number-wheel-wrap" role="group" aria-label={label}>
      <div
        ref={rootRef}
        className="lc-number-wheel"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clamped}
        aria-valuetext={format(clamped)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => {
          // Arrows follow the drag: Up lowers, Down raises.
          if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            event.preventDefault();
            commitIndex(selectedIndex + 1);
          } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            event.preventDefault();
            commitIndex(selectedIndex - 1);
          } else if (event.key === "Home") {
            event.preventDefault();
            commitIndex(0);
          } else if (event.key === "End") {
            event.preventDefault();
            commitIndex(values.length - 1);
          }
        }}
      >
        <div className="lc-number-wheel-fade lc-number-wheel-fade-top" aria-hidden />
        <div className="lc-number-wheel-window" aria-hidden>
          {visible.map((entry) => {
            const active = entry === clamped || Math.abs(entry - clamped) < step * 0.25;
            return (
              <div
                key={entry}
                className={active ? "lc-number-wheel-item lc-number-wheel-item-active" : "lc-number-wheel-item"}
              >
                {format(entry)}
              </div>
            );
          })}
        </div>
        <div className="lc-number-wheel-fade lc-number-wheel-fade-bottom" aria-hidden />
        <div className="lc-number-wheel-selection" aria-hidden />
      </div>
    </div>
  );
}
