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
import { HubLibraryRefresh, type HubLibraryRefreshAction } from "../components/HubLibraryRefresh";
import { useLibraryDeleteArm } from "../util/armedDelete";
import { DOUBLE_TAP_MS } from "../util/gesture";
import { shouldDismissBackdrop } from "../util/backdropDismiss";
import {
  annotateDocLabel,
  ANNOTATE_LIBRARY_EVENT,
  trashAnnotateDoc,
  listAnnotateDocs,
  listAnnotateTrash,
  setAnnotateDocLocked,
  type AnnotateDocMeta,
} from "../util/annotateStore";
import { LibraryPadlock } from "./LibraryPadlock";
import { PadNameField } from "./PadNameField";
import { LibraryTimes } from "./LibraryTimes";
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
  | "export-document"
  | "export-pdf"
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
  onRefreshHub?: HubLibraryRefreshAction;
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
  docType?: string;
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
  const [section, setSection] = useState<"main" | "new" | "open" | "sets" | "export" | "more">("main");
  const backdropDown = useRef(false);
  /** Naming a new note. Null when the dialog is not on that step. */
  const [newTitle, setNewTitle] = useState<string | null>(null);
  const [saveTitle, setSaveTitle] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<PadSnapshotMeta[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const removingRef = useRef<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const lastTapRef = useRef({ id: "", at: 0 });
  const { tapArmed, arm } = useLibraryDeleteArm();

  useEffect(() => {
    const refresh = () => {
      const live = listAnnotateDocs();
      setDocs(live);
      setTrash(listAnnotateTrash());
      if (removingRef.current && !live.some((row) => row.id === removingRef.current)) {
        removingRef.current = null;
        setRemoving(false);
        arm();
      }
      // The local index commits before hub sync finishes.
      setPendingId((id) => id && live.some((row) => row.id === id) ? id : null);
    };
    window.addEventListener(ANNOTATE_LIBRARY_EVENT, refresh);
    return () => window.removeEventListener(ANNOTATE_LIBRARY_EVENT, refresh);
  }, [arm]);

  useEffect(() => {
    setDocs(listAnnotateDocs());
    setTrash(listAnnotateTrash());
    setPickingRecent(false);
    setPickingSnapshots(false);
    setSection("main");
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

  const currentDoc = docs.find((doc) => doc.id === snapshotKey);
  const visibleDocs = docs.filter((doc) =>
    (isWeb ? doc.docType === "web" : doc.docType !== "web") &&
    (section !== "sets" || (currentDoc && doc.hash === currentDoc.hash)),
  );
  const visibleTrash = (props.mode === "entry" ? trash : []).filter((doc) =>
    (isWeb ? doc.docType === "web" : doc.docType !== "web") &&
    (section !== "sets" || (currentDoc && doc.hash === currentDoc.hash)),
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

  const removeDoc = (id: string) => {
    setRemoveError(null);
    setPendingId(id);
  };

  const confirmRemove = async (id: string) => {
    if (removingRef.current) return;
    removingRef.current = id;
    setRemoving(true);
    setRemoveError(null);
    try {
      if (props.onDelete) await props.onDelete(id);
      else await trashAnnotateDoc(id);
      if (listAnnotateDocs().some((row) => row.id === id)) {
        throw new Error("This document could not be removed. It may be locked.");
      }
      arm();
      setPendingId((pending) => pending === id ? null : pending);
    } catch (cause) {
      if (removingRef.current === id) {
        setRemoveError(cause instanceof Error ? cause.message : "Could not remove this document. Try again.");
      }
    } finally {
      if (removingRef.current === id) {
        removingRef.current = null;
        setRemoving(false);
      }
      refreshList();
    }
  };

  const archived = visibleTrash;

  return (
    <div
      className={["lc-settings-backdrop", exiting && "lc-leave-dialog-exit"]
        .filter(Boolean)
        .join(" ")}
      role="presentation"
      onPointerDownCapture={(event) => { backdropDown.current = event.target === event.currentTarget; }}
      onPointerCancel={() => { backdropDown.current = false; }}
      onClick={(event) => {
        const started = backdropDown.current;
        backdropDown.current = false;
        if (!locked && shouldDismissBackdrop(started, event.target, event.currentTarget)) props.onCancel();
      }}
    >
      <div
        className="lc-settings-modal lc-attempt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={isLeave ? "Leave document?" : isWeb ? "Web pad" : "Document pad"}
      >
        <div className="lc-settings-head">
          <h2>{isLeave ? "Leave document?" : section === "new" ? "New" : section === "export" ? "Export" : section === "more" ? "History" : section === "sets" ? "Annotation sets" : section === "open" ? "Open" : isWeb ? "Pages" : "Document"}</h2>
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
                : section === "main"
                  ? currentDoc ? annotateDocLabel(currentDoc) : "Open a document or write a new note."
                  : section === "sets" ? "Keep separate sets of notes on the same file."
                  : section === "more" ? "History and annotation backups."
                  : "Open a file or return to a recent document."}
          </p>
          {props.mode === "entry" && props.onRefreshHub && <HubLibraryRefresh onRefresh={props.onRefreshHub} />}
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
              {section === "sets" && <button type="button" className="lc-secondary" disabled={locked}
                onClick={() => entry.onChoose("fork")}>New annotation set</button>}
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
                    <strong>{doc.name}</strong>
                    {doc.label && <span className="lc-muted">{doc.label}</span>}
                    <LibraryTimes {...doc}/>
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
                <div className="lc-document-menu">
                  {section === "main" && <>
                    {allowSave && <button type="button" className="lc-secondary lc-document-menu-save" disabled={locked} onClick={beginSave}>Save annotations</button>}
                    <button type="button" disabled={locked} onClick={() => setSection("new")}><strong>New</strong><span>{isWeb ? "Web page" : "Markdown file"}</span></button>
                    <button type="button" disabled={locked} onClick={() => setSection("open")}><strong>Open</strong><span>Load files and recent annotation sets</span></button>
                    {allowSave && <button type="button" disabled={locked} onClick={() => setSection("sets")}><strong>Annotation sets</strong><span>Switch, import or export editable notes</span></button>}
                    {allowSave && <button type="button" disabled={locked} onClick={() => setSection("export")}><strong>Export</strong><span>A readable copy with your annotations</span></button>}
                    {allowSave && <button type="button" disabled={locked} onClick={() => setSection("more")}><strong>History</strong></button>}
                  </>}
                  {section === "new" && <button type="button" disabled={locked} onClick={() => isWeb ? props.onChoose("page") : setNewTitle("")}><strong>{isWeb ? "Web page" : "Markdown file"}</strong></button>}
                  {section === "open" && <>
                    {!isWeb && <button type="button" disabled={locked} onClick={() => props.onChoose("open")}><strong>Load file…</strong><span>PDF, EPUB, Markdown or source code</span></button>}
                    <button type="button" disabled={locked || (!visibleDocs.length && !archived.length)} onClick={() => setPickingRecent(true)}><strong>Recent documents</strong></button>
                    <button type="button" disabled={locked} onClick={() => props.onChoose("import")}><strong>Import annotation set…</strong></button>
                  </>}
                  {section === "sets" && <>
                    <button type="button" disabled={locked} onClick={() => setPickingRecent(true)}><strong>Saved annotation sets</strong><span>Sets for the open file</span></button>
                    <button type="button" disabled={locked} onClick={() => props.onChoose("fork")}><strong>New annotation set</strong></button>
                    <button type="button" disabled={locked} onClick={() => props.onChoose("import")}><strong>Import</strong><span>Editable annotation set</span></button>
                    <button type="button" disabled={locked} onClick={() => props.onChoose("export")}><strong>Export</strong><span>Editable annotation set</span></button>
                  </>}
                  {section === "export" && <>
                    <button type="button" disabled={locked} onClick={() => props.onChoose("export-pdf")}><strong>PDF</strong><span>Document with ink and footnotes</span></button>
                    {entry?.docType !== "pdf" && <button type="button" disabled={locked} onClick={() => props.onChoose("export-document")}><strong>{entry?.docType === "epub" ? "EPUB" : "Markdown + images"}</strong><span>Readable, reflowable text</span></button>}
                  </>}
                  {section === "more" && <>
                    {allowSave && <button type="button" disabled={locked || !snapshotKey} onClick={openSnapshots}><strong>Restore snapshot…</strong><span>Earlier copies of these annotations</span></button>}
                  </>}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="lc-settings-foot">
          {(section !== "main" || pickingRecent || pickingSnapshots || newTitle !== null || saveTitle !== null) && (
            <button
              type="button"
              className="lc-secondary"
              disabled={locked}
              onClick={() => {
                if (!pickingRecent && !pickingSnapshots && newTitle === null && saveTitle === null) setSection("main");
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
          pending={removing}
          error={removeError}
          onConfirm={() => void confirmRemove(pendingId)}
          onCancel={() => setPendingId(null)}
        />
      )}
    </div>
  );
}
