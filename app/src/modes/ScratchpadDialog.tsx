/**
 * Scratchpad leave / entry menus — save, discard, load, or start blank.
 */

import { useEffect, useState } from "react";

import { HoldButton } from "../components/HoldButton";
import {
  listScratchNotebooks,
  type ScratchNotebookMeta,
} from "../util/scratchpadStore";

export type ScratchLeaveChoice = "save" | "discard" | "load";
export type ScratchEntryChoice = "new" | "load";

interface LeaveProps {
  mode: "leave";
  pending: boolean;
  error: string | null;
  onChoose: (choice: ScratchLeaveChoice, notebookId?: string) => void;
  onCancel: () => void;
}

interface EntryProps {
  mode: "entry";
  pending?: boolean;
  error?: string | null;
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
      if (event.key === "Escape" && !props.pending) props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const pending = Boolean(props.pending);
  const error = props.error ?? null;
  const isLeave = props.mode === "leave";

  return (
    <div
      className="lc-settings-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) props.onCancel();
      }}
    >
      <div
        className="lc-settings-modal lc-attempt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={isLeave ? "Leave scratchpad?" : "Open scratchpad"}
      >
        <div className="lc-settings-head">
          <h2>{isLeave ? "Leave scratchpad?" : "Open scratchpad"}</h2>
          <p className="lc-muted">
            {pickingLoad
              ? "Pick a saved notebook"
              : isLeave
                ? "Hold to confirm."
                : "Quick tap opens blank. Hold the icon for this menu."}
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
                <HoldButton
                  key={entry.id}
                  label={`Load ${entry.title}`}
                  className="lc-hold-choice"
                  disabled={pending}
                  onConfirm={() => props.onChoose("load", entry.id)}
                  resetKey={error}
                >
                  <strong>{entry.title}</strong>
                  <span className="lc-muted">
                    {entry.pageCount} page{entry.pageCount === 1 ? "" : "s"} ·{" "}
                    {new Date(entry.updatedAt).toLocaleString()}
                  </span>
                </HoldButton>
              ))}
              <button
                type="button"
                className="lc-secondary"
                disabled={pending}
                onClick={() => setPickingLoad(false)}
              >
                Back
              </button>
            </div>
          ) : (
            <div className="lc-settings-choice">
              {isLeave ? (
                <>
                  <HoldButton
                    label="Load"
                    className="lc-hold-choice"
                    disabled={pending || notebooks.length === 0}
                    onConfirm={() => setPickingLoad(true)}
                    resetKey={error}
                  >
                    Load…
                  </HoldButton>
                  <HoldButton
                    label="Save"
                    className="lc-hold-choice"
                    disabled={pending}
                    onConfirm={() => props.onChoose("save")}
                    resetKey={error}
                  >
                    Save
                  </HoldButton>
                  <HoldButton
                    label="Discard"
                    className="lc-hold-choice lc-hold-danger"
                    disabled={pending}
                    onConfirm={() => props.onChoose("discard")}
                    resetKey={error}
                  >
                    Discard
                  </HoldButton>
                </>
              ) : (
                <>
                  <HoldButton
                    label="New notebook"
                    className="lc-hold-choice"
                    disabled={pending}
                    onConfirm={() => props.onChoose("new")}
                  >
                    <strong>New notebook</strong>
                    <span className="lc-muted">Blank first page.</span>
                  </HoldButton>
                  <HoldButton
                    label="Load"
                    className="lc-hold-choice"
                    disabled={pending || notebooks.length === 0}
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
          <button type="button" className="lc-secondary" disabled={pending} onClick={props.onCancel}>
            {isLeave ? "Keep writing" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
