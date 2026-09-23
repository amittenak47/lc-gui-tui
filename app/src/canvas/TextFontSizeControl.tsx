import { NumberWheel } from "./NumberWheel";
import { TEXT_FONT_MIN, TEXT_FONT_MAX } from "./FontSizeSlider";

/** Same drag, scroll and flick control as the preset editor's nib size. */
export function TextFontSizeControl({ value, onChange, label }: {
  value: number; onChange: (size: number) => void; label: string;
}) {
  return <div className="lc-scene-text-size" onKeyDown={(event) => {
    if (event.key !== "Escape" && event.key !== "Enter") event.stopPropagation();
  }}>
    <NumberWheel value={value} onChange={onChange} min={TEXT_FONT_MIN} max={TEXT_FONT_MAX}
      step={1} allowFineScrub fineStep={1} label={label} format={(size) => String(Math.round(size))} />
  </div>;
}
