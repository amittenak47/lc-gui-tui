import { NumberWheel } from "./NumberWheel";

export interface InkFullnessSliderProps {
  value: number;
  onChange: (value: number) => void;
}

/** Toolbar ink dial — max opacity/density (0–100%). */
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
