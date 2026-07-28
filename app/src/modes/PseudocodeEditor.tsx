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

import { joinSolution, splitSolution } from "../util/solutionSplit";
import type { BoardReadingSize } from "./codeFontSize";

const MonacoBlock = lazy(() => import("./MonacoBlock"));

type CodeTab = "solution" | "skeleton";

export interface PseudocodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  themeId?: string;
  /** Board zoom — scales Monaco so code tracks Excalidraw text. */
  zoom?: number;
  /** Shared S/M/L reading size (problem statement + code). */
  readingSize?: BoardReadingSize;
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
  readingSize = "M",
  defaultOpen = true,
  variant = "panel",
}: PseudocodeEditorProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<CodeTab>("solution");

  const lineCount = value ? value.split("\n").length : 0;
  const dock = variant === "dock";

  // Null for a file this splitter does not recognise — a cleared buffer, or one
  // the student reshaped past the corpus's `class Solution:` layout. Then the
  // editor is one undivided pane, exactly as it was before tabs existed.
  const split = splitSolution(value);
  const active = split && tab === "skeleton" ? split.skeleton : split ? split.body : value;

  const editTab = (next: string) => {
    if (!split) return onChange(next);
    onChange(
      tab === "skeleton"
        ? joinSolution(next, split.body)
        : joinSolution(split.skeleton, next),
    );
  };

  const editor = failed ? (
    <textarea
      className="lc-pseudo-fallback"
      value={active}
      spellCheck={false}
      aria-label={tabLabel(split ? tab : null)}
      onChange={(event) => editTab(event.target.value)}
    />
  ) : (
    <ErrorBoundary onError={() => setFailed(true)}>
      <Suspense fallback={<div className="lc-pseudo-loading">loading editor…</div>}>
        <MonacoBlock
          value={active}
          language="python"
          themeId={themeId}
          zoom={dock ? zoom : 1}
          fontSizePref={readingSize}
          height={dock ? "100%" : "min(42vh, 360px)"}
          onChange={editTab}
          onReady={() => {}}
        />
      </Suspense>
    </ErrorBoundary>
  );

  const tabs = split && (
    <div className="lc-code-tabs" role="tablist" aria-label="Solution code sections">
      {(["solution", "skeleton"] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          className={tab === id ? "lc-code-tab is-active" : "lc-code-tab"}
          onClick={() => setTab(id)}
        >
          {id === "solution" ? "Solution" : "Skeleton"}
        </button>
      ))}
    </div>
  );

  if (dock) {
    return (
      <section className="lc-pseudo lc-pseudo-open lc-pseudo-dock" aria-label="Solution code">
        {tabs}
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

      {open && tabs}
      {open && <div className="lc-pseudo-body">{editor}</div>}
    </section>
  );
}

function tabLabel(tab: CodeTab | null): string {
  if (tab === "skeleton") return "Imports and signature";
  if (tab === "solution") return "Solution body";
  return "Solution code";
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
