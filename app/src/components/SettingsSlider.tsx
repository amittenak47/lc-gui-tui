/**
 * Settings range: the ball sits on the track ends at min and max.
 * Native &lt;input type="range"&gt; keeps the thumb inset; we paint our own.
 */

export function SettingsSlider({
  label,
  min,
  max,
  step,
  value,
  display,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display?: string;
  onChange: (next: number) => void;
}) {
  const t = (value - min) / Math.max(1e-6, max - min);
  return (
    <div className="lc-settings-slider">
      <span
        className="lc-settings-slider-hit"
        style={{ ["--lc-slider-t" as string]: String(Math.min(1, Math.max(0, t))) }}
      >
        <span className="lc-settings-slider-track">
          <span className="lc-settings-slider-fill" />
          <span className="lc-settings-slider-thumb" />
        </span>
        <input
          className="lc-settings-slider-input"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </span>
      <span className="lc-settings-slider-value">{display ?? `${value}%`}</span>
    </div>
  );
}
