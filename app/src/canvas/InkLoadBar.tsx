/**
 * 5px load bar on the ink canvas. Imperative — Board must not re-render per
 * live paint. One instance per RasterInkLayer so a split tab keeps its own bar.
 *
 * The call-count overlay stays after lift so you can read it; the next
 * stroke's first {@link InkLoadBarHandle.show} resets the numbers.
 */

import { forwardRef, useImperativeHandle, useRef } from "react";

import {
  formatInkLoadDebug,
  type InkLoadSnapshot,
} from "./inkLoadMeter";

export interface InkLoadBarHandle {
  show(snap: InkLoadSnapshot): void;
  /** Keep the last readout on screen; the next {@link show} resets it. */
  freeze(): void;
}

export const InkLoadBar = forwardRef<InkLoadBarHandle, Record<never, never>>(
  function InkLoadBar(_props, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const fillRef = useRef<HTMLDivElement | null>(null);
    const hintRef = useRef<HTMLDivElement | null>(null);
    const debugRef = useRef<HTMLPreElement | null>(null);
    const lastPctRef = useRef(-1);
    const lastLiftRef = useRef(false);
    const lastDebugRef = useRef("");

    useImperativeHandle(
      ref,
      (): InkLoadBarHandle => ({
        show(snap) {
          const root = rootRef.current;
          const fill = fillRef.current;
          const hint = hintRef.current;
          const debug = debugRef.current;
          if (!root || !fill || !hint || !debug) return;
          const clamped = snap.level <= 0 ? 0 : snap.level >= 1 ? 1 : snap.level;
          fill.style.transform = `scaleX(${clamped})`;
          fill.style.background = `hsl(${Math.round(120 * (1 - clamped))} 78% 42%)`;
          root.hidden = false;
          root.classList.add("is-open");
          root.classList.toggle("is-lift", snap.lift);
          const pct = Math.round(clamped * 20) * 5;
          if (pct !== lastPctRef.current) {
            lastPctRef.current = pct;
            root.setAttribute("aria-valuenow", String(pct));
          }
          if (snap.lift && !lastLiftRef.current) {
            hint.hidden = false;
            root.setAttribute("aria-valuetext", "Lift pen");
          } else if (!snap.lift && lastLiftRef.current) {
            hint.hidden = true;
            root.removeAttribute("aria-valuetext");
          }
          lastLiftRef.current = snap.lift;
          const text = formatInkLoadDebug(snap);
          if (text !== lastDebugRef.current) {
            lastDebugRef.current = text;
            debug.textContent = text;
          }
          debug.hidden = false;
        },
        freeze() {
          const root = rootRef.current;
          const hint = hintRef.current;
          if (!root || !hint) return;
          lastLiftRef.current = false;
          root.classList.remove("is-lift");
          hint.hidden = true;
          root.removeAttribute("aria-valuetext");
        },
      }),
      [],
    );

    return (
      <div
        ref={rootRef}
        className="lc-ink-load-bar"
        hidden
        role="progressbar"
        aria-label="Ink load"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={0}
      >
        <div className="lc-ink-load-bar-track">
          <div ref={fillRef} className="lc-ink-load-bar-fill" />
        </div>
        <div ref={hintRef} className="lc-ink-load-bar-hint" hidden>
          Lift pen
        </div>
        <pre ref={debugRef} className="lc-ink-load-bar-debug" hidden />
      </div>
    );
  },
);
