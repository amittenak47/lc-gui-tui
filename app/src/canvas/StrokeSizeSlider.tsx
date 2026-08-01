import { ERASER_WIDTH_MAX, STROKE_WIDTH_MAX, STROKE_WIDTH_MIN } from "./rasterInk";

export interface StrokeSizeSliderProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  /** When true, use the wider eraser range. */
  eraser?: boolean;
}

export function StrokeSizeSlider({ value, onChange, label, eraser = false }: StrokeSizeSliderProps) {
  const max = eraser ? ERASER_WIDTH_MAX : STROKE_WIDTH_MAX;
  const clamped = Math.min(max, Math.max(STROKE_WIDTH_MIN, value));
  return (
    <div className="lc-stroke-slider" role="group" aria-label={label}>
      <span className="lc-stroke-slider-cap" aria-hidden>
        {STROKE_WIDTH_MIN}
      </span>
      <input
        type="range"
        className="lc-stroke-slider-input"
        min={STROKE_WIDTH_MIN}
        max={max}
        step={0.1}
        value={clamped}
        aria-label={label}
        aria-valuemin={STROKE_WIDTH_MIN}
        aria-valuemax={max}
        aria-valuenow={clamped}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="lc-stroke-slider-cap" aria-hidden>
        {max}
      </span>
      <span className="lc-stroke-slider-value" aria-hidden>
        {Number.isInteger(clamped) ? clamped : clamped.toFixed(1)}
      </span>
    </div>
  );
}
