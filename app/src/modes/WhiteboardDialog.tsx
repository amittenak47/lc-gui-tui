/**
 * Scratchpad leave / entry menus — save, discard, load, or start blank.
 */

import { useEffect, useState } from "react";

import { HoldButton } from "../components/HoldButton";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  deleteWhiteboardNotebook,
  listWhiteboardNotebooks,
  type WhiteboardNotebookMeta,
} from "../util/whiteboardStore";
import { TOMBSTONE_COPY } from "../util/padSync";
import {
  listPadSnapshots,
  PAD_SNAPSHOT_TIERS,
  type PadSnapshotMeta,
} from "../util/padSnapshotStore";

export type ScratchLeaveChoice = "save" | "discard" | "load";
export type ScratchEntryChoice = "new" | "load" | "save" | "snapshot";

interface LeaveProps {
  mode: "leave";
  /**
   * Anything has been written since the notebook was opened or last saved.
   *
   * When nothing has, Discard has nothing to discard — see the button below.
   */
  dirty?: boolean;
  pending: boolean;
  exiting?: boolean;
  error: string | null;
  onChoose: (choice: ScratchLeaveChoice, notebookId?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string) => void | Promise<void>;
}

interface EntryProps {
  mode: "entry";
  pending?: boolean;
  exiting?: boolean;
  error?: string | null;
  /** When already inside a notebook, offer Save alongside New / Load. */
  allowSave?: boolean;
  /** Notebook id — used to list rolling snapshots. */
  snapshotKey?: string | null;
  onChoose: (choice: ScratchEntryChoice, notebookId?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string) => void | Promise<void>;
  archived?: WhiteboardNotebookMeta[];
  onRestoreArchive?: (id: string) => void | Promise<void>;
}

export type WhiteboardDialogProps = LeaveProps | EntryProps;

export function WhiteboardDialog(props: WhiteboardDialogProps) {
  const [notebooks, setNotebooks] = useState<WhiteboardNotebookMeta[]>(() =>
    listWhiteboardNotebooks(),
  );
  const [pickingLoad, setPickingLoad] = useState(false);
  const [pickingSnapshots, setPickingSnapshots] = useState(false);
  const [snapshots, setSnapshots] = useState<PadSnapshotMeta[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    setNotebooks(listWhiteboardNotebooks());
    setPickingLoad(false);
    setPickingSnapshots(false);
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
  const snapshotKey = props.mode === "entry" ? props.snapshotKey ?? null : null;
  const dirty = props.mode !== "leave" || props.dirty !== false;
  const locked = pending || exiting;

  const refreshList = () => setNotebooks(listWhiteboardNotebooks());

  const openSnapshots = () => {
    setPickingSnapshots(true);
    if (!snapshotKey) {
      setSnapshots([]);
      return;
    }
    void listPadSnapshots("whiteboard", snapshotKey).then(setSnapshots);
  };

  const removeNotebook = (id: string) => {
    setPendingId(id);
  };

  const confirmRemove = async (id: string) => {
    try {
      if (props.onDelete) await props.onDelete(id);
      else await deleteWhiteboardNotebook(id);
    } catch {
      /* ignore */
    }
    setPendingId(null);
    refreshList();
  };

  const archived = props.mode === "entry" ? props.archived ?? [] : [];

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
        aria-label={isLeave ? "Leave whiteboard?" : "Open whiteboard"}
      >
        <div className="lc-settings-head">
          <h2>{isLeave ? "Leave whiteboard?" : "Whiteboard"}</h2>
          <p className="lc-muted">
            {pickingSnapshots
              ? "Hold a snapshot to roll this notebook back. Latest autosave is the live library entry."
              : pickingLoad
              ? "Hold an entry to open it, or hold its bin to delete it."
              : isLeave
                ? dirty
                  ? "Discard undoes everything written since this notebook was opened. Hold to confirm."
                  : "Nothing written since the last save — leaving changes nothing."
                : allowSave
                  ? "Save this notebook, load another, or start blank."
                  : "Start blank or load a saved notebook."}
          </p>
        </div>

        <div className="lc-settings-body">
          {error && <div className="lc-warning">{error}</div>}

          {pickingSnapshots ? (
            <div className="lc-settings-choice">
              {PAD_SNAPSHOT_TIERS.map((tier) => {
                const row = snapshots.find((snap) => snap.tier === tier.id);
                return (
                  <HoldButton
                    key={tier.id}
                    label={`Restore ${tier.label} snapshot`}
                    className="lc-hold-choice"
                    disabled={locked || !row}
                    onConfirm={() => {
                      if (props.mode !== "entry") return;
                      props.onChoose("snapshot", tier.id);
                    }}
                    resetKey={error}
                  >
                    <strong>{tier.label}</strong>
                    <span className="lc-muted">
                      {row
                        ? new Date(row.writtenAt).toLocaleString()
                        : "No snapshot yet — write on this notebook and wait for autosave."}
                    </span>
                  </HoldButton>
                );
              })}
            </div>
          ) : pickingLoad ? (
            <div className="lc-settings-choice">
              {notebooks.length === 0 && (
                <p className="lc-muted">No saved notebooks yet.</p>
              )}
              {/*
                The row *is* the entry: it carries the card's edge and fill,
                and the trash sits inside it rather than beside it. Two
                separate cards read as two separate things, and the one on the
                right had no label to say which notebook it would delete. A
                button cannot legally nest inside a button, so the entry's own
                surface is the row and the hold target fills what the trash
                leaves.
              */}
              {notebooks.map((entry) => (
                <div key={entry.id} className="lc-scratch-load-entry">
                  <HoldButton
                    label={`Load ${entry.title}`}
                    className="lc-scratch-load-hold"
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
                  {/*
                    Hold to delete, the same as everything else that cannot be
                    undone.

                    The two controls on this row were the wrong way round:
                    *opening* a notebook wanted a deliberate hold, and throwing
                    one away was a single tap on a small target sitting right
                    beside it. A slip on a list of notebooks is not a slip you
                    can take back — the entry and its ink both go.
                  */}
                  <HoldButton
                    label={`Delete ${entry.title}`}
                    className="lc-scratch-load-trash"
                    disabled={locked}
                    onConfirm={() => removeNotebook(entry.id)}
                    resetKey={error}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="15"
                      height="15"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 6h16" />
                      <path d="M9 6V4h6v2" />
                      <path d="M6 6l1 14h10l1-14" />
                      <path d="M10 10v7M14 10v7" />
                    </svg>
                  </HoldButton>
                </div>
              ))}
              {archived.length > 0 && (
                <>
                  <p className="lc-muted">Archived on the PC — restore to the live library.</p>
                  {archived.map((entry) => (
                    <HoldButton
                      key={`arch-${entry.id}`}
                      label={`Restore ${entry.title}`}
                      className="lc-hold-choice"
                      disabled={locked || !props.mode || props.mode !== "entry"}
                      onConfirm={() => {
                        if (props.mode === "entry") void props.onRestoreArchive?.(entry.id);
                      }}
                      resetKey={error}
                    >
                      <strong>Restore · {entry.title}</strong>
                      <span className="lc-muted">
                        {new Date(entry.updatedAt).toLocaleString()}
                      </span>
                    </HoldButton>
                  ))}
                </>
              )}
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
                  {/*
                    Discard, or Exit when there is nothing to discard.
                    
                    They do the same thing — roll back to the baseline — but
                    when the board already *is* the baseline that rollback is a
                    no-op, and calling it Discard asks the writer to confirm
                    throwing away work that is not at risk. Worse, it teaches
                    them to hold the red button on the way out, which is a habit
                    that costs them the day they have not saved.
                  */}
                  <HoldButton
                    label={dirty ? "Discard" : "Exit"}
                    className={
                      dirty ? "lc-hold-choice lc-hold-danger" : "lc-hold-choice"
                    }
                    disabled={locked}
                    onConfirm={() => props.onChoose("discard")}
                    resetKey={error}
                  >
                    {dirty ? "Discard" : "Exit"}
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
                  {allowSave && (
                    <HoldButton
                      label="Restore snapshot"
                      className="lc-hold-choice"
                      disabled={locked || !snapshotKey}
                      onConfirm={openSnapshots}
                    >
                      <strong>Restore snapshot…</strong>
                      <span className="lc-muted">
                        2h / 24h / 7d copies, written while you write.
                      </span>
                    </HoldButton>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="lc-settings-foot">
          {(pickingLoad || pickingSnapshots) && (
            <button
              type="button"
              className="lc-secondary"
              disabled={locked}
              onClick={() => {
                setPickingLoad(false);
                setPickingSnapshots(false);
              }}
            >
              Back
            </button>
          )}
          <button type="button" className="lc-secondary" disabled={locked} onClick={props.onCancel}>
            {isLeave ? "Keep writing" : "Cancel"}
          </button>
        </div>
      </div>
      {pendingId && (
        <ConfirmDialog
          title="Remove this notebook?"
          message="It leaves the library on every device that talks to this PC."
          detail={TOMBSTONE_COPY}
          confirmLabel="Delete"
          onConfirm={() => void confirmRemove(pendingId)}
          onCancel={() => setPendingId(null)}
        />
      )}
    </div>
  );
}
