/**
 * Free a scratchpad slot when the library is full (hold to delete).
 */

import { useEffect, useState } from "react";

import { ConfirmDialog } from "../components/ConfirmDialog";
import { HoldButton } from "../components/HoldButton";
import { useLibraryDeleteArm } from "../util/armedDelete";
import {
  deleteWhiteboardNotebook,
  listWhiteboardNotebooks,
  setWhiteboardNotebookLocked,
  WHITEBOARD_LIBRARY_LIMIT,
  type WhiteboardNotebookMeta,
} from "../util/whiteboardStore";
import { LibraryPadlock } from "./LibraryPadlock";
import { TOMBSTONE_COPY } from "../util/padSync";

export interface WhiteboardLibraryDialogProps {
  phase?: "enter" | "open" | "exit";
  /** Called after a delete frees at least one slot (or Cancel). */
  onFreed: () => void;
  onCancel: () => void;
  /** Hold-confirm delete. Defaults to a local-only drop. */
  onDelete?: (id: string) => void | Promise<void>;
}

export function WhiteboardLibraryDialog({
  phase = "open",
  onFreed,
  onCancel,
  onDelete,
}: WhiteboardLibraryDialogProps) {
  const [notebooks, setNotebooks] = useState<WhiteboardNotebookMeta[]>(() =>
    listWhiteboardNotebooks(),
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { tapArmed, arm } = useLibraryDeleteArm();

  useEffect(() => {
    setNotebooks(listWhiteboardNotebooks());
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const remove = async (id: string) => {
    try {
      if (onDelete) await onDelete(id);
      else await deleteWhiteboardNotebook(id);
      arm();
    } catch {
      /* ignore */
    }
    const next = listWhiteboardNotebooks();
    setNotebooks(next);
    setPendingId(null);
    if (next.length < WHITEBOARD_LIBRARY_LIMIT) onFreed();
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
        aria-label="Whiteboard library full"
      >
        <div className="lc-settings-head">
          <h2>Whiteboard library full</h2>
          <p className="lc-muted">
            At most {WHITEBOARD_LIBRARY_LIMIT} notebooks.{" "}
            {tapArmed
              ? "Tap a notebook to delete it."
              : "Hold to delete one."}{" "}
            Trash on this device lasts three days.
          </p>
        </div>
        <div className="lc-settings-body">
          <div className="lc-settings-choice">
            {notebooks.map((entry) => (
              <div key={entry.id} className="lc-scratch-load-entry">
                <HoldButton
                  label={`Delete ${entry.title}`}
                  className="lc-hold-choice lc-hold-danger lc-scratch-load-hold"
                  disabled={Boolean(entry.locked)}
                  ariaLabel={
                    entry.locked
                      ? `${entry.title} is locked`
                      : tapArmed
                        ? `Delete ${entry.title} — tap to delete`
                        : `Delete ${entry.title} — hold to delete`
                  }
                  onTap={
                    !entry.locked && tapArmed ? () => void remove(entry.id) : undefined
                  }
                  onConfirm={() => {
                    if (entry.locked) return;
                    if (tapArmed) void remove(entry.id);
                    else setPendingId(entry.id);
                  }}
                >
                  <strong>Delete · {entry.title}</strong>
                  <span className="lc-muted">
                    {entry.pageCount} page{entry.pageCount === 1 ? "" : "s"} ·{" "}
                    {new Date(entry.updatedAt).toLocaleString()}
                  </span>
                </HoldButton>
                <LibraryPadlock
                  name={entry.title}
                  locked={Boolean(entry.locked)}
                  onToggle={() => {
                    setWhiteboardNotebookLocked(entry.id, !entry.locked);
                    setNotebooks(listWhiteboardNotebooks());
                  }}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="lc-settings-foot">
          <button type="button" className="lc-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
      {pendingId && (
        <ConfirmDialog
          title="Remove this notebook?"
          message="It leaves the live library."
          detail={TOMBSTONE_COPY}
          confirmLabel="Delete"
          onConfirm={() => void remove(pendingId)}
          onCancel={() => setPendingId(null)}
        />
      )}
    </div>
  );
}
