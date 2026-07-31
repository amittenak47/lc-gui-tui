/**
 * Server unreachable — wait or continue offline.
 *
 * One hold-to-fill control: tap cycles Wait ↔ Continue offline; hold confirms.
 * Wait returns to the spinner; an invisible hitbox around the spinner restores
 * this dialog. Morph class markers are ready for Motion/torph later.
 */

import { useEffect, useState } from "react";

import { HoldButton } from "./HoldButton";
import { LoadingDoodle } from "./LoadingDoodle";

export type ServerGateKind = "startup" | "dropped";
export type ServerGateOption = "wait" | "offline";

export interface ServerStatusDialogProps {
  kind: ServerGateKind;
  /** enter → open → exit, driven by the parent for fade timing. */
  phase: "enter" | "open" | "exit";
  waiting: boolean;
  /** Host we are trying to reach, for the footnote under the title. */
  hostLabel?: string;
  onWait: () => void;
  onOffline: () => void;
  /** Tap the spinner hitbox (or Escape while waiting) to show choices again. */
  onResumeChoice: () => void;
}

export function ServerStatusDialog({
  kind,
  phase,
  waiting,
  hostLabel,
  onWait,
  onOffline,
  onResumeChoice,
}: ServerStatusDialogProps) {
  const [option, setOption] = useState<ServerGateOption>("wait");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (waiting) onResumeChoice();
        else onOffline();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOffline, onResumeChoice, waiting]);

  const title =
    kind === "startup" ? "Can't reach local server" : "Local server went away";

  const confirm = () => {
    if (option === "wait") onWait();
    else onOffline();
  };

  const cycleOption = () => {
    setOption((current) => (current === "wait" ? "offline" : "wait"));
  };

  return (
    <div
      className={[
        "lc-settings-backdrop",
        "lc-server-gate",
        phase === "enter" && "lc-server-gate-enter",
        phase === "exit" && "lc-server-gate-exit",
        waiting && "lc-server-gate-waiting-mode",
      ]
        .filter(Boolean)
        .join(" ")}
      role="presentation"
    >
      <LoadingDoodle />
      <div
        className={[
          "lc-gate-slot",
          waiting ? "lc-gate-morph-to-spinner" : "lc-gate-morph-to-dialog",
        ].join(" ")}
      >
        {waiting ? (
          <button
            type="button"
            className="lc-gate-spinner-hitbox"
            aria-label="Show wait or offline choices"
            onClick={onResumeChoice}
          >
            <div className="lc-spinner" aria-hidden="true" />
          </button>
        ) : (
          <div
            className="lc-settings-modal lc-attempt-modal lc-server-gate-modal"
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            <div className="lc-server-gate-head">
              <h2>{title}</h2>
              {hostLabel && <p className="lc-server-gate-host">{hostLabel}</p>}
            </div>

            <p className="lc-muted lc-server-gate-hint">Tap to switch · hold to confirm</p>

            <HoldButton
              label={option === "wait" ? "Wait" : "Continue offline"}
              className="lc-hold-choice lc-gate-option-hold"
              onTap={cycleOption}
              onConfirm={confirm}
              resetKey={option}
            >
              <span className="lc-gate-option-morph" data-option={option}>
                <span
                  className={[
                    "lc-gate-option-label",
                    option === "wait" && "is-active",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  Wait
                </span>
                <span
                  className={[
                    "lc-gate-option-label",
                    option === "offline" && "is-active",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  Continue offline
                </span>
              </span>
            </HoldButton>
          </div>
        )}
      </div>
    </div>
  );
}
