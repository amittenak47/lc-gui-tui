import { NumberWheel } from "./NumberWheel";

export interface InkFullnessSliderProps {
  value: number;
  onChange: (value: number) => void;
}

/**
 * Toolbar ink dial — how much ink the nib is charged with (0–100%).
 *
 * Not an opacity. Every stroke starts full and fades with how far it has
 * written; this sets how long the charge lasts, and lifting the pen dips it
 * back in. At 100% the nib does not dry at all.
 */
export function InkFullnessSlider({ value, onChange }: InkFullnessSliderProps) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <NumberWheel
      value={percent}
      onChange={(next) => onChange(next / 100)}
      min={0}
      max={100}
      step={5}
      label="Ink"
      format={(v) => `${v}%`}
    />
  );
}
