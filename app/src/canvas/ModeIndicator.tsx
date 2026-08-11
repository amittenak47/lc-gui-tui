/**
 * Brief mode toast — "Annotation" or "Scroll mode" when the toolbar toggles.
 *
 * Same imperative pattern as the old zoom readout: Board is heavy and a React
 * re-render per toggle would be wasted work. The node mounts once; the caller
 * pushes label text and visibility straight onto it.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/**
 * How long the pill lingers after the last show.
 *
 * Tuned for a mode toggle, where the reader already knows what they just did
 * and the pill is confirming it. A label that is *telling* them something —
 * which notebook they have opened — needs longer to be read at all, so callers
 * can ask for it.
 */
const HOLD_MS = 620;
export const ANNOUNCE_HOLD_MS = 1600;

export interface ModeIndicatorHandle {
  /** Show a label, restarting the fade. */
  show(label: string, holdMs?: number): void;
}

export type ModeIndicatorProps = Record<never, never>;

export const ModeIndicator = forwardRef<ModeIndicatorHandle, ModeIndicatorProps>(
  function ModeIndicator(_props, ref) {
    const nodeRef = useRef<HTMLDivElement | null>(null);
    const timerRef = useRef<number>(0);

    useEffect(
      () => () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
      },
      [],
    );

    useImperativeHandle(
      ref,
      (): ModeIndicatorHandle => ({
        show(label, holdMs = HOLD_MS) {
          const node = nodeRef.current;
          if (!node) return;
          node.textContent = label;
          node.classList.add("is-visible");
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => {
            timerRef.current = 0;
            nodeRef.current?.classList.remove("is-visible");
          }, holdMs);
        },
      }),
      [],
    );

    return <div ref={nodeRef} className="lc-mode-indicator" aria-hidden />;
  },
);
