import type { ReactNode } from "react";
import "./dialogFrame.css";

export type DialogShape = "soft" | "blocky";
export type DialogMode = "practice" | "annotate" | "whiteboard" | "browse" | "explore";

/** Opt-in presentation only; each dialog keeps its own lifecycle and actions. */
export function DialogFrame({
  titleId,
  title,
  subtitle,
  icon,
  description,
  mode,
  shape = "soft",
  className = "",
  onClose,
  closeDisabled = false,
  children,
}: {
  titleId: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  description?: string;
  mode?: DialogMode;
  shape?: DialogShape;
  className?: string;
  onClose: () => void;
  closeDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`lc-settings-modal lc-dialog-frame ${className}`}
      data-dialog-shape={shape}
      data-dialog-mode={mode}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? `${titleId}-description` : undefined}
    >
      <header className="lc-dialog-head">
        <div className="lc-dialog-heading">
          <span className="lc-dialog-chip" aria-hidden="true">{icon}</span>
          <div className="lc-dialog-heading-text">
            <h2 id={titleId}>{title}</h2>
            <p className="lc-dialog-meta">{subtitle}</p>
          </div>
          <button
            type="button"
            className="lc-dialog-close"
            aria-label={`Close ${title}`}
            disabled={closeDisabled}
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        {description ? <p id={`${titleId}-description`} className="lc-dialog-description">{description}</p> : null}
      </header>
      {children}
    </div>
  );
}
