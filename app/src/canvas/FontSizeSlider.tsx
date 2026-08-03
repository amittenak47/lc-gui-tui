/**
 * Font-size control for the text tool. Uses an iOS-style number wheel so
 * pointerdown can preventDefault and keep an open text box focused.
 */

import { NumberWheel } from "./NumberWheel";

export const TEXT_FONT_MIN = 12;
export const TEXT_FONT_MAX = 48;
export const TEXT_FONT_STEP = 1;

export interface FontSizeSliderProps {
  value: number;
  onChange: (value: number) => void;
}

export function FontSizeSlider({ value, onChange }: FontSizeSliderProps) {
  return (
    <NumberWheel
      value={value}
      onChange={onChange}
      min={TEXT_FONT_MIN}
      max={TEXT_FONT_MAX}
      step={TEXT_FONT_STEP}
      allowFineScrub
      label="Font size"
      format={(n) => String(Math.round(n))}
    />
  );
}
