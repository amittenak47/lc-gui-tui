/**
 * The zoom readout — a translucent pill in the middle of the board.
 *
 * Zooming a page of handwriting gives you almost nothing to judge scale by: the
 * ink grows and shrinks, but there is no ruler and no window chrome, so "how far
 * in am I" has no answer until you stop and look at the toolbar. The pill
 * answers it where the eye already is, then gets out of the way.
 *
 * **Why this is imperative**, same as {@link EraserBrush}: a zoom animates at
 * the panel's refresh rate, and driving the readout from React state re-rendered
 * the whole Board subtree on every frame of it — the readout would have been
 * part of what made zooming choppy. The node mounts once and the caller pushes
 * text and opacity straight onto it.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/** How long the pill lingers after the last zoom change. */
const HOLD_MS = 620;

export interface ZoomIndicatorHandle {
  /**
   * Show a percentage, restarting the fade. Cheap enough for every frame of a
   * zoom: it writes one text node and one class, and only when they change.
   */
  show(pct: number): void;
}

export type ZoomIndicatorProps = Record<never, never>;

export const ZoomIndicator = forwardRef<ZoomIndicatorHandle, ZoomIndicatorProps>(
  function ZoomIndicator(_props, ref) {
    const nodeRef = useRef<HTMLDivElement | null>(null);
    const timerRef = useRef<number>(0);
    const shownRef = useRef<number>(-1);

    useEffect(
      () => () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
      },
      [],
    );

    useImperativeHandle(
      ref,
      (): ZoomIndicatorHandle => ({
        show(pct) {
          const node = nodeRef.current;
          if (!node) return;
          // A held zoom button lands on the same rounded percentage for several
          // frames in a row; skip the DOM write on those.
          if (shownRef.current !== pct) {
            shownRef.current = pct;
            node.textContent = `${pct}%`;
          }
          node.classList.add("is-visible");
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => {
            timerRef.current = 0;
            nodeRef.current?.classList.remove("is-visible");
          }, HOLD_MS);
        },
      }),
      [],
    );

    // `aria-hidden`: the zoom controls already announce their level, and a live
    // region that fires on every frame of an animated zoom is a screen-reader
    // denial of service.
    return <div ref={nodeRef} className="lc-zoom-indicator" aria-hidden />;
  },
);
