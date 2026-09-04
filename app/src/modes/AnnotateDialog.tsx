/**
 * Markdown Ink entry / leave menus.
 *
 * Deliberately the same dialog as {@link WhiteboardDialog} down to the class
 * names: the two modes are the same shape of thing — a local surface with a
 * library, saved or discarded on the way out — and a writer who has learned one
 * should not have to learn the other. What differs is only the nouns: documents
 * rather than notebooks, and Open rather than New.
 */

import { useEffect, useRef, useState } from "react";

import { HoldButton } from "../components/HoldButton";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useLibraryDeleteArm } from "../util/armedDelete";
import { DOUBLE_TAP_MS } from "../util/gesture";
import {
  annotateDocLabel,
  deleteAnnotateDoc,
  listAnnotateDocs,
  listAnnotateTrash,
  setAnnotateDocLocked,
  type AnnotateDocMeta,
} from "../util/annotateStore";
import { LibraryPadlock } from "./LibraryPadlock";
import { PadNameField } from "./PadNameField";
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
  | "new"
  /** Open a blank web pad — the globe's own "new". */
  | "page";

/**
 * Which library the reader is standing in.
 *
 * Web pads are annotate documents — same store, same marks, same Save, Recent,
 * Export and Import — so this is one dialog, not two. What differs is every
 * word in it: holding the globe used to offer "Pick a .md, source file, .pdf or
 * .epub to annotate", which is true of the machinery and useless to someone who
 * pressed the browser button.
 */
export type AnnotateDialogKind = "document" | "web";

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
  needsName?: boolean;
  defaultName?: string;
  onChoose: (choice: MdInkLeaveChoice, name?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string) => void | Promise<void>;
  /** Same as the entry dialog — web leave still offers the first-Save name step. */
  kind?: AnnotateDialogKind;
}

interface EntryProps {
  mode: "entry";
  /** Wording and choices. Defaults to the document library. */
  kind?: AnnotateDialogKind;
  pending?: boolean;
  exiting?: boolean;
  error?: string | null;
  /** When a document is already open, offer Save alongside Open / Recent. */
  allowSave?: boolean;
  /** Pad id of the open document — used to list rolling snapshots. */
  snapshotKey?: string | null;
  needsName?: boolean;
  defaultName?: string;
  onChoose: (choice: MdInkEntryChoice, docId?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string) => void | Promise<void>;
  onRestoreTrash?: (id: string) => void | Promise<void>;
  onRename?: (id: string, title: string) => void | Promise<void>;
}

export type AnnotateDialogProps = LeaveProps | EntryProps;

export function AnnotateDialog(props: AnnotateDialogProps) {
  const [docs, setDocs] = useState<AnnotateDocMeta[]>(() => listAnnotateDocs());
  const [trash, setTrash] = useState<AnnotateDocMeta[]>(() => listAnnotateTrash());
  const [pickingRecent, setPickingRecent] = useState(false);
  const [pickingSnapshots, setPickingSnapshots] = useState(false);
  /** Naming a new note. Null when the dialog is not on that step. */
  const [newTitle, setNewTitle] = useState<string | null>(null);
  const [saveTitle, setSaveTitle] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<PadSnapshotMeta[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const lastTapRef = useRef({ id: "", at: 0 });
  const { tapArmed, arm } = useLibraryDeleteArm();

  useEffect(() => {
    setDocs(listAnnotateDocs());
    setTrash(listAnnotateTrash());
    setPickingRecent(false);
    setPickingSnapshots(false);
    setSaveTitle(null);
    setRenamingId(null);
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
  const isWeb = props.kind === "web";
  const locked = pending || exiting;
  const needsName = Boolean(props.needsName);
  const defaultName = props.defaultName?.trim() || "";
  const onRename = entry?.onRename;

  const visibleDocs = docs.filter((doc) =>
    isWeb ? doc.docType === "web" : doc.docType !== "web",
  );
  const visibleTrash = (props.mode === "entry" ? trash : []).filter((doc) =>
    isWeb ? doc.docType === "web" : doc.docType !== "web",
  );

  const refreshList = () => {
    setDocs(listAnnotateDocs());
    setTrash(listAnnotateTrash());
  };

  const beginSave = () => {
    if (needsName && saveTitle === null) {
      setSaveTitle(defaultName);
      return;
    }
    if (!needsName) {
      props.onChoose("save");
      return;
    }
    const title = (saveTitle ?? defaultName).trim() || defaultName;
    props.onChoose("save", title || undefined);
  };

  const commitRename = async (id: string) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next) return;
    await onRename?.(id, next);
    refreshList();
  };

  const tapLoadRow = (id: string, currentTitle: string) => {
    const now = Date.now();
    if (lastTapRef.current.id === id && now - lastTapRef.current.at < DOUBLE_TAP_MS) {
      lastTapRef.current = { id: "", at: 0 };
      setRenamingId(id);
      setRenameDraft(currentTitle);
      return;
    }
    lastTapRef.current = { id, at: now };
  };

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
    refreshList();
  };

  const archived = visibleTrash;

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
        aria-label={isLeave ? "Leave document?" : isWeb ? "Web pad" : "Document pad"}
      >
        <div className="lc-settings-head">
          <h2>{isLeave ? "Leave document?" : isWeb ? "Pages" : "Document"}</h2>
          <p className="lc-muted">
            {saveTitle !== null
              ? "Name this pad. Hold Save to keep the suggested name."
              : newTitle !== null
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
                : isWeb
                  ? allowSave
                    ? "Save these marks, open another page, or reopen one you kept."
                    : "Open a page to read and mark up, or reopen one you kept."
                  : allowSave
                    ? "Save these annotations, start a second set on this file, or open another document."
                    : "Write a new note, open a document to annotate, or reopen a recent one."}
          </p>
        </div>

        <div className="lc-settings-body">
          {error && <div className="lc-warning">{error}</div>}

          {saveTitle !== null ? (
            <div className="lc-settings-choice">
              <PadNameField
                value={saveTitle}
                placeholder={defaultName || "Untitled"}
                disabled={locked}
                autoFocus
                onChange={setSaveTitle}
                onSubmit={beginSave}
              />
              <HoldButton
                label="Save"
                className="lc-hold-choice"
                disabled={locked}
                onConfirm={beginSave}
                resetKey={error}
              >
                <strong>Save</strong>
                <span className="lc-muted">
                  {isWeb ? "Keep these marks." : "Keep these annotations."}
                </span>
              </HoldButton>
            </div>
          ) : newTitle !== null && entry ? (
            <div className="lc-settings-choice">
              <PadNameField
                value={newTitle}
                placeholder="Untitled"
                disabled={locked}
                autoFocus
                onChange={setNewTitle}
                onSubmit={() => entry.onChoose("new", newTitle.trim() || "Untitled")}
              />
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
              {visibleDocs.length === 0 && (
                <p className="lc-muted">{isWeb ? "No saved pages yet." : "Nothing annotated yet."}</p>
              )}
              {visibleDocs.map((doc) => {
                const title = annotateDocLabel(doc);
                return (
                <div key={doc.id} className="lc-scratch-load-entry">
                  {renamingId === doc.id ? (
                    <PadNameField
                      value={renameDraft}
                      disabled={locked}
                      autoFocus
                      onChange={setRenameDraft}
                      onSubmit={() => void commitRename(doc.id)}
                      onBlur={() => void commitRename(doc.id)}
                    />
                  ) : (
                  <HoldButton
                    label={`Open ${title}`}
                    className="lc-scratch-load-hold"
                    disabled={locked}
                    onTap={onRename ? () => tapLoadRow(doc.id, title) : undefined}
                    onConfirm={() => entry.onChoose("recent", doc.id)}
                    resetKey={error}
                  >
                    <strong>{title}</strong>
                    <span className="lc-muted">
                      Annotated {new Date(doc.updatedAt).toLocaleString()}
                    </span>
                  </HoldButton>
                  )}
                  {renamingId !== doc.id && (
                  <>
                  <LibraryPadlock
                    name={title}
                    locked={Boolean(doc.locked)}
                    disabled={locked}
                    onToggle={() => {
                      setAnnotateDocLocked(doc.id, !doc.locked);
                      refreshList();
                    }}
                  />
                  {!doc.locked && (
                  <HoldButton
                    label={`Delete annotations for ${title}`}
                    className="lc-scratch-load-trash"
                    disabled={locked}
                    ariaLabel={
                      tapArmed
                        ? `Delete annotations for ${title} — tap to delete`
                        : `Delete annotations for ${title} — hold to delete`
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
                  </>
                  )}
                </div>
              );
              })}
              {archived.length > 0 && (
                <>
                  <p className="lc-muted">Trash on this device — three days, then gone.</p>
                  {archived.map((doc) => (
                    <HoldButton
                      key={`arch-${doc.id}`}
                      label={`Restore ${annotateDocLabel(doc)}`}
                      className="lc-hold-choice"
                      disabled={locked}
                      onConfirm={() => {
                        if (props.mode !== "entry") return;
                        void (async () => {
                          await props.onRestoreTrash?.(doc.id);
                          refreshList();
                        })();
                      }}
                      resetKey={error}
                    >
                      <strong>Restore · {annotateDocLabel(doc)}</strong>
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
                    onConfirm={beginSave}
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
                      onConfirm={beginSave}
                    >
                      <strong>Save</strong>
                      <span className="lc-muted">Keep these annotations.</span>
                    </HoldButton>
                  )}
                  {isWeb ? (
                    <HoldButton
                      label="New page"
                      className="lc-hold-choice"
                      disabled={locked}
                      onConfirm={() => props.onChoose("page")}
                    >
                      <strong>New page…</strong>
                      <span className="lc-muted">
                        A browser tab. Read it live, then freeze it to mark it up.
                      </span>
                    </HoldButton>
                  ) : (
                    <>
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
                    </>
                  )}
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
                    disabled={locked || (visibleDocs.length === 0 && archived.length === 0)}
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
          {(pickingRecent || pickingSnapshots || newTitle !== null || saveTitle !== null) && (
            <button
              type="button"
              className="lc-secondary"
              disabled={locked}
              onClick={() => {
                setPickingRecent(false);
                setPickingSnapshots(false);
                setNewTitle(null);
                setSaveTitle(null);
                setRenamingId(null);
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
