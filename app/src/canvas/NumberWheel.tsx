/**
 * iOS-style vertical number picker — scroll/drag to change a discrete value.
 * Flick continues with spring-damped momentum. Prevents default on pointerdown
 * so an open text box keeps focus.
 *
 * Direction: larger numbers sit above. Finger/wheel down follows the list
 * (content moves down) and lowers the value. ArrowDown matches that.
 *
 * With {@link allowFineScrub}, hold and drag ~28px horizontally outward to
 * enter fine mode (step 0.1). Fine stays until pointer release.
 *
 * Coarse keeps any fractional part already on the value (12.5 → 13.5 → 14.5).
 * Fine shows one decimal (12 → 12.0) and steps by tenths.
 *
 * Edge padding: empty slots at both ends so the selection band can centre on
 * min/max (classic picker fix — without it, 1 sits under 2 and cannot scroll in).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

export interface NumberWheelProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label: string;
  /** Format the selected value label in coarse mode (default: trim trailing .0). */
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

type Slot = number | null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value: number, min: number, step: number): number {
  const n = Math.round((value - min) / step);
  return Math.round((min + n * step) * 1000) / 1000;
}

function fracPart(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Math.round((rounded - Math.trunc(rounded)) * 1000) / 1000;
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
  const clamped = clamp(value, min, max);
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
  const pad = Math.floor(VISIBLE / 2);

  /** Coarse ladder: min..max by `step`, keeping the live fractional offset. */
  const coarseValues = useMemo(() => {
    const frac = fineMode ? 0 : fracPart(clamped);
    const out: number[] = [];
    let cursor = Math.round((Math.ceil((min - frac) / step - 1e-9) * step + frac) * 1000) / 1000;
    if (cursor < min - 1e-9) cursor = Math.round((cursor + step) * 1000) / 1000;
    while (cursor <= max + 1e-9) {
      out.push(clamp(Math.round(cursor * 1000) / 1000, min, max));
      cursor = Math.round((cursor + step) * 1000) / 1000;
    }
    if (out.length === 0) out.push(clamp(min + frac, min, max));
    if (!out.some((entry) => Math.abs(entry - clamped) < 1e-6)) {
      out.push(clamped);
      out.sort((a, b) => a - b);
    }
    return out;
  }, [clamped, fineMode, max, min, step]);

  const fineValues = useMemo(() => {
    const out: number[] = [];
    const count = Math.floor((max - min) / fineStep + 1e-9) + 1;
    for (let index = 0; index < count; index++) {
      const next = Math.round((min + index * fineStep) * 1000) / 1000;
      if (next > max + 1e-9) break;
      out.push(clamp(next, min, max));
    }
    if (out[out.length - 1] !== max) out.push(max);
    return out;
  }, [fineStep, max, min]);

  const values = fineMode ? fineValues : coarseValues;
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const listStep = fineMode ? fineStep : step;

  const indexOf = useCallback(
    (v: number) => {
      let best = 0;
      let bestDist = Infinity;
      for (let index = 0; index < values.length; index++) {
        const dist = Math.abs(values[index] - v);
        if (dist < bestDist) {
          bestDist = dist;
          best = index;
        }
      }
      return best;
    },
    [values],
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

  const commitValue = useCallback(
    (next: number, listStepSize = listStep) => {
      const snapped = clamp(roundToStep(next, min, listStepSize), min, max);
      if (Math.abs(snapped - clampedRef.current) > 1e-9) {
        onChangeRef.current(snapped);
      }
    },
    [listStep, max, min],
  );

  const commitIndex = useCallback(
    (index: number) => {
      const list = valuesRef.current;
      const next = list[clamp(Math.round(index), 0, list.length - 1)];
      if (next !== undefined) {
        if (fineModeRef.current) commitValue(next, fineStep);
        else onChangeRef.current(clamp(next, min, max));
      }
    },
    [commitValue, fineStep, max, min],
  );

  const enterFineMode = useCallback(
    (clientY: number) => {
      if (!allowFineScrub || fineModeRef.current) return;
      fineModeRef.current = true;
      setFineMode(true);
      fineStartYRef.current = clientY;
      // Snap display to one decimal so "12" fades into "12.0".
      const start = clamp(roundToStep(clampedRef.current, min, fineStep), min, max);
      fineStartValueRef.current = start;
      if (Math.abs(start - clampedRef.current) > 1e-9) {
        onChangeRef.current(start);
      }
      stopMomentum();
    },
    [allowFineScrub, fineStep, min, max, stopMomentum],
  );

  const runMomentum = useCallback(
    (fromIndex: number, velocityPxPerMs: number) => {
      stopMomentum();
      const friction = fineModeRef.current ? FRICTION : COARSE_FRICTION;
      const boost = fineModeRef.current ? 1 : COARSE_MOMENTUM_BOOST;
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
        roundToStep(fineStartValueRef.current - (deltaY / ITEM_H) * fineStep, min, fineStep),
        min,
        max,
      );
      commitValue(next, fineStep);
      return;
    }

    const delta = event.clientY - startYRef.current;
    const steps = Math.round(delta / ITEM_H);
    const nextIndex = clamp(indexOf(startValueRef.current) - steps, 0, values.length - 1);
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
      runMomentum(indexRef.current, -v);
    } else {
      commitIndex(indexRef.current);
    }
  };

  // Pad with nulls so the active value can sit in the centre selection band at edges.
  const visible: Slot[] = useMemo(() => {
    const slots: Slot[] = [];
    for (let offset = pad; offset >= -pad; offset--) {
      const index = selectedIndex + offset;
      slots.push(index >= 0 && index < values.length ? values[index] : null);
    }
    return slots;
  }, [pad, selectedIndex, values]);

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
        onWheel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          stopMomentum();
          const steps = Math.sign(event.deltaY);
          if (!steps) return;
          commitIndex(clamp(selectedIndex - steps, 0, values.length - 1));
        }}
        onKeyDown={(event) => {
          const keyStep = fineMode ? fineStep : step;
          const bump = (dir: 1 | -1) => {
            if (fineMode) commitValue(clamped + dir * keyStep, keyStep);
            else {
              const next = clamp(
                Math.trunc(clamped) + dir * keyStep + fracPart(clamped),
                min,
                max,
              );
              onChangeRef.current(next);
            }
          };
          if (event.key === "ArrowDown") {
            event.preventDefault();
            bump(-1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            bump(1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            bump(1);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            bump(-1);
          } else if (event.key === "Home") {
            event.preventDefault();
            onChangeRef.current(min);
          } else if (event.key === "End") {
            event.preventDefault();
            onChangeRef.current(max);
          }
        }}
      >
        <div className="lc-number-wheel-fade lc-number-wheel-fade-top" aria-hidden />
        <div className="lc-number-wheel-window" aria-hidden>
          {visible.map((entry, slotIndex) => {
            if (entry == null) {
              return (
                <div
                  key={`pad-${slotIndex}`}
                  className="lc-number-wheel-item lc-number-wheel-item-pad"
                />
              );
            }
            const active = Math.abs(entry - clamped) < listStep * 0.25 + 1e-9;
            return (
              <div
                key={`${fineMode ? "f" : "c"}-${entry}-${slotIndex}`}
                className={
                  active ? "lc-number-wheel-item lc-number-wheel-item-active" : "lc-number-wheel-item"
                }
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
