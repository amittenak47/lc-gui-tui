import { NumberWheel } from "./NumberWheel";

export interface InkFullnessSliderProps {
  value: number;
  onChange: (value: number) => void;
  /** Off locks the dial at 100% — paint already treats pressure-off as never-dry. */
  enabled?: boolean;
}

/**
 * Toolbar ink dial — how much ink the nib is charged with (0–100%).
 *
 * Not an opacity. Every stroke starts full and fades with how far it has
 * written; this sets how long the charge lasts, and lifting the pen dips it
 * back in. At 100% the nib does not dry at all.
 *
 * Only meaningful with pressure on. Pressure-off paint uses fullness 1, so the
 * dial shows 100% and ignores edits until pressure is on again. The stored
 * value is left alone so turning pressure back on restores it.
 */
export function InkFullnessSlider({
  value,
  onChange,
  enabled = true,
}: InkFullnessSliderProps) {
  const percent = Math.round(Math.max(0, Math.min(1, enabled ? value : 1)) * 100);
  return (
    <NumberWheel
      value={percent}
      onChange={(next) => onChange(next / 100)}
      min={0}
      max={100}
      step={5}
      label="Ink"
      format={(v) => `${v}%`}
      enabled={enabled}
    />
  );
}
