/** Vertical slider for the text tool's font size (canvas units / px). */

export const TEXT_FONT_MIN = 12;
export const TEXT_FONT_MAX = 48;
export const TEXT_FONT_STEP = 1;

export interface FontSizeSliderProps {
  value: number;
  onChange: (value: number) => void;
}

export function FontSizeSlider({ value, onChange }: FontSizeSliderProps) {
  const clamped = Math.min(TEXT_FONT_MAX, Math.max(TEXT_FONT_MIN, Math.round(value)));
  return (
    <div className="lc-stroke-slider" role="group" aria-label="Font size">
      <span className="lc-stroke-slider-cap" aria-hidden>
        {TEXT_FONT_MAX}
      </span>
      <input
        type="range"
        className="lc-stroke-slider-input lc-tip-target"
        min={TEXT_FONT_MIN}
        max={TEXT_FONT_MAX}
        step={TEXT_FONT_STEP}
        value={clamped}
        data-tip={`Font size ${clamped}px`}
        data-tip-placement="right"
        aria-label="Font size"
        aria-valuemin={TEXT_FONT_MIN}
        aria-valuemax={TEXT_FONT_MAX}
        aria-valuenow={clamped}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="lc-stroke-slider-cap" aria-hidden>
        {TEXT_FONT_MIN}
      </span>
      <span className="lc-stroke-slider-value" aria-hidden>
        {clamped}
      </span>
    </div>
  );
}
