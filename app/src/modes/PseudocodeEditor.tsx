/**
 * A code block for pseudocode, alongside the ink.
 *
 * Handwriting recognition is good on prose and weak on exactly the things
 * pseudocode is made of — brackets, subscripts, `<=`, array indices. Typing that
 * part means the coach reads it *exactly* instead of guessing, so the daemon
 * carries it in its own `pseudocode` field and tells the model to read it
 * literally rather than second-guessing it like OCR.
 *
 * The block is the student's. The coach reads it and never writes to it, so
 * there is no question about who owns what on screen.
 *
 * Monaco itself lives in {@link ./MonacoBlock} and is loaded only when this
 * panel is opened — it is far too large to sit in the path of first paint.
 */

import { Suspense, lazy, useState } from "react";

const MonacoBlock = lazy(() => import("./MonacoBlock"));

export interface PseudocodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
  /** Collapsed by default so it never competes with the canvas for space. */
  defaultOpen?: boolean;
}

const LANGUAGES = ["python", "plaintext", "javascript", "cpp", "java"] as const;

export function PseudocodeEditor({
  value,
  onChange,
  language = "python",
  defaultOpen = false,
}: PseudocodeEditorProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [lang, setLang] = useState<string>(language);
  const [failed, setFailed] = useState(false);

  const lineCount = value ? value.split("\n").length : 0;

  return (
    <section className={open ? "lc-pseudo lc-pseudo-open" : "lc-pseudo"} aria-label="Pseudocode">
      <header className="lc-panel-head">
        <button
          type="button"
          className="lc-link lc-pseudo-toggle"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "▾" : "▸"} Pseudocode
        </button>
        {!open && lineCount > 0 && (
          <span className="lc-muted">
            {lineCount} line{lineCount === 1 ? "" : "s"}
          </span>
        )}
        {open && (
          <select
            className="lc-pseudo-lang"
            value={lang}
            aria-label="Language"
            onChange={(event) => setLang(event.target.value)}
          >
            {LANGUAGES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        )}
      </header>

      {open && (
        <div className="lc-pseudo-body">
          {failed ? (
            // A plain textarea beats no way to type pseudocode at all.
            <textarea
              className="lc-pseudo-fallback"
              value={value}
              spellCheck={false}
              aria-label="Pseudocode"
              onChange={(event) => onChange(event.target.value)}
            />
          ) : (
            <ErrorBoundary onError={() => setFailed(true)}>
              <Suspense fallback={<div className="lc-pseudo-loading">loading editor…</div>}>
                <MonacoBlock
                  value={value}
                  language={lang}
                  onChange={onChange}
                  onReady={() => {}}
                />
              </Suspense>
            </ErrorBoundary>
          )}
          <p className="lc-muted lc-pseudo-note">
            The coach reads this exactly — no handwriting guesswork.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * Minimal boundary so a Monaco load failure degrades to the textarea instead of
 * taking the whole app down mid-session.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

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
