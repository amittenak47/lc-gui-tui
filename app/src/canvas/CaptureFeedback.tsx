/**
 * What a capture looks like while it happens.
 *
 * Before this, taking a shot was silent: the board froze for a beat, an image
 * appeared, and whether a PNG had been written — and where — was something you
 * found out by going to look. Three states now cover it: a countdown you can
 * skip, a shutter flash at the moment of the export, and a toast naming where
 * the file went.
 *
 * Imperative, like {@link EraserBrush}: the countdown ticks once a second and
 * has no business re-rendering Board, which owns the ink layer's callbacks.
 */

import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";

export interface CaptureFeedbackHandle {
  /**
   * Count down from `seconds`, resolving when it reaches zero. Resolves at once
   * when `seconds` is 0. Tapping skips the rest; Escape cancels and resolves
   * `false`.
   */
  countdown(seconds: number, label?: string): Promise<boolean>;
  /** White flash over the board — the shutter. */
  flash(): void;
  /** Bottom toast. `tone` picks the accent. */
  toast(message: string, tone?: "ok" | "error"): void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "countdown"; remaining: number; label: string }
  | { kind: "flash" };

export const CaptureFeedback = forwardRef<CaptureFeedbackHandle, Record<never, never>>(
  function CaptureFeedback(_props, ref) {
    const [phase, setPhase] = useState<Phase>({ kind: "idle" });
    const [message, setMessage] = useState<{ text: string; tone: "ok" | "error" } | null>(
      null,
    );
    const timersRef = useRef<number[]>([]);
    /** Resolver for the countdown in flight, so a tap or Escape can end it. */
    const settleRef = useRef<((finished: boolean) => void) | null>(null);

    const clearTimers = useCallback(() => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
      timersRef.current = [];
    }, []);

    const endCountdown = useCallback(
      (finished: boolean) => {
        clearTimers();
        setPhase({ kind: "idle" });
        const settle = settleRef.current;
        settleRef.current = null;
        settle?.(finished);
      },
      [clearTimers],
    );

    useImperativeHandle(
      ref,
      (): CaptureFeedbackHandle => ({
        countdown(seconds, label = "Capturing") {
          // A previous countdown still up would otherwise resolve twice.
          if (settleRef.current) endCountdown(false);
          if (seconds <= 0) return Promise.resolve(true);
          setMessage(null);
          setPhase({ kind: "countdown", remaining: seconds, label });
          return new Promise<boolean>((resolve) => {
            settleRef.current = resolve;
            for (let step = 1; step <= seconds; step++) {
              const left = seconds - step;
              timersRef.current.push(
                window.setTimeout(() => {
                  if (left > 0) {
                    setPhase({ kind: "countdown", remaining: left, label });
                  } else {
                    endCountdown(true);
                  }
                }, step * 1000),
              );
            }
          });
        },
        flash() {
          setPhase({ kind: "flash" });
          timersRef.current.push(
            window.setTimeout(() => {
              setPhase((current) => (current.kind === "flash" ? { kind: "idle" } : current));
            }, 220),
          );
        },
        toast(text, tone = "ok") {
          setMessage({ text, tone });
          timersRef.current.push(
            window.setTimeout(() => setMessage(null), tone === "error" ? 6_000 : 3_600),
          );
        },
      }),
      [endCountdown],
    );

    return (
      <>
        {phase.kind === "countdown" && (
          <div
            className="lc-capture-countdown"
            role="status"
            aria-live="assertive"
            // Tap anywhere to shoot now; the countdown is a courtesy, not a gate.
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              endCountdown(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") endCountdown(false);
            }}
            tabIndex={-1}
          >
            <div className="lc-capture-countdown-ring">
              <span className="lc-capture-countdown-number">{phase.remaining}</span>
            </div>
            <div className="lc-capture-countdown-label">{phase.label}</div>
            <div className="lc-capture-countdown-hint">Tap to shoot now · Esc cancels</div>
          </div>
        )}
        {phase.kind === "flash" && <div className="lc-capture-flash" aria-hidden />}
        {message && (
          <div
            className={
              message.tone === "error"
                ? "lc-capture-toast is-error"
                : "lc-capture-toast"
            }
            role="status"
            aria-live="polite"
          >
            {message.text}
          </div>
        )}
      </>
    );
  },
);
