/**
 * Free a scratchpad slot when the library is full (hold to delete).
 */

import { useEffect, useState } from "react";

import { HoldButton } from "../components/HoldButton";
import {
  deleteScratchNotebook,
  listScratchNotebooks,
  SCRATCHPAD_LIBRARY_LIMIT,
  type ScratchNotebookMeta,
} from "../util/scratchpadStore";

export interface ScratchpadLibraryDialogProps {
  phase?: "enter" | "open" | "exit";
  /** Called after a delete frees at least one slot (or Cancel). */
  onFreed: () => void;
  onCancel: () => void;
}

export function ScratchpadLibraryDialog({
  phase = "open",
  onFreed,
  onCancel,
}: ScratchpadLibraryDialogProps) {
  const [notebooks, setNotebooks] = useState<ScratchNotebookMeta[]>(() =>
    listScratchNotebooks(),
  );

  useEffect(() => {
    setNotebooks(listScratchNotebooks());
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const remove = (id: string) => {
    deleteScratchNotebook(id);
    const next = listScratchNotebooks();
    setNotebooks(next);
    if (next.length < SCRATCHPAD_LIBRARY_LIMIT) onFreed();
  };

  return (
    <div
      className={[
        "lc-settings-backdrop",
        "lc-scratch-lib-dialog",
        phase === "enter" && "lc-server-gate-enter",
        phase === "exit" && "lc-server-gate-exit",
      ]
        .filter(Boolean)
        .join(" ")}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="lc-settings-modal lc-attempt-modal lc-scratch-lib-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Scratchpad library full"
      >
        <div className="lc-settings-head">
          <h2>Scratchpad library full</h2>
          <p className="lc-muted">
            At most {SCRATCHPAD_LIBRARY_LIMIT} notebooks. Hold to delete one.
          </p>
        </div>
        <div className="lc-settings-body">
          <div className="lc-settings-choice">
            {notebooks.map((entry) => (
              <HoldButton
                key={entry.id}
                label={`Delete ${entry.title}`}
                className="lc-hold-choice lc-hold-danger"
                onConfirm={() => remove(entry.id)}
              >
                <strong>Delete · {entry.title}</strong>
                <span className="lc-muted">
                  {entry.pageCount} page{entry.pageCount === 1 ? "" : "s"} ·{" "}
                  {new Date(entry.updatedAt).toLocaleString()}
                </span>
              </HoldButton>
            ))}
          </div>
        </div>
        <div className="lc-settings-foot">
          <button type="button" className="lc-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
