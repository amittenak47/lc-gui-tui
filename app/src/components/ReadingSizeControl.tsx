/**
 * S / M / L reading size — map chrome, stacked above zoom.
 */

import {
  BOARD_READING_SIZES,
  type BoardReadingSize,
} from "../modes/codeFontSize";

export interface ReadingSizeControlProps {
  value: BoardReadingSize;
  onChange: (size: BoardReadingSize) => void;
}

export function ReadingSizeControl({ value, onChange }: ReadingSizeControlProps) {
  return (
    <div className="lc-reading-size" role="group" aria-label="Text size">
      {BOARD_READING_SIZES.map((size) => (
        <button
          key={size}
          type="button"
          className={size === value ? "lc-map-btn is-active" : "lc-map-btn"}
          title={`Text size ${size}`}
          aria-pressed={size === value}
          aria-label={`Text size ${size}`}
          onClick={() => onChange(size)}
        >
          {size}
        </button>
      ))}
    </div>
  );
}
