import { STROKE_WIDTH_MAX, STROKE_WIDTH_MIN } from "./rasterInk";

export interface StrokeSizeSliderProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
}

export function StrokeSizeSlider({ value, onChange, label }: StrokeSizeSliderProps) {
  return (
    <div className="lc-stroke-slider" role="group" aria-label={label}>
      <span className="lc-stroke-slider-cap" aria-hidden>
        {STROKE_WIDTH_MAX}
      </span>
      <input
        type="range"
        className="lc-stroke-slider-input lc-tip-target"
        min={STROKE_WIDTH_MIN}
        max={STROKE_WIDTH_MAX}
        step={0.5}
        value={value}
        data-tip={label}
        data-tip-placement="right"
        aria-label={label}
        aria-valuemin={STROKE_WIDTH_MIN}
        aria-valuemax={STROKE_WIDTH_MAX}
        aria-valuenow={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="lc-stroke-slider-cap" aria-hidden>
        {STROKE_WIDTH_MIN}
      </span>
      <span className="lc-stroke-slider-value" aria-hidden>
        {Number.isInteger(value) ? value : value.toFixed(1)}
      </span>
    </div>
  );
}
