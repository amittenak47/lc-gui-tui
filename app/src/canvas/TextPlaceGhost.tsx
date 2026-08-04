/**
 * On-canvas ghost for the text tool — dashed box under the pointer so the
 * placement spot is visible before the wysiwyg opens (selection-tool style).
 *
 * Imperative like {@link EraserBrush}: pointermove must not re-render Board.
 */

import { forwardRef, useImperativeHandle, useRef } from "react";

export interface TextPlaceGhostHandle {
  /** Top-left of the ghost, CSS px from `.lc-board` origin. */
  move(x: number, y: number): void;
  setVisible(visible: boolean): void;
  /** Screen-pixel size of the preview box. */
  setSize(width: number, height: number): void;
}

export type TextPlaceGhostProps = Record<never, never>;

export const TextPlaceGhost = forwardRef<TextPlaceGhostHandle, TextPlaceGhostProps>(
  function TextPlaceGhost(_props, ref) {
    const nodeRef = useRef<HTMLDivElement | null>(null);

    useImperativeHandle(
      ref,
      (): TextPlaceGhostHandle => ({
        move(x, y) {
          const node = nodeRef.current;
          if (!node) return;
          node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        },
        setVisible(visible) {
          const node = nodeRef.current;
          if (!node) return;
          node.style.display = visible ? "block" : "none";
        },
        setSize(width, height) {
          const node = nodeRef.current;
          if (!node) return;
          const w = `${Math.max(24, Math.round(width))}px`;
          const h = `${Math.max(16, Math.round(height))}px`;
          if (node.style.width === w && node.style.height === h) return;
          node.style.width = w;
          node.style.height = h;
        },
      }),
      [],
    );

    return (
      <div
        ref={nodeRef}
        className="lc-text-place-ghost"
        aria-hidden
        style={{ display: "none" }}
      />
    );
  },
);
