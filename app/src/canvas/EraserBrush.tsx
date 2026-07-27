/**
 * On-canvas eraser preview — circle + crosshair, sized in screen pixels.
 *
 * Mirrors Excalidraw's `setEraserCursor` (filled circle with outline) but scales
 * with our Thin/Bold/Heavy presets and adds crosshair lines like the pen tool.
 */

export interface EraserBrushProps {
  visible: boolean;
  /** CSS px from left of `.lc-canvas-wrap`. */
  x: number;
  /** CSS px from top of `.lc-canvas-wrap`. */
  y: number;
  /** Brush diameter in screen pixels. */
  diameter: number;
}

export function EraserBrush({ visible, x, y, diameter }: EraserBrushProps) {
  if (!visible) return null;
  const size = Math.max(8, Math.round(diameter));
  return (
    <div
      className="lc-eraser-brush"
      aria-hidden
      style={{
        left: x,
        top: y,
        width: size,
        height: size,
      }}
    />
  );
}
