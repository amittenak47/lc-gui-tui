/**
 * LLM unreachable while the in-process daemon is up — Settings → LLM, or continue
 * without coach.
 */

import { useEffect } from "react";

import { HoldButton } from "./HoldButton";
import { LoadingDoodle } from "./LoadingDoodle";

export interface LlmStatusDialogProps {
  phase: "enter" | "open" | "exit";
  onOpenSettings: () => void;
  onContinueWithout: () => void;
}

export function LlmStatusDialog({
  phase,
  onOpenSettings,
  onContinueWithout,
}: LlmStatusDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onContinueWithout();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onContinueWithout]);

  return (
    <div
      className={[
        "lc-settings-backdrop",
        "lc-server-gate",
        phase === "enter" && "lc-server-gate-enter",
        phase === "exit" && "lc-server-gate-exit",
      ]
        .filter(Boolean)
        .join(" ")}
      role="presentation"
    >
      <LoadingDoodle />
      <div
        className="lc-settings-modal lc-attempt-modal lc-server-gate-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Coach LLM offline"
      >
        <div className="lc-server-gate-head">
          <h2>Coach LLM is offline</h2>
        </div>

        <div className="lc-settings-choice">
          <HoldButton
            label="Open Settings"
            className="lc-hold-choice"
            onConfirm={onOpenSettings}
          >
            Settings → LLM
          </HoldButton>
          <HoldButton
            label="Continue without LLM"
            className="lc-hold-choice"
            onConfirm={onContinueWithout}
          >
            Continue without LLM
          </HoldButton>
        </div>
      </div>
    </div>
  );
}
