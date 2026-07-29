/**
 * The app's own "are you sure?", in place of `window.confirm`.
 *
 * A browser confirm box is the one piece of chrome the whiteboard cannot
 * theme, cannot lay out for a tablet, and cannot make you *hold* — and every
 * question worth interrupting a session for is destructive. So the same modal
 * shell as Reveal, with the same hold-to-confirm gesture on the action that
 * throws work away, and a plain button on the one that doesn't.
 */

import { useEffect } from "react";

import { HoldButton } from "./HoldButton";

export interface ConfirmDialogProps {
  title: string;
  /** Body copy. A short second line goes in `detail`. */
  message: string;
  detail?: string;
  /** Label of the destructive action — the one you hold. */
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Blocks input while the action is in flight. */
  pending?: boolean;
  error?: string | null;
}

export function ConfirmDialog({
  title,
  message,
  detail,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  pending = false,
  error = null,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, pending]);

  return (
    <div
      className="lc-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div className="lc-modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{message}</p>
        {detail && <p className="lc-muted">{detail}</p>}
        <p className="lc-muted lc-reveal-hold-hint">
          Hold {confirmLabel} for 1 second to confirm.
        </p>
        {error && <p className="lc-warning">{error}</p>}
        <div className="lc-modal-actions">
          <button type="button" className="lc-secondary" disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </button>
          <HoldButton
            label={confirmLabel}
            className="lc-hold-danger"
            disabled={pending}
            onConfirm={onConfirm}
            resetKey={error}
          />
        </div>
      </div>
    </div>
  );
}
