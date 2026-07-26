/**
 * Phase 5's confirmation dialog and the bridge it produces.
 *
 * The daemon refuses to read the reference solution unless the request carries
 * `confirm_reveal: true`, and this dialog is the only thing in the app that sets
 * it. There is no "don't ask again" — tapping out should always be a decision.
 */

import { useState } from "react";

import type { BridgeResponse } from "../api/types";

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
  const [understood, setUnderstood] = useState(false);

  return (
    <div className="lc-modal-backdrop" role="dialog" aria-modal="true" aria-label="Reveal reference">
      <div className="lc-modal">
        <h2>Show the reference solution?</h2>
        <p>
          You'll get a stepwise path from <em>your</em> approach to a working one — not a solution
          dump. But you can't un-see it for <code>{taskId}</code>.
        </p>
        {previousReveals !== undefined && previousReveals > 0 && (
          <p className="lc-muted">
            You've already revealed this one {previousReveals}{" "}
            {previousReveals === 1 ? "time" : "times"}.
          </p>
        )}

        <label className="lc-checkbox">
          <input
            type="checkbox"
            checked={understood}
            onChange={(event) => setUnderstood(event.target.checked)}
          />
          I've given this a real attempt.
        </label>

        {error && <p className="lc-warning">{error}</p>}

        <div className="lc-modal-actions">
          <button type="button" className="lc-secondary" onClick={onCancel} disabled={pending}>
            Keep trying
          </button>
          <button type="button" onClick={onConfirm} disabled={!understood || pending}>
            {pending ? "Building the bridge…" : "Reveal"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BridgePanel({
  bridge,
  onDismiss,
}: {
  bridge: BridgeResponse;
  onDismiss: () => void;
}) {
  return (
    <section className="lc-panel lc-bridge" aria-label="Bridge">
      <header className="lc-panel-head">
        <strong>From yours to working</strong>
        <button type="button" className="lc-link" onClick={onDismiss}>
          close
        </button>
      </header>

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
        <span className="lc-muted">{bridge.provider}</span>
        <span className="lc-muted">revealed ×{bridge.reveal_count}</span>
      </footer>
    </section>
  );
}
