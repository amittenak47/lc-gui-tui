/**
 * iOS-style vertical number picker — scroll/drag to change a discrete value.
 * Flick continues with spring-damped momentum. Prevents default on pointerdown
 * so an open text box keeps focus.
 *
 * Direction: dragging down raises the value, dragging up lowers it. The list
 * scrolls under the finger the way a physical wheel would — pull the near edge
 * toward you and the larger numbers come round — which is the opposite of
 * treating the drag as a slider handle.
 *
 * With {@link allowFineScrub}, hold and drag ~28px horizontally outward to
 * enter fine mode (step 0.1); vertical drag then adjusts in tenths until release.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

export interface NumberWheelProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  /** Format the selected value label (default: trim trailing .0). */
  format?: (value: number) => string;
  /** Hold + drag outward horizontally to scrub in {@link fineStep} increments. */
  allowFineScrub?: boolean;
  /** Step used while fine scrub is active (default 0.1). */
  fineStep?: number;
}

const ITEM_H = 22;
const VISIBLE = 5;
/** Exponential friction per ms — lower = longer coast after a flick. */
const FRICTION = 0.0038;
const COARSE_FRICTION = 0.0024;
/** Stop coasting below this indices-per-ms speed. */
const REST_SPEED = 0.00035;
/** Minimum |px/ms| to start momentum. */
const FLICK_MIN = 0.12;
/** Horizontal drag to enter fine scrub mode. */
const FINE_SCRUB_THRESHOLD = 28;
const FINE_STEP_DEFAULT = 0.1;
/** Extra coast for integer-step wheels. */
const COARSE_MOMENTUM_BOOST = 1.75;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, min: number, step: number): number {
  const n = Math.round((value - min) / step);
  return Math.round((min + n * step) * 1000) / 1000;
}

function defaultFormat(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

function fineFormat(value: number): string {
  return value.toFixed(1);
}

export function NumberWheel({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  format = defaultFormat,
  allowFineScrub = false,
  fineStep = FINE_STEP_DEFAULT,
}: NumberWheelProps) {
  const activeStep = step;
  const clamped = clamp(roundToStep(value, min, activeStep), min, max);
  const [fineMode, setFineMode] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const startValueRef = useRef(clamped);
  const fineStartYRef = useRef(0);
  const fineStartValueRef = useRef(clamped);
  const velocityRef = useRef(0);
  const lastYRef = useRef(0);
  const lastTRef = useRef(0);
  const momentumRef = useRef<number | null>(null);
  const indexRef = useRef(0);
  const fineModeRef = useRef(false);
  fineModeRef.current = fineMode;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const clampedRef = useRef(clamped);
  clampedRef.current = clamped;

  const displayFormat = fineMode ? fineFormat : format;

  const values = useMemo(() => {
    const out: number[] = [];
    const count = Math.floor((max - min) / activeStep + 1e-9) + 1;
    for (let index = 0; index < count; index++) {
      const next = Math.round((min + index * activeStep) * 1000) / 1000;
      if (next > max + 1e-9) break;
      out.push(clamp(next, min, max));
    }
    if (out[out.length - 1] !== max) out.push(max);
    return out;
  }, [min, max, activeStep]);

  const valuesRef = useRef(values);
  valuesRef.current = values;

  const indexOf = useCallback(
    (v: number, listStep = activeStep) => {
      const snapped = clamp(roundToStep(v, min, listStep), min, max);
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
    [activeStep, max, min, values],
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

  const commitValue = useCallback((next: number, listStep = activeStep) => {
    const snapped = clamp(roundToStep(next, min, listStep), min, max);
    if (snapped !== clampedRef.current) {
      onChangeRef.current(snapped);
    }
  }, [activeStep, max, min]);

  const commitIndex = useCallback(
    (index: number) => {
      const list = valuesRef.current;
      const next = list[clamp(Math.round(index), 0, list.length - 1)];
      if (next !== undefined) commitValue(next);
    },
    [commitValue],
  );

  const enterFineMode = useCallback((clientY: number) => {
    if (!allowFineScrub || fineModeRef.current) return;
    fineModeRef.current = true;
    setFineMode(true);
    fineStartYRef.current = clientY;
    fineStartValueRef.current = clampedRef.current;
    stopMomentum();
  }, [allowFineScrub, stopMomentum]);

  const runMomentum = useCallback(
    (fromIndex: number, velocityPxPerMs: number, listStep = activeStep) => {
      stopMomentum();
      const friction = listStep >= 1 ? COARSE_FRICTION : FRICTION;
      const boost = listStep >= 1 ? COARSE_MOMENTUM_BOOST : 1;
      let index = fromIndex;
      let vel = (velocityPxPerMs / ITEM_H) * boost;
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
          vel *= Math.exp(-friction * dt);
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
    fineModeRef.current = false;
    setFineMode(false);
    startXRef.current = event.clientX;
    startYRef.current = event.clientY;
    startValueRef.current = clamped;
    fineStartYRef.current = event.clientY;
    fineStartValueRef.current = clamped;
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
    velocityRef.current = velocityRef.current * 0.65 + instant * 0.35;
    lastYRef.current = event.clientY;
    lastTRef.current = now;

    if (allowFineScrub && !fineModeRef.current) {
      const outwardX = Math.abs(event.clientX - startXRef.current);
      if (outwardX >= FINE_SCRUB_THRESHOLD) {
        enterFineMode(event.clientY);
      }
    }

    if (fineModeRef.current) {
      const deltaY = event.clientY - fineStartYRef.current;
      const next = clamp(
        roundToStep(fineStartValueRef.current + (deltaY / ITEM_H) * fineStep, min, fineStep),
        min,
        max,
      );
      commitValue(next, fineStep);
      return;
    }

    const delta = event.clientY - startYRef.current;
    const steps = Math.round(delta / ITEM_H);
    const nextIndex = clamp(indexOf(startValueRef.current) + steps, 0, values.length - 1);
    commitIndex(nextIndex);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const wasFine = fineModeRef.current;
    fineModeRef.current = false;
    setFineMode(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* capture may already be gone */
    }
    if (wasFine) {
      commitValue(clampedRef.current, fineStep);
      return;
    }
    const v = velocityRef.current;
    if (Math.abs(v) >= FLICK_MIN) {
      runMomentum(indexRef.current, v, activeStep);
    } else {
      commitIndex(indexRef.current);
    }
  };

  const pad = Math.floor(VISIBLE / 2);
  const fineVisible = useMemo(() => {
    if (!fineMode) return null;
    const center = clampedRef.current;
    const out: number[] = [];
    for (let i = pad; i >= -pad; i--) {
      out.push(clamp(roundToStep(center + i * fineStep, min, fineStep), min, max));
    }
    return out;
  }, [clamped, fineMode, fineStep, max, min, pad]);

  const windowStart = clamp(selectedIndex - pad, 0, Math.max(0, values.length - VISIBLE));
  const windowEnd = Math.min(values.length, windowStart + VISIBLE);
  const coarseVisible = values.slice(windowStart, windowEnd).reverse();
  const visible = fineMode && fineVisible ? fineVisible : coarseVisible;
  const listStep = fineMode ? fineStep : activeStep;

  return (
    <div className="lc-stroke-slider lc-number-wheel-wrap" role="group" aria-label={label}>
      <div
        ref={rootRef}
        className={fineMode ? "lc-number-wheel lc-number-wheel-fine" : "lc-number-wheel"}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clamped}
        aria-valuetext={displayFormat(clamped)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => {
          const keyStep = fineMode ? fineStep : activeStep;
          if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            event.preventDefault();
            commitValue(clamped + keyStep, keyStep);
          } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            event.preventDefault();
            commitValue(clamped - keyStep, keyStep);
          } else if (event.key === "Home") {
            event.preventDefault();
            commitValue(min, keyStep);
          } else if (event.key === "End") {
            event.preventDefault();
            commitValue(max, keyStep);
          }
        }}
      >
        <div className="lc-number-wheel-fade lc-number-wheel-fade-top" aria-hidden />
        <div className="lc-number-wheel-window" aria-hidden>
          {visible.map((entry) => {
            const active =
              entry === clamped || Math.abs(entry - clamped) < listStep * 0.25;
            return (
              <div
                key={`${fineMode ? "f" : "c"}-${entry}`}
                className={active ? "lc-number-wheel-item lc-number-wheel-item-active" : "lc-number-wheel-item"}
              >
                {displayFormat(entry)}
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
