/**
 * Test results, as a modal in the Settings panel's clothing.
 *
 * Results used to render only as a card inside the coach thread, where they
 * scrolled away under the next message. They now open over the board, in the
 * same backdrop/modal shell Settings uses, so a run announces itself.
 *
 * The modal is a *view*, not the record: the same results are pushed into the
 * coach thread as an `app` turn and sent to the model on the next question, so
 * closing this loses nothing. See `formatTestReport`.
 */

import { useEffect } from "react";

import type { CaseResult, TestResponse } from "../api/types";

export interface TestResultsModalProps {
  tests: TestResponse | null;
  /** Whether this run came from Run tests or from Submit. */
  kind: "run" | "submit";
  onClose: () => void;
  onNext: () => void;
  onRandom: () => void;
  onBrowse: () => void;
  canNext: boolean;
}

export function TestResultsModal({
  tests,
  kind,
  onClose,
  onNext,
  onRandom,
  onBrowse,
  canNext,
}: TestResultsModalProps) {
  useEffect(() => {
    if (!tests) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tests, onClose]);

  if (!tests) return null;

  const failures = tests.results.filter((result) => !result.pass);
  const celebrate = tests.all_passed;

  return (
    <div
      className="lc-settings-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="lc-settings-modal lc-tests-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Test results"
      >
        <div className="lc-settings-head">
          <h2>
            <span className={celebrate ? "lc-pass" : "lc-fail"}>
              {tests.passed}/{tests.total} passed
            </span>
          </h2>
          <p className="lc-muted">
            {kind === "submit" ? "Submit" : "Run tests"} · {tests.task_id}
          </p>
        </div>

        <div className="lc-settings-body">
          {tests.stopped_early && (
            <div className="lc-notice lc-tests-notice">
              Stopped at the first failure — Settings → Tests. The remaining cases were not run.
            </div>
          )}

          {celebrate ? (
            <div className="lc-submit-pass">
              <p>
                {kind === "submit"
                  ? `All ${tests.total} cases passed. Nice work — pick where to go next.`
                  : `All ${tests.total} cases passed.`}
              </p>
              <div className="lc-submit-actions">
                <button type="button" disabled={!canNext} onClick={onNext}>
                  Next problem
                </button>
                <button type="button" className="lc-secondary" onClick={onRandom}>
                  Random
                </button>
                <button type="button" className="lc-secondary" onClick={onBrowse}>
                  Browse
                </button>
              </div>
            </div>
          ) : (
            <div className="lc-tests-cases">
              {failures.map((result) => (
                <FailCase key={result.case} result={result} />
              ))}
              {failures.length === 0 && (
                <p className="lc-muted">
                  No case-level failures were recorded — check the runner output.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="lc-settings-foot">
          <p className="lc-muted lc-tests-foot-note">Also posted to the coach thread.</p>
          <button type="button" className="lc-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function FailCase({ result }: { result: CaseResult }) {
  return (
    <div className="lc-case-fail">
      <strong>{result.suite ? "suite" : `case ${result.case}`}</strong>
      <div>
        <code>{result.input}</code>
      </div>
      <div className="lc-muted">
        expected <code>{result.expected}</code>
        {result.actual !== null && (
          <>
            {" · got "}
            <code>{result.actual}</code>
          </>
        )}
      </div>
      {result.error && <pre className="lc-case-error">{result.error.trimEnd()}</pre>}
    </div>
  );
}

/**
 * The results as one message for the coach thread — and for the model.
 *
 * This is what makes "Run tests" something the coach knows about: it is pushed
 * into the transcript as an `app` turn and prepended to the next question, so
 * asking "why did case 3 fail?" needs no copy-paste.
 *
 * Capped at a handful of failures, because the whole thing goes into a prompt
 * and a problem with 200 failing cases would crowd out the board.
 */
export function formatTestReport(tests: TestResponse, kind: "run" | "submit"): string {
  const header = `${kind === "submit" ? "Submit" : "Run tests"} — ${tests.passed}/${tests.total} passed`;
  if (tests.all_passed) {
    return `${header}\nAll cases passed.`;
  }

  const failures = tests.results.filter((result) => !result.pass);
  const shown = failures.slice(0, MAX_REPORTED_FAILURES).map((result) => {
    const lines = [
      `${result.suite ? "suite" : `case ${result.case}`}: ${result.input}`,
      `  expected: ${result.expected}`,
    ];
    if (result.actual !== null) lines.push(`  got:      ${result.actual}`);
    if (result.error) lines.push(`  error:    ${lastLine(result.error)}`);
    return lines.join("\n");
  });

  const parts = [header];
  if (tests.stopped_early) {
    parts.push("(stopped at the first failure — remaining cases were not run)");
  }
  parts.push(shown.join("\n\n"));
  if (failures.length > shown.length) {
    parts.push(`…and ${failures.length - shown.length} more failing cases.`);
  }
  return parts.join("\n\n");
}

const MAX_REPORTED_FAILURES = 5;

function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}
