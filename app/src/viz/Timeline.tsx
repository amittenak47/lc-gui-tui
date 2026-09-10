import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { VizProgram } from "./schema";

export interface TimelineProps {
  program: VizProgram;
  onFrame: (frameIndex: number) => void;
  initialFrame?: number;
  playbackMs?: number;
}

function clampFrame(value: number, total: number) {
  return Math.min(Math.max(Number.isFinite(value) ? Math.trunc(value) : 0, 0), Math.max(total - 1, 0));
}

function TransportIcon({ kind }: { kind: "prev" | "next" | "play" | "pause" | "replay" }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "play" ? <path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none" /> :
      kind === "pause" ? <path d="M8 5v14M16 5v14" strokeWidth="4" /> :
      kind === "replay" ? <path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" /> :
      kind === "prev" ? <path d="M7 5v14m11-14-9 7 9 7Z" /> :
      <path d="M17 5v14M6 5l9 7-9 7Z" />}
  </svg>;
}

/** One diagram through time. Controls never dispatch scene writes during React render. */
export function Timeline({ program, onFrame, initialFrame = 0, playbackMs = 1200 }: TimelineProps) {
  const total = program.frames.length;
  const [frame, setFrame] = useState(() => clampFrame(initialFrame, total));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const callbackRef = useRef(onFrame);
  callbackRef.current = onFrame;
  const initialRef = useRef(initialFrame);
  initialRef.current = initialFrame;
  // Same-id replacements can have a different trace with the same frame count.
  const revision = JSON.stringify(program);

  const show = useCallback((value: number) => {
    const next = clampFrame(value, total);
    setFrame(next);
    if (total) callbackRef.current(next);
  }, [total]);

  useEffect(() => {
    setPlaying(false);
    show(initialRef.current);
  }, [revision, show]);

  useEffect(() => {
    if (!playing || total < 2) return;
    const timer = window.setTimeout(() => {
      const next = frame + 1;
      if (next < total) show(next);
      if (next >= total - 1) setPlaying(false);
    }, Math.max(100, playbackMs / speed));
    return () => window.clearTimeout(timer);
  }, [playing, frame, total, playbackMs, speed, show]);

  useEffect(() => {
    const pauseWhenHidden = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  const step = (value: number) => { setPlaying(false); show(value); };
  const toggle = () => {
    if (playing) { setPlaying(false); return; }
    if (frame >= total - 1) show(0);
    setPlaying(true);
  };
  const current = program.frames[clampFrame(frame, total)];
  const atEnd = frame >= total - 1;
  const action = playing ? "Pause" : atEnd ? "Replay" : "Play";

  return <section className={`lc-timeline${playing ? " is-playing" : ""}`} aria-label={`Animation: ${program.title || program.id}`}>
    <div className="lc-timeline-meta">
      <span className="lc-timeline-kind">{program.viz === "dptable" ? "DP table" : program.viz === "unionfind" ? "Union find" : program.viz}</span>
      <span className="lc-timeline-count">{total > 1 ? `Step ${frame + 1} of ${total}` : "Diagram"}</span>
    </div>
    {total > 1 && <>
      <div className="lc-timeline-controls" role="group" aria-label="Playback controls">
        <button type="button" aria-label="Previous step" title="Previous step" onClick={() => step(frame - 1)} disabled={frame === 0}><TransportIcon kind="prev" /></button>
        <button type="button" className="lc-timeline-play" aria-label={action} onClick={toggle}><TransportIcon kind={playing ? "pause" : atEnd ? "replay" : "play"} /><span>{action}</span></button>
        <button type="button" aria-label="Next step" title="Next step" onClick={() => step(frame + 1)} disabled={atEnd}><TransportIcon kind="next" /></button>
        <select className="lc-timeline-speed" aria-label="Playback speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
          {[0.5, 1, 1.5, 2].map((value) => <option key={value} value={value}>{value}×</option>)}
        </select>
      </div>
      <input type="range" min={0} max={total - 1} value={frame} aria-label="Frame"
        aria-valuetext={`Step ${frame + 1} of ${total}${current?.label ? `: ${current.label}` : ""}`}
        style={{ "--trace-progress": `${frame / (total - 1) * 100}%` } as CSSProperties}
        onPointerDown={() => setPlaying(false)}
        onChange={(event) => step(Number(event.target.value))} />
    </>}
    {current && <div className="lc-timeline-frame" aria-live={playing ? "off" : "polite"} aria-atomic="true">
      {current.label && <div className="lc-timeline-label">{current.label}</div>}
      {current.note && <p className="lc-timeline-note">{current.note}</p>}
    </div>}
  </section>;
}
