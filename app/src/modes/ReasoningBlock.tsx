import { useState } from "react";

import { MorphBar } from "../components/MorphBar";

/**
 * Full model thinking, separate from the process step list.
 *
 * Steps stay chopped titles. This fold is the uncut chain-of-thought.
 */
export function ReasoningBlock({
  text,
  running,
}: {
  text: string;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const body = text.trim();
  if (!body) return null;
  const expanded = running || open;

  return (
    <div className={running ? "lc-agent-reasoning lc-agent-reasoning-running" : "lc-agent-reasoning"}>
      <button
        type="button"
        className="lc-agent-process-toggle"
        aria-expanded={expanded}
        onClick={() => setOpen((current) => !current)}
      >
        {running && <span className="lc-agent-spinner" aria-hidden />}
        <span className="lc-agent-process-chevron" aria-hidden />
        <span className="lc-agent-process-label">
          {running ? "Reasoning…" : "Reasoning"}
        </span>
      </button>
      {expanded && (
        <MorphBar active="body" axis="height" className="lc-agent-process-morph">
          <div data-morph-id="body">
            <div className="lc-agent-reasoning-body">{body}</div>
          </div>
        </MorphBar>
      )}
    </div>
  );
}
