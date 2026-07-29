/**
 * Phase 5's confirmation dialog and the bridge it produces.
 *
 * The daemon refuses to read the reference solution unless the request carries
 * `confirm_reveal: true`, and this dialog is the only thing in the app that sets
 * it. Consent is a short hold on Reveal (water-fill), not a checkbox — the gesture
 * itself lives in {@link HoldButton}, which every other irreversible choice in
 * the app now shares.
 */

import type { BridgeResponse } from "../api/types";
import { HoldButton } from "../components/HoldButton";

export interface RevealDialogProps {
  taskId: string;
  /** How many times this problem has already been revealed, if known. */
  previousReveals?: number;
  onConfirm: () => void;
  onCancel: () => void;
  pending: boolean;
  error: string | null;
}

export function RevealDialog({
  taskId,
  previousReveals,
  onConfirm,
  onCancel,
  pending,
  error,
}: RevealDialogProps) {
  return (
    <div className="lc-modal-backdrop" role="dialog" aria-modal="true" aria-label="Reveal reference">
      <div className={`lc-modal${pending ? " lc-modal-pending" : ""}`}>
        {pending ? (
          <div className="lc-reveal-loading" role="status">
            <span className="lc-reveal-loading-ring" aria-hidden />
            <h2>Building the bridge…</h2>
            <p className="lc-muted">Tracing a path from your approach to a working one.</p>
          </div>
        ) : (
          <>
            <h2>Show the reference solution?</h2>
            <p>
              You'll get a stepwise path from <em>your</em> approach to a working one — not a
              solution dump. But you can't un-see it for <code>{taskId}</code>.
            </p>
            {previousReveals !== undefined && previousReveals > 0 && (
              <p className="lc-muted">
                You've already revealed this one {previousReveals}{" "}
                {previousReveals === 1 ? "time" : "times"}.
              </p>
            )}
            <p className="lc-muted lc-reveal-hold-hint">Hold Reveal briefly to confirm.</p>

            {error && <p className="lc-warning">{error}</p>}

            <div className="lc-modal-actions">
              <button type="button" className="lc-secondary" onClick={onCancel}>
                Keep trying
              </button>
              <HoldButton
                label="Reveal"
                ariaLabel="Hold to reveal"
                disabled={pending}
                onConfirm={onConfirm}
                resetKey={error}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function BridgePanel({
  bridge,
  onDismiss,
  compact = false,
  collapsible = false,
  defaultOpen = true,
}: {
  bridge: BridgeResponse;
  onDismiss?: () => void;
  /** Nested under a coach turn — no outer panel chrome. */
  compact?: boolean;
  /** Fold into a summary so chat can continue above. */
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const body = (
    <>
      {bridge.already_yours && (
        <>
          <h3>Already yours</h3>
          <p>{bridge.already_yours}</p>
        </>
      )}

      {bridge.missing_piece && (
        <>
          <h3>The missing piece</h3>
          <p>{bridge.missing_piece}</p>
        </>
      )}

      {bridge.steps.length > 0 && (
        <>
          <h3>The path</h3>
          <ol className="lc-steps">
            {bridge.steps.map((step, i) => (
              <li key={i}>
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
              </li>
            ))}
          </ol>
        </>
      )}

      {bridge.smallest_edit && (
        <div className="lc-next-edit">
          <h3>Smallest next edit</h3>
          <p>{bridge.smallest_edit}</p>
        </div>
      )}

      <footer className="lc-panel-foot">
        {!compact && <span className="lc-muted">{bridge.provider}</span>}
        <span className="lc-muted">revealed ×{bridge.reveal_count}</span>
      </footer>
    </>
  );

  if (collapsible) {
    // `open` is the DOM attribute; React has no `defaultOpen` for `details`,
    // so the prop was silently dropped and the fold always started shut.
    return (
      <details className="lc-bridge-fold" open={defaultOpen}>
        <summary className="lc-bridge-fold-summary">
          <span>From yours to working</span>
          <span className="lc-bridge-fold-hint">hint path</span>
        </summary>
        <div className="lc-bridge-fold-body">{body}</div>
      </details>
    );
  }

  return (
    <section
      className={compact ? "lc-panel lc-panel-compact lc-bridge" : "lc-panel lc-bridge"}
      aria-label="Bridge"
    >
      <header className="lc-panel-head">
        <strong>From yours to working</strong>
        {onDismiss && (
          <button type="button" className="lc-link" onClick={onDismiss}>
            close
          </button>
        )}
      </header>
      {body}
    </section>
  );
}
