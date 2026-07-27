/**
 * Right panel for talking to the coach — review, ambient nudges, diagrams,
 * and test feedback. Open/close via the header Coach button.
 */

import type { ReactNode } from "react";

import { Tip } from "../components/Tip";

export type CoachMode = "review" | "ambient";

export interface AgentSidePanelProps {
  open: boolean;
  mode: CoachMode;
  onModeChange: (mode: CoachMode) => void;
  busy: boolean;
  onSubmit: () => void;
  onDiagram: () => void;
  children: ReactNode;
}

export function AgentSidePanel({
  open,
  mode,
  onModeChange,
  busy,
  onSubmit,
  onDiagram,
  children,
}: AgentSidePanelProps) {
  if (!open) return null;

  return (
    <aside className="lc-side lc-side-open" id="lc-coach-panel">
      <div className="lc-side-body">
        <section className="lc-agent-actions" aria-label="Ask the agent">
          <p className="lc-section-label">When the agent reviews</p>
          <div className="lc-modes" role="group" aria-label="Review timing">
            <Tip tip="The agent reviews only when you click Submit work for review" placement="left">
              <button
                type="button"
                className={mode === "review" ? "lc-mode lc-mode-active" : "lc-mode"}
                aria-pressed={mode === "review"}
                disabled={busy}
                onClick={() => onModeChange("review")}
              >
                On submit
              </button>
            </Tip>
            <Tip tip="The agent glances at the board every 60 seconds and nudges if something changed" placement="left">
              <button
                type="button"
                className={mode === "ambient" ? "lc-mode lc-mode-active" : "lc-mode"}
                aria-pressed={mode === "ambient"}
                disabled={busy}
                onClick={() => onModeChange("ambient")}
              >
                Every 60s
              </button>
            </Tip>
          </div>

          <div className="lc-agent-buttons">
            {mode === "review" && (
              <Tip tip="Send your board and solution code to the agent for feedback" placement="left">
                <button type="button" disabled={busy} onClick={onSubmit}>
                  Submit work for review
                </button>
              </Tip>
            )}
            <Tip
              tip="Ask the agent to draw a diagram on the board (experimental — not fully wired yet)"
              placement="left"
            >
              <button type="button" className="lc-secondary" disabled={busy} onClick={onDiagram}>
                Ask agent to draw
              </button>
            </Tip>
          </div>
        </section>

        {children}
      </div>
    </aside>
  );
}
