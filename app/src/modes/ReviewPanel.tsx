/**
 * Mode A — the result of tapping **Submit**.
 *
 * The counterexample is the point of this panel: a specific sample case that
 * breaks the approach. It is safe to show verbatim because the daemon validated
 * the cited index against `meta.cases` and replaced the input/expected text with
 * the corpus's own — so this is never a case the model invented.
 */

import type { ReviewResponse, Verdict } from "../api/types";

const VERDICT_LABEL: Record<Verdict, string> = {
  on_track: "On track",
  subtly_wrong: "Subtly wrong",
  wrong_track: "Wrong track",
  unclear: "Couldn't tell",
};

export interface ReviewPanelProps {
  review: ReviewResponse;
  /** Opens the reveal confirmation. Only rendered when the coach offers it. */
  onRequestBridge: () => void;
  onDismiss: () => void;
  /** Tighter chrome when embedded inside a chat turn. */
  compact?: boolean;
  /** Hide Hint once a bridge is already attached to this turn. */
  bridgeOffered?: boolean;
}

export function ReviewPanel({
  review,
  onRequestBridge,
  onDismiss,
  compact = false,
  bridgeOffered = false,
}: ReviewPanelProps) {
  return (
    <section
      className={compact ? "lc-panel lc-panel-compact" : "lc-panel"}
      aria-label="Review"
    >
      <header className="lc-panel-head">
        <span className={`lc-verdict lc-verdict-${review.verdict}`}>
          {VERDICT_LABEL[review.verdict] ?? review.verdict}
        </span>
        {!compact && (
          <button type="button" className="lc-link" onClick={onDismiss}>
            close
          </button>
        )}
      </header>

      <Ratings rating={review.rating} />

      {review.understood_approach && (
        <>
          <h3>What I think you're doing</h3>
          <p className="lc-review-summary">{review.understood_approach}</p>
        </>
      )}

      {review.strengths.length > 0 && (
        <>
          <h3>Working</h3>
          <ul>
            {review.strengths.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </>
      )}

      {(review.layout_verdict || review.code_verdict) && (
        <p className="lc-muted">
          Assessed separately
          {review.layout_verdict ? ` · board: ${review.layout_verdict}` : ""}
          {review.code_verdict ? ` · code: ${review.code_verdict}` : ""}
        </p>
      )}

      {review.gaps.length > 0 && (
        <>
          <h3>Gaps</h3>
          <ul>
            {review.gaps.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </>
      )}

      {review.counterexample && (
        <div className="lc-counterexample">
          <h3>This case breaks it — case {review.counterexample.case_number}</h3>
          <dl>
            <dt>input</dt>
            <dd>
              <code>{review.counterexample.input}</code>
            </dd>
            <dt>expected</dt>
            <dd>
              <code>{review.counterexample.expected}</code>
            </dd>
          </dl>
          <p>{review.counterexample.why_your_approach_fails}</p>
          <p className="lc-muted">
            Run it yourself: <code>lc test --case {review.counterexample.case_number}</code>
          </p>
        </div>
      )}

      {review.counterexample_rejected && (
        // The coach cited a case that doesn't exist. Say so plainly rather than
        // hiding it — it's a signal the model is guessing.
        <p className="lc-warning">{review.counterexample_rejected}</p>
      )}

      {review.approach_transition && (
        // The board changed enough that the coach is now reading it as a
        // different approach. Saying so is the point: an unannounced switch is
        // indistinguishable from the coach contradicting itself.
        <div className="lc-review-transition">
          <h3>Switching approach</h3>
          <p>
            From <strong>{review.approach_transition.from}</strong> to{" "}
            <strong>{review.approach_transition.to}</strong> — {review.approach_transition.reason}
          </p>
          {review.approach_transition.what_carries_over &&
            review.approach_transition.what_carries_over.length > 0 && (
              <>
                <p className="lc-muted">What carries over:</p>
                <ul>
                  {review.approach_transition.what_carries_over.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              </>
            )}
        </div>
      )}

      {review.socratic_question && (
        <div className="lc-review-action">
          <h3>Try this</h3>
          <p>{review.socratic_question}</p>
        </div>
      )}

      {review.candidate_approaches && review.candidate_approaches.length > 0 && (
        // Choices, not a decision. Sending one back as chat is what picks it —
        // there is deliberately no button that commits on the student's behalf.
        <div className="lc-review-candidates">
          <h3>Or say which of these you meant</h3>
          <ul>
            {review.candidate_approaches.map((candidate) => (
              <li key={candidate.id || candidate.name}>
                <strong>{candidate.name}</strong>
                {candidate.when_to_use ? ` — ${candidate.when_to_use}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {review.offer_bridge && !bridgeOffered && (
        <footer className="lc-panel-foot">
          <button type="button" className="lc-hint-btn" onClick={onRequestBridge}>
            Hint
          </button>
        </footer>
      )}
    </section>
  );
}

function Ratings({ rating }: { rating: ReviewResponse["rating"] }) {
  const entries: Array<[string, number]> = [
    ["correctness", clampScore(rating.correctness)],
    ["complexity", clampScore(rating.complexity)],
    ["clarity", clampScore(rating.clarity)],
  ];
  const scored = entries.some(([, score]) => score > 0);

  if (!scored) {
    return <p className="lc-ratings-empty lc-muted">Not enough on the board to score yet</p>;
  }

  return (
    <ul className="lc-ratings">
      {entries.map(([label, score]) => (
        <li key={label}>
          <span className="lc-rating-label">{label}</span>
          <span className="lc-rating-score" aria-label={`${score} out of 5`}>
            {Array.from({ length: 5 }, (_, i) => (
              <span
                key={i}
                className={i < score ? "lc-rating-pip lc-rating-pip-on" : "lc-rating-pip"}
                aria-hidden
              />
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(5, Math.round(value)));
}
