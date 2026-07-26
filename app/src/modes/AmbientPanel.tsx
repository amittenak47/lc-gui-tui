/**
 * Mode B's side panel.
 *
 * Ambient replies render here and **never as canvas mutations** — the pen must
 * not fight the coach for the board. Newest nudge first, older ones kept so the
 * escalation is visible.
 */

import type { AmbientNudge } from "../api/types";

export interface AmbientEntry extends AmbientNudge {
  at: number;
}

export interface AmbientPanelProps {
  entries: AmbientEntry[];
  connected: boolean;
  thinking: boolean;
  provider: string | null;
  /** Last skip reason, so the loop's silence is explainable. */
  lastSkip: string | null;
  onAnalyzeNow: () => void;
  onReset: () => void;
}

const CLOSENESS_ORDER = ["cold", "warm", "close", "there"];

export function AmbientPanel({
  entries,
  connected,
  thinking,
  provider,
  lastSkip,
  onAnalyzeNow,
  onReset,
}: AmbientPanelProps) {
  return (
    <section className="lc-panel lc-ambient" aria-label="Ambient coach" aria-live="polite">
      <header className="lc-panel-head">
        <span className={connected ? "lc-dot lc-dot-on" : "lc-dot"} aria-hidden="true" />
        <strong>Coach</strong>
        <span className="lc-muted">{connected ? "watching" : "offline"}</span>
        <button type="button" className="lc-link" onClick={onAnalyzeNow}>
          look now
        </button>
        <button type="button" className="lc-link" onClick={onReset}>
          start over
        </button>
      </header>

      {thinking && <p className="lc-muted">thinking…</p>}

      {entries.length === 0 && !thinking && (
        <p className="lc-muted">
          Sketch your approach. I'll look every 15 seconds — and stay quiet while nothing changes.
        </p>
      )}

      <ol className="lc-nudges">
        {entries.map((entry) => (
          <li key={entry.at}>
            <p className="lc-nudge-text">{entry.nudge}</p>
            <div className="lc-nudge-meta">
              {entry.guessed_approach && <span>reads as: {entry.guessed_approach}</span>}
              <Closeness value={entry.closeness} />
              <Confidence value={entry.confidence} />
            </div>
          </li>
        ))}
      </ol>

      <footer className="lc-panel-foot">
        {provider && <span className="lc-muted">{provider}</span>}
        {lastSkip && <span className="lc-muted">idle: {lastSkip}</span>}
      </footer>
    </section>
  );
}

function Closeness({ value }: { value: string }) {
  const index = CLOSENESS_ORDER.indexOf(value);
  if (index < 0) return value ? <span>{value}</span> : null;
  return (
    <span className={`lc-closeness lc-closeness-${value}`} title={`closeness: ${value}`}>
      {value}
    </span>
  );
}

function Confidence({ value }: { value: number }) {
  // A low-confidence read usually means the handwriting didn't recognize well;
  // showing it stops the student trusting a bad guess.
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return <span className="lc-muted">{percent}% sure</span>;
}
