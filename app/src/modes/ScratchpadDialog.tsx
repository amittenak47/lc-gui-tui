/**
 * Scratchpad leave / entry menus — save, discard, load, or start blank.
 */

import { useEffect, useState } from "react";

import { HoldButton } from "../components/HoldButton";
import {
  deleteScratchNotebook,
  listScratchNotebooks,
  type ScratchNotebookMeta,
} from "../util/scratchpadStore";

export type ScratchLeaveChoice = "save" | "discard" | "load";
export type ScratchEntryChoice = "new" | "load" | "save";

interface LeaveProps {
  mode: "leave";
  pending: boolean;
  exiting?: boolean;
  error: string | null;
  onChoose: (choice: ScratchLeaveChoice, notebookId?: string) => void;
  onCancel: () => void;
}

interface EntryProps {
  mode: "entry";
  pending?: boolean;
  exiting?: boolean;
  error?: string | null;
  /** When already inside a notebook, offer Save alongside New / Load. */
  allowSave?: boolean;
  onChoose: (choice: ScratchEntryChoice, notebookId?: string) => void;
  onCancel: () => void;
}

export type ScratchpadDialogProps = LeaveProps | EntryProps;

export function ScratchpadDialog(props: ScratchpadDialogProps) {
  const [notebooks, setNotebooks] = useState<ScratchNotebookMeta[]>(() =>
    listScratchNotebooks(),
  );
  const [pickingLoad, setPickingLoad] = useState(false);

  useEffect(() => {
    setNotebooks(listScratchNotebooks());
    setPickingLoad(false);
  }, [props.mode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !props.pending && !props.exiting) props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const pending = Boolean(props.pending);
  const exiting = Boolean(props.exiting);
  const error = props.error ?? null;
  const isLeave = props.mode === "leave";
  const allowSave = props.mode === "entry" && Boolean(props.allowSave);
  const locked = pending || exiting;

  const refreshList = () => setNotebooks(listScratchNotebooks());

  const removeNotebook = (id: string) => {
    deleteScratchNotebook(id);
    refreshList();
  };

  return (
    <div
      className={["lc-settings-backdrop", exiting && "lc-leave-dialog-exit"]
        .filter(Boolean)
        .join(" ")}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !locked) props.onCancel();
      }}
    >
      <div
        className="lc-settings-modal lc-attempt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={isLeave ? "Leave scratchpad?" : "Open scratchpad"}
      >
        <div className="lc-settings-head">
          <h2>{isLeave ? "Leave scratchpad?" : "Scratchpad"}</h2>
          <p className="lc-muted">
            {pickingLoad
              ? "Pick a saved notebook — trash removes it."
              : isLeave
                ? "Hold to confirm."
                : allowSave
                  ? "Save this notebook, load another, or start blank."
                  : "Start blank or load a saved notebook."}
          </p>
        </div>

        <div className="lc-settings-body">
          {error && <div className="lc-warning">{error}</div>}

          {pickingLoad ? (
            <div className="lc-settings-choice">
              {notebooks.length === 0 && (
                <p className="lc-muted">No saved notebooks yet.</p>
              )}
              {notebooks.map((entry) => (
                <div key={entry.id} className="lc-scratch-load-row">
                  <HoldButton
                    label={`Load ${entry.title}`}
                    className="lc-hold-choice lc-scratch-load-hold"
                    disabled={locked}
                    onConfirm={() => props.onChoose("load", entry.id)}
                    resetKey={error}
                  >
                    <strong>{entry.title}</strong>
                    <span className="lc-muted">
                      {entry.pageCount} page{entry.pageCount === 1 ? "" : "s"} ·{" "}
                      {new Date(entry.updatedAt).toLocaleString()}
                    </span>
                  </HoldButton>
                  <button
                    type="button"
                    className="lc-scratch-load-trash"
                    aria-label={`Delete ${entry.title}`}
                    title="Delete notebook"
                    disabled={locked}
                    onClick={() => removeNotebook(entry.id)}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="lc-settings-choice">
              {isLeave ? (
                <>
                  <HoldButton
                    label="Load"
                    className="lc-hold-choice"
                    disabled={locked || notebooks.length === 0}
                    onConfirm={() => setPickingLoad(true)}
                    resetKey={error}
                  >
                    Load…
                  </HoldButton>
                  <HoldButton
                    label="Save"
                    className="lc-hold-choice"
                    disabled={locked}
                    onConfirm={() => props.onChoose("save")}
                    resetKey={error}
                  >
                    Save
                  </HoldButton>
                  <HoldButton
                    label="Discard"
                    className="lc-hold-choice lc-hold-danger"
                    disabled={locked}
                    onConfirm={() => props.onChoose("discard")}
                    resetKey={error}
                  >
                    Discard
                  </HoldButton>
                </>
              ) : (
                <>
                  {allowSave && (
                    <HoldButton
                      label="Save"
                      className="lc-hold-choice"
                      disabled={locked}
                      onConfirm={() => props.onChoose("save")}
                    >
                      <strong>Save</strong>
                      <span className="lc-muted">Keep this notebook in the library.</span>
                    </HoldButton>
                  )}
                  <HoldButton
                    label="New notebook"
                    className="lc-hold-choice"
                    disabled={locked}
                    onConfirm={() => props.onChoose("new")}
                  >
                    <strong>New notebook</strong>
                    <span className="lc-muted">Blank first page.</span>
                  </HoldButton>
                  <HoldButton
                    label="Load"
                    className="lc-hold-choice"
                    disabled={locked || notebooks.length === 0}
                    onConfirm={() => setPickingLoad(true)}
                  >
                    <strong>Load…</strong>
                    <span className="lc-muted">Open a saved notebook.</span>
                  </HoldButton>
                </>
              )}
            </div>
          )}
        </div>

        <div className="lc-settings-foot">
          {pickingLoad && (
            <button
              type="button"
              className="lc-secondary"
              disabled={locked}
              onClick={() => setPickingLoad(false)}
            >
              Back
            </button>
          )}
          <button type="button" className="lc-secondary" disabled={locked} onClick={props.onCancel}>
            {isLeave ? "Keep writing" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
