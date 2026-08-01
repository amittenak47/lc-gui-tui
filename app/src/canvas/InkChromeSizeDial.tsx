import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from "react";

import { ERASER_WIDTH_MAX, STROKE_WIDTH_MAX, STROKE_WIDTH_MIN } from "./rasterInk";

export interface InkChromeSizeDialProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  eraser?: boolean;
}

const DIAL = 38;
const RADIUS = 12;
const SWEEP = Math.PI * 1.5; // 270°
const START = -Math.PI * 0.75; // from lower-left

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function valueToAngle(value: number, min: number, max: number): number {
  const t = (clamp(value, min, max) - min) / Math.max(0.001, max - min);
  return START + t * SWEEP;
}

function angleToValue(angle: number, min: number, max: number): number {
  // Progress along the arc from START. Dead-zone angles clamp to the nearer
  // endpoint — never wrap past max back to min (or vice versa).
  let delta = angle - START;
  while (delta < 0) delta += Math.PI * 2;
  while (delta >= Math.PI * 2) delta -= Math.PI * 2;

  let t: number;
  if (delta <= SWEEP) {
    t = delta / SWEEP;
  } else {
    const distPastEnd = delta - SWEEP;
    const distToStart = Math.PI * 2 - delta;
    t = distPastEnd <= distToStart ? 1 : 0;
  }
  return min + t * (max - min);
}

function pointerAngle(clientX: number, clientY: number, rect: DOMRect): number {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return Math.atan2(clientY - cy, clientX - cx);
}

/** Compact radial size dial for the near-pen chrome. */
export function InkChromeSizeDial({
  value,
  onChange,
  label,
  eraser = false,
}: InkChromeSizeDialProps) {
  const max = eraser ? ERASER_WIDTH_MAX : STROKE_WIDTH_MAX;
  const min = STROKE_WIDTH_MIN;
  const clamped = clamp(value, min, max);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const angle = valueToAngle(clamped, min, max);
  const knobX = DIAL / 2 + Math.cos(angle) * RADIUS;
  const knobY = DIAL / 2 + Math.sin(angle) * RADIUS;

  const track = (() => {
    const x0 = DIAL / 2 + Math.cos(START) * RADIUS;
    const y0 = DIAL / 2 + Math.sin(START) * RADIUS;
    const x1 = DIAL / 2 + Math.cos(START + SWEEP) * RADIUS;
    const y1 = DIAL / 2 + Math.sin(START + SWEEP) * RADIUS;
    return `M ${x0} ${y0} A ${RADIUS} ${RADIUS} 0 1 1 ${x1} ${y1}`;
  })();

  const applyPointer = useCallback(
    (clientX: number, clientY: number) => {
      const node = rootRef.current;
      if (!node) return;
      const next = angleToValue(pointerAngle(clientX, clientY, node.getBoundingClientRect()), min, max);
      onChange(Math.round(next * 10) / 10);
    },
    [max, min, onChange],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    applyPointer(event.clientX, event.clientY);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    applyPointer(event.clientX, event.clientY);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = eraser ? 2 : 0.5;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      onChange(clamp(clamped + step, min, max));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      onChange(clamp(clamped - step, min, max));
    }
  };

  return (
    <div
      ref={rootRef}
      className={eraser ? "lc-ink-chrome-dial is-eraser" : "lc-ink-chrome-dial"}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={clamped}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <svg viewBox={`0 0 ${DIAL} ${DIAL}`} width={DIAL} height={DIAL} aria-hidden>
        <path className="lc-ink-chrome-dial-track" d={track} fill="none" />
        <path
          className="lc-ink-chrome-dial-fill"
          d={`M ${DIAL / 2 + Math.cos(START) * RADIUS} ${DIAL / 2 + Math.sin(START) * RADIUS} A ${RADIUS} ${RADIUS} 0 ${
            angle - START > Math.PI ? 1 : 0
          } 1 ${knobX} ${knobY}`}
          fill="none"
        />
        <circle className="lc-ink-chrome-dial-knob" cx={knobX} cy={knobY} r={3.5} />
        <circle className="lc-ink-chrome-dial-core" cx={DIAL / 2} cy={DIAL / 2} r={eraser ? 7 : 5.5} />
        <text className="lc-ink-chrome-dial-value" x={DIAL / 2} y={DIAL / 2 + 2.5} textAnchor="middle">
          {Number.isInteger(clamped) ? clamped : clamped.toFixed(1)}
        </text>
      </svg>
    </div>
  );
}
