/**
 * Leaving a problem: keep the work, or start clean next time.
 *
 * Which question gets asked depends on whether the problem is solved, because
 * the two situations mean different things:
 *
 * - **Not solved** — saving resumes the layout, the code, *and* the coach
 *   thread, so coming back is genuinely continuing. Discarding wipes all three.
 * - **Solved** — the attempt is a record, not a resumption. Saving archives the
 *   layout and code alongside the transcript; clearing resets the code to the
 *   starter. Either way the coach thread is archived and the next attempt gets
 *   a fresh board and a fresh session, because re-solving a problem while
 *   looking at your own answer is not practice.
 *
 * The daemon owns those rules (`src/attempt.rs`); this dialog only asks.
 *
 * Both answers are held rather than clicked. Discarding is destructive and
 * saving is what the *next* attempt inherits, so neither should be reachable by
 * a stray tap on a tablet — the same water-fill gesture as Reveal.
 */

import { useEffect } from "react";

import { HoldButton } from "../components/HoldButton";

export interface AttemptDialogProps {
  taskId: string;
  solved: boolean;
  pending: boolean;
  error: string | null;
  /** Keep the work (`save`) or clear it. */
  onChoose: (save: boolean) => void;
  /** Stay on the problem. */
  onCancel: () => void;
}

export function AttemptDialog({
  taskId,
  solved,
  pending,
  error,
  onChoose,
  onCancel,
}: AttemptDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, pending]);

  return (
    <div
      className="lc-settings-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        className="lc-settings-modal lc-attempt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={solved ? "Save this attempt?" : "Save your progress?"}
      >
        <div className="lc-settings-head">
          <h2>{solved ? "Save this attempt?" : "Save your progress?"}</h2>
          <p className="lc-muted">{taskId}</p>
        </div>

        <div className="lc-settings-body">
          {error && <div className="lc-warning">{error}</div>}
          <p className="lc-muted lc-reveal-hold-hint">Hold either answer briefly.</p>
          <div className="lc-settings-choice">
            <HoldButton
              label={solved ? "Save attempt" : "Save progress"}
              className="lc-hold-choice"
              disabled={pending}
              onConfirm={() => onChoose(true)}
              resetKey={error}
            >
              <strong>{solved ? "Save attempt" : "Save progress"}</strong>
              <span className="lc-muted">
                {solved
                  ? "Archive the board and keep your solution. The next attempt still starts on a fresh board."
                  : "Keep the layout, the code, and the coach thread. They all come back next time."}
              </span>
            </HoldButton>
            <HoldButton
              label={solved ? "Clear attempt" : "Discard"}
              className="lc-hold-choice lc-hold-danger"
              disabled={pending}
              onConfirm={() => onChoose(false)}
              resetKey={error}
            >
              <strong>{solved ? "Clear attempt" : "Discard"}</strong>
              <span className="lc-muted">
                {solved
                  ? "Reset the code to the starter stub. The coach thread is archived either way."
                  : "Clear the board, reset the code, and start the coach fresh next time."}
              </span>
            </HoldButton>
          </div>
          {solved && (
            <p className="lc-settings-hint">
              Your coach session is always saved once a problem is solved.
            </p>
          )}
        </div>

        <div className="lc-settings-foot">
          <button type="button" className="lc-secondary" disabled={pending} onClick={onCancel}>
            Keep working
          </button>
        </div>
      </div>
    </div>
  );
}
