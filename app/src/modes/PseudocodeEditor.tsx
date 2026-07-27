/**
 * Solution-code editor docked on the canvas (or as a side panel).
 *
 * Handwriting recognition is weak on brackets, indices, and `<=`. Typing the
 * solution means the coach reads it exactly. Monaco lives in {@link ./MonacoBlock}
 * and loads only when this panel mounts.
 *
 * Only Python is wired through the workspace for now — no language picker.
 */

import { Component, Suspense, lazy, type ErrorInfo, type ReactNode, useState } from "react";

const MonacoBlock = lazy(() => import("./MonacoBlock"));

export interface PseudocodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  themeId?: string;
  /** Board zoom — scales Monaco so code tracks Excalidraw text. */
  zoom?: number;
  /** Collapsed by default so it never competes with the canvas for space. */
  defaultOpen?: boolean;
  /** Docked on the canvas beneath the problem statement. */
  variant?: "panel" | "dock";
}

export function PseudocodeEditor({
  value,
  onChange,
  themeId = "parchment",
  zoom = 1,
  defaultOpen = true,
  variant = "panel",
}: PseudocodeEditorProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [failed, setFailed] = useState(false);

  const lineCount = value ? value.split("\n").length : 0;
  const dock = variant === "dock";

  const editor = failed ? (
    <textarea
      className="lc-pseudo-fallback"
      value={value}
      spellCheck={false}
      aria-label="Solution code"
      onChange={(event) => onChange(event.target.value)}
    />
  ) : (
    <ErrorBoundary onError={() => setFailed(true)}>
      <Suspense fallback={<div className="lc-pseudo-loading">loading editor…</div>}>
        <MonacoBlock
          value={value}
          language="python"
          themeId={themeId}
          zoom={dock ? zoom : 1}
          height={dock ? "100%" : "min(42vh, 360px)"}
          onChange={onChange}
          onReady={() => {}}
        />
      </Suspense>
    </ErrorBoundary>
  );

  if (dock) {
    return (
      <section className="lc-pseudo lc-pseudo-open lc-pseudo-dock" aria-label="Solution code">
        <div className="lc-pseudo-body">{editor}</div>
      </section>
    );
  }

  return (
    <section className={open ? "lc-pseudo lc-pseudo-open" : "lc-pseudo"} aria-label="Solution code">
      <header className="lc-panel-head">
        <button
          type="button"
          className="lc-link lc-pseudo-toggle"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "▾" : "▸"} Solution code
        </button>
        {!open && lineCount > 0 && (
          <span className="lc-muted">
            {lineCount} line{lineCount === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {open && <div className="lc-pseudo-body">{editor}</div>}
    </section>
  );
}

/**
 * Minimal boundary so a Monaco load failure degrades to the textarea instead of
 * taking the whole app down mid-session.
 */
class ErrorBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.props.onError();
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}
