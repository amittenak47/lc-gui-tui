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
}

export function ReviewPanel({ review, onRequestBridge, onDismiss }: ReviewPanelProps) {
  return (
    <section className="lc-panel" aria-label="Review">
      <header className="lc-panel-head">
        <span className={`lc-verdict lc-verdict-${review.verdict}`}>
          {VERDICT_LABEL[review.verdict] ?? review.verdict}
        </span>
        <button type="button" className="lc-link" onClick={onDismiss}>
          close
        </button>
      </header>

      <Ratings rating={review.rating} />

      {review.understood_approach && (
        <>
          <h3>What I think you're doing</h3>
          <p>{review.understood_approach}</p>
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

      {review.socratic_question && (
        <blockquote className="lc-question">{review.socratic_question}</blockquote>
      )}

      <footer className="lc-panel-foot">
        <span className="lc-muted">{review.provider}</span>
        {review.offer_bridge && (
          <button type="button" className="lc-secondary" onClick={onRequestBridge}>
            Show me the bridge…
          </button>
        )}
      </footer>
    </section>
  );
}

function Ratings({ rating }: { rating: ReviewResponse["rating"] }) {
  const entries: Array<[string, number]> = [
    ["correctness", rating.correctness],
    ["complexity", rating.complexity],
    ["clarity", rating.clarity],
  ];
  return (
    <ul className="lc-ratings">
      {entries.map(([label, score]) => (
        <li key={label}>
          <span className="lc-rating-label">{label}</span>
          <span className="lc-rating-score" aria-label={`${score} out of 5`}>
            {"●".repeat(Math.max(0, score))}
            {"○".repeat(Math.max(0, 5 - score))}
          </span>
        </li>
      ))}
    </ul>
  );
}
