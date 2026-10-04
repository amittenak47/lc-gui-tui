import { useIsPresent } from "motion/react";
import { DialogBackdrop } from "./DialogMotion";
/**
 * LLM unreachable while the in-process daemon is up — Settings → LLM, or continue
 * without coach.
 */

import { useEffect } from "react";

import { HoldButton } from "./HoldButton";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import "../modes/libraryMenu.css";
import { LoadingDoodle } from "./LoadingDoodle";
import { DialogFrame } from "./DialogFrame";
import "./confirmationDialogs.css";

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
  const present = useIsPresent();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && present && phase !== "exit") onContinueWithout();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onContinueWithout, present, phase]);

  return (
    <DialogBackdrop exiting={phase === "exit"}
      className="lc-settings-backdrop lc-server-gate"
      role="presentation"
    >
      <LoadingDoodle nativeInput={present && phase !== "exit"} nativeExclude=".lc-server-gate-modal button, .lc-server-gate-modal .lc-hold-reveal" />
      <DialogFrame exiting={phase === "exit"}
        className="lc-attempt-modal lc-server-gate-modal lc-library-holds lc-llm-status-dialog"
        titleId="lc-llm-status-title" title="Coach LLM is offline" subtitle=""
        ariaLabel="Coach LLM offline" shape="blocky"
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M4 3h16v14H8l-4 4V3Z"/><path d="M8 8h8m-8 4h5"/></svg>}
      >
        <div className="lc-settings-choice lc-dialog-body">
          <HoldButton
            holdMs={LIBRARY_HOLD_MS}
            label="Open Settings"
            className="lc-hold-choice"
            onConfirm={onOpenSettings}
          >
            Settings → LLM
          </HoldButton>
          <HoldButton
            holdMs={LIBRARY_HOLD_MS}
            label="Continue without LLM"
            className="lc-hold-choice"
            onConfirm={onContinueWithout}
          >
            Continue without LLM
          </HoldButton>
        </div>
      </DialogFrame>
    </DialogBackdrop>
  );
}
