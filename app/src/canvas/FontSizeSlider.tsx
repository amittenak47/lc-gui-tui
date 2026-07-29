/**
 * Vertical slider for the text tool's font size (canvas units / px).
 *
 * It drives its own drag instead of letting the browser do it, for one reason:
 * a native range input takes focus on `mousedown`, and taking focus off an open
 * text box is what closes it. On a tablet the touch never moved focus, so
 * resizing while typing worked; with a mouse the box vanished mid-word and the
 * toolbar looked like it had switched tools. Preventing the default on
 * pointerdown keeps the caret where it is — and since that also cancels the
 * browser's own thumb dragging, the value is computed here from the pointer's
 * position along the track.
 *
 * The input is still a real `<input type="range">`, so arrow keys, screen
 * readers, and the value it reports are unchanged.
 */

import { useCallback, useRef } from "react";

export const TEXT_FONT_MIN = 12;
export const TEXT_FONT_MAX = 48;
export const TEXT_FONT_STEP = 1;

export interface FontSizeSliderProps {
  value: number;
  onChange: (value: number) => void;
}

export function FontSizeSlider({ value, onChange }: FontSizeSliderProps) {
  const clamped = clamp(Math.round(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const draggingRef = useRef(false);

  /** Track runs bottom (min) to top (max) — `writing-mode: vertical-lr`. */
  const valueAt = useCallback((clientY: number): number => {
    const node = inputRef.current;
    if (!node) return clamped;
    const rect = node.getBoundingClientRect();
    if (rect.height <= 0) return clamped;
    const fromTop = Math.min(Math.max(clientY - rect.top, 0), rect.height);
    const ratio = 1 - fromTop / rect.height;
    const raw = TEXT_FONT_MIN + ratio * (TEXT_FONT_MAX - TEXT_FONT_MIN);
    return clamp(Math.round(raw / TEXT_FONT_STEP) * TEXT_FONT_STEP);
  }, [clamped]);

  return (
    <div className="lc-stroke-slider" role="group" aria-label="Font size">
      <span className="lc-stroke-slider-cap" aria-hidden>
        {TEXT_FONT_MAX}
      </span>
      <input
        ref={inputRef}
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
        onPointerDown={(event) => {
          // The whole point: no focus change, so an open text box survives.
          event.preventDefault();
          event.stopPropagation();
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          const next = valueAt(event.clientY);
          if (next !== clamped) onChange(next);
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return;
          event.preventDefault();
          const next = valueAt(event.clientY);
          if (next !== clamped) onChange(next);
        }}
        onPointerUp={(event) => {
          draggingRef.current = false;
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {
            /* capture may already be gone */
          }
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
        // Keyboard (and any browser that still fires it) goes through as usual.
        onChange={(event) => onChange(clamp(Number(event.target.value)))}
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

function clamp(size: number): number {
  return Math.min(TEXT_FONT_MAX, Math.max(TEXT_FONT_MIN, size));
}
