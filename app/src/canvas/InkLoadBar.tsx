/**
 * 5px load bar on the ink canvas. Imperative — Board must not re-render per
 * live paint. One instance per ink host so a split tab keeps its own bar.
 *
 * Overlay HUD and load bar are independent Settings toggles. The next
 * stroke's first {@link InkLoadBarHandle.show} resets the numbers.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { formatInkLabHud, type InkLabHud } from "./inkLab/hud";
import { drawFrameSpark } from "./inkLab/hudSpark";
import { type InkLoadSnapshot } from "./inkLoadMeter";

export interface InkLoadBarHandle {
  show(snap: InkLoadSnapshot, hud?: InkLabHud): void;
  /** Keep the last readout on screen; the next {@link show} resets it. */
  freeze(): void;
  /** Hide the bar and HUD. */
  hide(): void;
}

export type InkLoadBarProps = {
  /** 5px load bar + lift hint. */
  bar?: boolean;
  /** Frame HUD + frame-time spark. */
  overlay?: boolean;
};

export const InkLoadBar = forwardRef<InkLoadBarHandle, InkLoadBarProps>(
  function InkLoadBar({ bar = true, overlay = true }, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const fillRef = useRef<HTMLDivElement | null>(null);
    const trackRef = useRef<HTMLDivElement | null>(null);
    const hintRef = useRef<HTMLDivElement | null>(null);
    const stackRef = useRef<HTMLDivElement | null>(null);
    const debugRef = useRef<HTMLPreElement | null>(null);
    const sparkRef = useRef<HTMLCanvasElement | null>(null);
    const lastPctRef = useRef(-1);
    const lastLiftRef = useRef(false);
    const lastDebugRef = useRef("");
    const barRef = useRef(bar);
    const overlayRef = useRef(overlay);
    barRef.current = bar;
    overlayRef.current = overlay;

    const syncChrome = () => {
      const root = rootRef.current;
      const track = trackRef.current;
      const hint = hintRef.current;
      const stack = stackRef.current;
      const debug = debugRef.current;
      const spark = sparkRef.current;
      if (!root || !track || !hint || !stack || !debug) return;
      const showBar = barRef.current;
      const showHud = overlayRef.current;
      if (!showBar && !showHud) {
        root.hidden = true;
        root.classList.remove("is-open", "is-lift");
        track.hidden = true;
        hint.hidden = true;
        stack.hidden = true;
        debug.hidden = true;
        if (spark) spark.hidden = true;
        return;
      }
      root.hidden = false;
      root.classList.toggle("is-open", showBar);
      root.classList.toggle("is-hud", showHud);
      track.hidden = !showBar;
      stack.hidden = !showHud;
      debug.hidden = !showHud;
      if (spark) spark.hidden = !showHud;
      if (!showBar) {
        hint.hidden = true;
        root.classList.remove("is-lift");
        root.removeAttribute("aria-valuetext");
      }
    };

    useEffect(() => {
      syncChrome();
    }, [bar, overlay]);

    useImperativeHandle(
      ref,
      (): InkLoadBarHandle => ({
        show(snap, hud) {
          const root = rootRef.current;
          const fill = fillRef.current;
          const hint = hintRef.current;
          const debug = debugRef.current;
          const spark = sparkRef.current;
          if (!root || !fill || !hint || !debug) return;
          syncChrome();
          if (!barRef.current && !overlayRef.current) return;
          const clamped = snap.level <= 0 ? 0 : snap.level >= 1 ? 1 : snap.level;
          if (barRef.current) {
            fill.style.transform = `scaleX(${clamped})`;
            fill.style.background = `hsl(${Math.round(120 * (1 - clamped))} 78% 42%)`;
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
            root.classList.toggle("is-lift", snap.lift);
          }
          if (!overlayRef.current) return;
          const text = hud
            ? formatInkLabHud(hud)
            : formatInkLabHud({
                backend: snap.backend,
                paints: snap.calls,
                frameMs: snap.frameMs,
                rafMs: snap.rafMs,
                pts: snap.spineN,
                segs: snap.segs,
                ekfMs: snap.ekfMs,
                drawMs: snap.drawMs,
                hold: snap.hold,
                suffix: snap.suffixHit,
                bakeMs: 0,
                bake: "catmull",
              });
          if (text !== lastDebugRef.current) {
            lastDebugRef.current = text;
            debug.textContent = text;
          }
          if (spark) drawFrameSpark(spark, hud?.spark ?? []);
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
        hide() {
          const root = rootRef.current;
          const hint = hintRef.current;
          const debug = debugRef.current;
          const spark = sparkRef.current;
          if (!root || !hint) return;
          lastLiftRef.current = false;
          lastPctRef.current = -1;
          lastDebugRef.current = "";
          root.hidden = true;
          root.classList.remove("is-open", "is-lift", "is-hud");
          hint.hidden = true;
          root.removeAttribute("aria-valuetext");
          if (debug) debug.hidden = true;
          if (spark) {
            spark.hidden = true;
            const ctx = spark.getContext("2d");
            ctx?.clearRect(0, 0, spark.width, spark.height);
          }
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
        <div ref={trackRef} className="lc-ink-load-bar-track">
          <div ref={fillRef} className="lc-ink-load-bar-fill" />
        </div>
        <div ref={hintRef} className="lc-ink-load-bar-hint" hidden>
          Lift pen
        </div>
        <div ref={stackRef} className="lc-ink-perf-stack" hidden>
          <pre ref={debugRef} className="lc-ink-lab-hud" hidden />
          <canvas
            ref={sparkRef}
            className="lc-ink-lab-spark"
            width={168}
            height={36}
            hidden
            aria-hidden="true"
          />
        </div>
      </div>
    );
  },
);
