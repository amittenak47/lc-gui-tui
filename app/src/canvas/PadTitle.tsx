/**
 * Movie-bold pad title — top-left of the board, ScratchPad open only.
 *
 * Center `ModeIndicator` stays for Annotation / Scroll. Opening a notebook
 * should not steal the middle of the page; a brief corner title is enough.
 *
 * Does not wait on status banners — those belong to first-open / Agent, not
 * every tab switch.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/** Hold long enough to read the notebook name, then fade. */
export const PAD_TITLE_HOLD_MS = 1800;

export interface PadTitleHandle {
  /** Show a title, restarting the fade. */
  show(label: string, holdMs?: number): void;
}

export type PadTitleProps = Record<never, never>;

export const PadTitle = forwardRef<PadTitleHandle, PadTitleProps>(
  function PadTitle(_props, ref) {
    const nodeRef = useRef<HTMLDivElement | null>(null);
    const timerRef = useRef<number>(0);
    const showGenRef = useRef(0);

    useEffect(
      () => () => {
        showGenRef.current += 1;
        if (timerRef.current) window.clearTimeout(timerRef.current);
      },
      [],
    );

    useImperativeHandle(
      ref,
      (): PadTitleHandle => ({
        show(label, holdMs = PAD_TITLE_HOLD_MS) {
          const gen = ++showGenRef.current;
          const node = nodeRef.current;
          if (!node) return;
          node.textContent = label;
          node.classList.add("is-visible");
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => {
            timerRef.current = 0;
            if (gen !== showGenRef.current) return;
            nodeRef.current?.classList.remove("is-visible");
          }, holdMs);
        },
      }),
      [],
    );

    return <div ref={nodeRef} className="lc-pad-title" aria-hidden />;
  },
);
