/**
 * The frame scrubber.
 *
 * This is the component that satisfies "don't copy-paste the same array five
 * times": a multi-frame program is *one* diagram on the board, and stepping
 * moves it through time. Each step re-renders the same element ids, so the
 * canvas replaces them in place — see {@link ../viz/apply}.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { VizProgram } from "./schema";

export interface TimelineProps {
  program: VizProgram;
  /** Draw the given frame. Called on every step, including the first. */
  onFrame: (frameIndex: number) => void;
  onDismiss?: () => void;
  /** Milliseconds per frame while playing. */
  playbackMs?: number;
}

export function Timeline({ program, onFrame, onDismiss, playbackMs = 1200 }: TimelineProps) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = program.frames.length;

  // Keep the callback in a ref so the playback effect doesn't restart every
  // time the parent re-renders with a new closure.
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const show = useCallback(
    (next: number) => {
      const clamped = Math.min(Math.max(next, 0), total - 1);
      setFrame(clamped);
      onFrameRef.current(clamped);
    },
    [total],
  );

  // Draw frame 0 when the program arrives, and reset if it's replaced.
  useEffect(() => {
    setFrame(0);
    setPlaying(false);
    onFrameRef.current(0);
  }, [program]);

  useEffect(() => {
    if (!playing || total < 2) return;
    const timer = setInterval(() => {
      setFrame((current) => {
        const next = current + 1;
        if (next >= total) {
          setPlaying(false);
          return current;
        }
        onFrameRef.current(next);
        return next;
      });
    }, playbackMs);
    return () => clearInterval(timer);
  }, [playing, total, playbackMs]);

  const current = program.frames[frame];

  return (
    <section className="lc-timeline" aria-label={`Animation: ${program.title || program.id}`}>
      <header className="lc-timeline-head">
        <strong>{program.title || program.id}</strong>
        {onDismiss && (
          <button type="button" className="lc-link" onClick={onDismiss}>
            dismiss
          </button>
        )}
      </header>

      {total > 1 ? (
        <>
          <div className="lc-timeline-controls">
            <button type="button" onClick={() => show(frame - 1)} disabled={frame === 0}>
              ‹ prev
            </button>
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? "pause" : "play"}
            </button>
            <button type="button" onClick={() => show(frame + 1)} disabled={frame === total - 1}>
              next ›
            </button>
            <span className="lc-timeline-count">
              {frame + 1} / {total}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={total - 1}
            value={frame}
            aria-label="Frame"
            onChange={(event) => {
              setPlaying(false);
              show(Number(event.target.value));
            }}
          />
        </>
      ) : (
        <p className="lc-muted">single frame</p>
      )}

      {current && (
        <div className="lc-timeline-frame">
          {current.label && <div className="lc-timeline-label">{current.label}</div>}
          {current.note && <p className="lc-timeline-note">{current.note}</p>}
        </div>
      )}
    </section>
  );
}
