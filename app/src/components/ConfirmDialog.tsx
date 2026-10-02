import { useIsPresent } from "motion/react";
import { DialogBackdrop } from "./DialogMotion";
/**
 * The app's own "are you sure?", in place of `window.confirm`.
 *
 * A browser confirm box is the one piece of chrome the whiteboard cannot
 * theme, cannot lay out for a tablet, and cannot make you *hold* — and every
 * question worth interrupting a session for is destructive. So the same modal
 * shell as Reveal, with the same hold-to-confirm gesture on the action that
 * throws work away, and a plain button on the one that doesn't.
 */

import { useEffect, useId } from "react";

import { HoldButton } from "./HoldButton";
import { DialogFrame } from "./DialogFrame";
import "./confirmationDialogs.css";

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
  const titleId = useId();
  const present = useIsPresent();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending && present) onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, pending, present]);

  return (
    <DialogBackdrop
      className="lc-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending && present) onCancel();
      }}
    >
      <DialogFrame className="lc-modal lc-confirm-dialog" titleId={titleId} title={title} subtitle=""
        ariaLabel={title} shape="blocky" icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v1"/></svg>}>
        <div className="lc-dialog-body">
        <p>{message}</p>
        {detail && <p className="lc-muted">{detail}</p>}
        <p className="lc-muted lc-reveal-hold-hint">
          Hold {confirmLabel} briefly to confirm.
        </p>
        {error && <p className="lc-warning">{error}</p>}
        </div>
        <div className="lc-modal-actions lc-settings-foot lc-dialog-foot">
          <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </button>
          <HoldButton
            label={confirmLabel}
            className="lc-hold-danger lc-dialog-action"
            disabled={pending}
            onConfirm={onConfirm}
            resetKey={error}
          />
        </div>
      </DialogFrame>
    </DialogBackdrop>
  );
}
