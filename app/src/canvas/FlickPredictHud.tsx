/**
 * Chrome readout for flick-end prediction vs live PDF page.
 *
 * Imperative like PageIndicator — Board must not re-render per pan sample.
 * Display only. Paint / wanted / LRU must not read this.
 */

import { forwardRef, useImperativeHandle, useRef } from "react";

export interface FlickPredictHudHandle {
  show(live: number, pred: number, err: number): void;
  hide(): void;
}

export const FlickPredictHud = forwardRef<FlickPredictHudHandle, Record<never, never>>(
  function FlickPredictHud(_props, ref) {
    const nodeRef = useRef<HTMLDivElement | null>(null);
    const lastRef = useRef({ live: -1, pred: -1, err: Number.NaN });

    useImperativeHandle(
      ref,
      (): FlickPredictHudHandle => ({
        show(live, pred, err) {
          const node = nodeRef.current;
          if (!node) return;
          const prev = lastRef.current;
          if (prev.live === live && prev.pred === pred && prev.err === err) return;
          lastRef.current = { live, pred, err };
          const errText = err === 0 ? "0" : err > 0 ? `+${err}` : String(err);
          node.textContent = `live ${live}  pred ${pred}  err ${errText}`;
          node.hidden = false;
        },
        hide() {
          const node = nodeRef.current;
          if (!node) return;
          lastRef.current = { live: -1, pred: -1, err: Number.NaN };
          node.hidden = true;
          node.textContent = "";
        },
      }),
      [],
    );

    return (
      <div
        ref={nodeRef}
        className="lc-flick-predict-hud"
        hidden
        aria-hidden
      />
    );
  },
);
