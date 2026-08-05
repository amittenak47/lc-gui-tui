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

type CodeTab = "solution" | "imports";

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
  /** Monaco's full content height, so the board page can grow to it. */
  onCodeHeight?: (height: number) => void;
}

export function PseudocodeEditor({
  onCodeHeight,
  value,
  onChange,
  themeId = "blue",
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

  // Null / empty Imports → one undivided pane (nothing useful on the Imports tab).
  const split = splitSolution(value);
  const hasImports = Boolean(split && split.skeleton.trim().length > 0);
  const active =
    hasImports && tab === "imports" ? split!.skeleton : hasImports ? split!.body : value;

  const editTab = (next: string) => {
    if (!hasImports || !split) return onChange(next);
    onChange(
      tab === "imports"
        ? joinSolution(next, split.body)
        : joinSolution(split.skeleton, next),
    );
  };

  const editor = failed ? (
    <textarea
      className="lc-pseudo-fallback"
      value={active}
      spellCheck={false}
      aria-label={tabLabel(hasImports ? tab : null)}
      onChange={(event) => editTab(event.target.value)}
    />
  ) : (
    <ErrorBoundary onError={() => setFailed(true)}>
      <Suspense fallback={<div className="lc-pseudo-loading">loading editor…</div>}>
        <MonacoBlock
          key={tab}
          value={active}
          language="python"
          themeId={themeId}
          zoom={dock ? zoom : 1}
          fontSizePref={readingSize}
          height={dock ? "100%" : "min(42vh, 360px)"}
          onChange={editTab}
          onReady={() => {}}
          onContentHeight={onCodeHeight}
        />
      </Suspense>
    </ErrorBoundary>
  );

  const tabs = hasImports && (
    <div className="lc-code-tabs" role="tablist" aria-label="Solution code sections">
      {(["solution", "imports"] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          className={tab === id ? "lc-code-tab is-active" : "lc-code-tab"}
          onClick={() => setTab(id)}
        >
          {id === "solution" ? "Solution" : "Imports"}
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
  if (tab === "imports") return "Imports and helpers";
  if (tab === "solution") return "Solution class";
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
