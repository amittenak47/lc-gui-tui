/**
 * On-canvas eraser preview — circle + crosshair, sized in screen pixels.
 *
 * Mirrors Excalidraw's `setEraserCursor` (filled circle with outline) but scales
 * with our Thin/Bold/Heavy presets and adds crosshair lines like the pen tool.
 *
 * **Why this is imperative.** The ring follows `pointermove`, and a pen emits
 * those at the display's refresh rate. Driving it from React state re-rendered
 * the whole Board subtree on every sample, which is what made the eraser feel
 * slow to draw even though the erase itself was instant. So the node is mounted
 * once (whenever the eraser tool is active) and the caller pushes position and
 * size straight onto its style — no `setState` in the move path.
 */

import { forwardRef, useImperativeHandle, useRef } from "react";

export interface EraserBrushHandle {
  /** CSS px from the top-left of `.lc-board`. */
  move(x: number, y: number): void;
  setVisible(visible: boolean): void;
  /** Brush diameter in screen pixels. */
  setDiameter(diameter: number): void;
}

/** No props by design — everything about the ring is pushed through the handle. */
export type EraserBrushProps = Record<never, never>;

export const EraserBrush = forwardRef<EraserBrushHandle, EraserBrushProps>(
  function EraserBrush(_props, ref) {
    const nodeRef = useRef<HTMLDivElement | null>(null);

    useImperativeHandle(
      ref,
      (): EraserBrushHandle => ({
        move(x, y) {
          const node = nodeRef.current;
          if (!node) return;
          // translate3d first, then the -50% centring: the ring is centred on
          // the pointer and the compositor can keep it off the layout path.
          node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%)`;
        },
        setVisible(visible) {
          const node = nodeRef.current;
          if (!node) return;
          node.style.display = visible ? "block" : "none";
        },
        setDiameter(diameter) {
          const node = nodeRef.current;
          if (!node) return;
          const size = `${Math.max(8, Math.round(diameter))}px`;
          if (node.style.width === size) return;
          node.style.width = size;
          node.style.height = size;
        },
      }),
      [],
    );

    return <div ref={nodeRef} className="lc-eraser-brush" aria-hidden style={{ display: "none" }} />;
  },
);
