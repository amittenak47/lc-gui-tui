/**
 * Markdown Ink entry / leave menus.
 *
 * Deliberately the same dialog as {@link WhiteboardDialog} down to the class
 * names: the two modes are the same shape of thing — a local surface with a
 * library, saved or discarded on the way out — and a writer who has learned one
 * should not have to learn the other. What differs is only the nouns: documents
 * rather than notebooks, and Open rather than New.
 */

import { useEffect, useState } from "react";

import { HoldButton } from "../components/HoldButton";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useLibraryDeleteArm } from "../util/armedDelete";
import { deleteAnnotateDoc, listAnnotateDocs, listAnnotateTrash, setAnnotateDocLocked, type AnnotateDocMeta } from "../util/annotateStore";
import { LibraryPadlock } from "./LibraryPadlock";
import { TOMBSTONE_COPY } from "../util/padSync";
import {
  listPadSnapshots,
  PAD_SNAPSHOT_TIERS,
  type PadSnapshotMeta,
} from "../util/padSnapshotStore";

export type MdInkLeaveChoice = "save" | "discard";
export type MdInkEntryChoice =
  | "open"
  | "recent"
  | "save"
  | "export"
  | "import"
  | "snapshot"
  /** Start a second set of annotations on the file already open. */
  | "fork"
  /** Write a new markdown note in the app, rather than opening one. */
  | "new";

interface LeaveProps {
  mode: "leave";
  /**
   * Anything has been annotated since the document was opened or last saved.
   *
   * When nothing has, Discard has nothing to discard — see the button below.
   */
  dirty?: boolean;
  /** Name of the document being annotated, for the prompt. */
  docName: string;
  pending: boolean;
  exiting?: boolean;
  error: string | null;
  onChoose: (choice: MdInkLeaveChoice) => void;
  onCancel: () => void;
  onDelete?: (id: string) => void | Promise<void>;
}

interface EntryProps {
  mode: "entry";
  pending?: boolean;
  exiting?: boolean;
  error?: string | null;
  /** When a document is already open, offer Save alongside Open / Recent. */
  allowSave?: boolean;
  /** Pad id of the open document — used to list rolling snapshots. */
  snapshotKey?: string | null;
  onChoose: (choice: MdInkEntryChoice, docId?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string) => void | Promise<void>;
  onRestoreTrash?: (id: string) => void | Promise<void>;
}

export type AnnotateDialogProps = LeaveProps | EntryProps;

export function AnnotateDialog(props: AnnotateDialogProps) {
  const [docs, setDocs] = useState<AnnotateDocMeta[]>(() => listAnnotateDocs());
  const [trash, setTrash] = useState<AnnotateDocMeta[]>(() => listAnnotateTrash());
  const [pickingRecent, setPickingRecent] = useState(false);
  const [pickingSnapshots, setPickingSnapshots] = useState(false);
  /** Naming a new note. Null when the dialog is not on that step. */
  const [newTitle, setNewTitle] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<PadSnapshotMeta[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { tapArmed, arm } = useLibraryDeleteArm();

  useEffect(() => {
    setDocs(listAnnotateDocs());
    setTrash(listAnnotateTrash());
    setPickingRecent(false);
    setPickingSnapshots(false);
  }, [props.mode]);

  const snapshotKey = props.mode === "entry" ? props.snapshotKey ?? null : null;

  const openSnapshots = () => {
    setPickingSnapshots(true);
    if (!snapshotKey) {
      setSnapshots([]);
      return;
    }
    void listPadSnapshots("annotate", snapshotKey).then(setSnapshots);
  };

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
  const dirty = props.mode !== "leave" || props.dirty !== false;
  // Only the entry dialog lists documents — leaving one is a save/discard
  // decision about the ink in hand, not a moment to go opening another.
  const entry = props.mode === "entry" ? props : null;
  const allowSave = Boolean(entry?.allowSave);
  const locked = pending || exiting;

  const removeDoc = (id: string) => setPendingId(id);

  const confirmRemove = async (id: string) => {
    try {
      if (props.onDelete) await props.onDelete(id);
      else await deleteAnnotateDoc(id);
      arm();
    } catch {
      /* ignore */
    }
    setPendingId(null);
    setDocs(listAnnotateDocs());
    setTrash(listAnnotateTrash());
  };

  const archived = props.mode === "entry" ? trash : [];

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
        aria-label={isLeave ? "Leave document?" : "Document pad"}
      >
        <div className="lc-settings-head">
          <h2>{isLeave ? "Leave document?" : "Document"}</h2>
          <p className="lc-muted">
            {newTitle !== null
              ? "Name the note. It lives in this app — there is no file on disk until you export it."
              : pickingSnapshots
              ? "Hold a snapshot to roll this file back. Latest autosave is the live library entry."
              : pickingRecent
              ? tapArmed
                ? "Hold a document to reopen it. Tap a bin to remove its annotations."
                : "Hold a document to reopen it, or hold its bin to remove its annotations."
              : isLeave
                ? dirty
                  ? "Discard throws away this session's annotations. The file itself is never changed. Hold to confirm."
                  : "Nothing annotated since the last save — leaving changes nothing."
                : allowSave
                  ? "Save these annotations, start a second set on this file, or open another document."
                  : "Write a new note, open a document to annotate, or reopen a recent one."}
          </p>
        </div>

        <div className="lc-settings-body">
          {error && <div className="lc-warning">{error}</div>}

          {newTitle !== null && entry ? (
            <div className="lc-settings-choice">
              <label className="lc-md-new-title">
                <span className="lc-muted">Title</span>
                <input
                  type="text"
                  value={newTitle}
                  autoFocus
                  placeholder="Untitled"
                  disabled={locked}
                  onChange={(event) => setNewTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || locked) return;
                    event.preventDefault();
                    entry.onChoose("new", newTitle.trim() || "Untitled");
                  }}
                />
              </label>
              <HoldButton
                label="Create note"
                className="lc-hold-choice"
                disabled={locked}
                onConfirm={() => entry.onChoose("new", newTitle.trim() || "Untitled")}
                resetKey={error}
              >
                <strong>Create</strong>
                <span className="lc-muted">
                  Opens a blank note you can edit, annotate, and link to.
                </span>
              </HoldButton>
            </div>
          ) : pickingSnapshots && entry ? (
            <div className="lc-settings-choice">
              {PAD_SNAPSHOT_TIERS.map((tier) => {
                const row = snapshots.find((snap) => snap.tier === tier.id);
                return (
                  <HoldButton
                    key={tier.id}
                    label={`Restore ${tier.label} snapshot`}
                    className="lc-hold-choice"
                    disabled={locked || !row}
                    onConfirm={() => entry.onChoose("snapshot", tier.id)}
                    resetKey={error}
                  >
                    <strong>{tier.label}</strong>
                    <span className="lc-muted">
                      {row
                        ? new Date(row.writtenAt).toLocaleString()
                        : "No snapshot yet — write on this file and wait for autosave."}
                    </span>
                  </HoldButton>
                );
              })}
            </div>
          ) : pickingRecent && entry ? (
            <div className="lc-settings-choice">
              {docs.length === 0 && <p className="lc-muted">Nothing annotated yet.</p>}
              {docs.map((doc) => (
                <div key={doc.id} className="lc-scratch-load-entry">
                  <HoldButton
                    label={`Open ${doc.name}`}
                    className="lc-scratch-load-hold"
                    disabled={locked}
                    onConfirm={() => entry.onChoose("recent", doc.id)}
                    resetKey={error}
                  >
                    <strong>{doc.name}</strong>
                    <span className="lc-muted">
                      Annotated {new Date(doc.updatedAt).toLocaleString()}
                    </span>
                  </HoldButton>
                  <LibraryPadlock
                    name={doc.name}
                    locked={Boolean(doc.locked)}
                    disabled={locked}
                    onToggle={() => {
                      setAnnotateDocLocked(doc.id, !doc.locked);
                      setDocs(listAnnotateDocs());
    setTrash(listAnnotateTrash());
                    }}
                  />
                  {!doc.locked && (
                  <HoldButton
                    label={`Delete annotations for ${doc.name}`}
                    className="lc-scratch-load-trash"
                    disabled={locked}
                    ariaLabel={
                      tapArmed
                        ? `Delete annotations for ${doc.name} — tap to delete`
                        : `Delete annotations for ${doc.name} — hold to delete`
                    }
                    onTap={tapArmed ? () => void confirmRemove(doc.id) : undefined}
                    onConfirm={() => {
                      if (tapArmed) void confirmRemove(doc.id);
                      else removeDoc(doc.id);
                    }}
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
                  )}
                </div>
              ))}
              {archived.length > 0 && (
                <>
                  <p className="lc-muted">Trash on this device — three days, then gone.</p>
                  {archived.map((doc) => (
                    <HoldButton
                      key={`arch-${doc.id}`}
                      label={`Restore ${doc.name}`}
                      className="lc-hold-choice"
                      disabled={locked}
                      onConfirm={() => {
                        if (props.mode === "entry") void props.onRestoreTrash?.(doc.id);
                      }}
                      resetKey={error}
                    >
                      <strong>Restore · {doc.name}</strong>
                      <span className="lc-muted">{new Date(doc.updatedAt).toLocaleString()}</span>
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
                    label="Save"
                    className="lc-hold-choice"
                    disabled={locked}
                    onConfirm={() => props.onChoose("save")}
                    resetKey={error}
                  >
                    <strong>Save annotations</strong>
                    <span className="lc-muted">
                      Keep this ink with “{(props as LeaveProps).docName}”.
                    </span>
                  </HoldButton>
                  {/* Discard, or Exit when there is nothing to discard — see
                      WhiteboardDialog for why the label moves. */}
                  <HoldButton
                    label={dirty ? "Discard" : "Exit"}
                    className={
                      dirty ? "lc-hold-choice lc-hold-danger" : "lc-hold-choice"
                    }
                    disabled={locked}
                    onConfirm={() => props.onChoose("discard")}
                    resetKey={error}
                  >
                    <strong>{dirty ? "Discard annotations" : "Exit"}</strong>
                    <span className="lc-muted">The file on disk is left alone.</span>
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
                      <span className="lc-muted">Keep these annotations.</span>
                    </HoldButton>
                  )}
                  <HoldButton
                    label="New file"
                    className="lc-hold-choice"
                    disabled={locked}
                    onConfirm={() => setNewTitle("")}
                  >
                    <strong>New file…</strong>
                    <span className="lc-muted">
                      A markdown note you write here, and can edit.
                    </span>
                  </HoldButton>
                  <HoldButton
                    label="Open document"
                    className="lc-hold-choice"
                    disabled={locked}
                    onConfirm={() => props.onChoose("open")}
                  >
                    <strong>Open document…</strong>
                    <span className="lc-muted">
                      Pick a .md, source file, .pdf or .epub to annotate.
                    </span>
                  </HoldButton>
                  {allowSave && (
                    <HoldButton
                      label="New annotation set on this file"
                      className="lc-hold-choice"
                      disabled={locked}
                      onConfirm={() => props.onChoose("fork")}
                    >
                      <strong>New annotation set…</strong>
                      <span className="lc-muted">
                        A second blank board over the same file. This one is kept.
                      </span>
                    </HoldButton>
                  )}
                  <HoldButton
                    label="Recent"
                    className="lc-hold-choice"
                    disabled={locked || docs.length === 0}
                    onConfirm={() => setPickingRecent(true)}
                  >
                    <strong>Recent…</strong>
                    <span className="lc-muted">Reopen something already annotated.</span>
                  </HoldButton>
                  {/*
                    Annotations live in this browser's storage, which is fine
                    until the tablet is not the device you have. The sidecar is
                    the way out and back in — a file to keep beside the source.
                  */}
                  {allowSave && (
                    <HoldButton
                      label="Restore snapshot"
                      className="lc-hold-choice"
                      disabled={locked || !snapshotKey}
                      onConfirm={openSnapshots}
                    >
                      <strong>Restore snapshot…</strong>
                      <span className="lc-muted">
                        2h / 24h / 7d copies, written while you annotate.
                      </span>
                    </HoldButton>
                  )}
                  {allowSave && (
                    <HoldButton
                      label="Export annotations"
                      className="lc-hold-choice"
                      disabled={locked}
                      onConfirm={() => props.onChoose("export")}
                    >
                      <strong>Export annotations…</strong>
                      <span className="lc-muted">
                        Downloads a .lc-ink.json.gz to this device’s Downloads folder.
                      </span>
                    </HoldButton>
                  )}
                  <HoldButton
                    label="Import annotations"
                    className="lc-hold-choice"
                    disabled={locked}
                    onConfirm={() => props.onChoose("import")}
                  >
                    <strong>Import annotations…</strong>
                    <span className="lc-muted">Open a sidecar exported elsewhere.</span>
                  </HoldButton>
                </>
              )}
            </div>
          )}
        </div>

        <div className="lc-settings-foot">
          {(pickingRecent || pickingSnapshots || newTitle !== null) && (
            <button
              type="button"
              className="lc-secondary"
              disabled={locked}
              onClick={() => {
                setPickingRecent(false);
                setPickingSnapshots(false);
                setNewTitle(null);
              }}
            >
              Back
            </button>
          )}
          <button type="button" className="lc-secondary" disabled={locked} onClick={props.onCancel}>
            {isLeave ? "Keep annotating" : "Cancel"}
          </button>
        </div>
      </div>
      {pendingId && (
        <ConfirmDialog
          title="Remove this document?"
          message="It leaves the live library."
          detail={TOMBSTONE_COPY}
          confirmLabel="Delete"
          onConfirm={() => void confirmRemove(pendingId)}
          onCancel={() => setPendingId(null)}
        />
      )}
    </div>
  );
}
