import { ERASER_WIDTH_MAX, STROKE_WIDTH_MAX, STROKE_WIDTH_MIN } from "./rasterInk";
import { NumberWheel } from "./NumberWheel";

export interface StrokeSizeSliderProps {
  value: number;
  onChange: (value: number) => void;
  label: string;
  /** When true, use the wider eraser range. */
  eraser?: boolean;
}

export function StrokeSizeSlider({ value, onChange, label, eraser = false }: StrokeSizeSliderProps) {
  const max = eraser ? ERASER_WIDTH_MAX : STROKE_WIDTH_MAX;
  // Eraser spans 1–384; 0.5 keeps the wheel usable without feeling twitchy.
  const step = eraser ? 0.5 : 0.1;
  return (
    <NumberWheel
      value={value}
      onChange={onChange}
      min={STROKE_WIDTH_MIN}
      max={max}
      step={step}
      label={label}
    />
  );
}
