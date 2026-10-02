import {LibraryTrashRow} from "./LibraryTrashRow";
import {useLibraryMorph} from "./useLibraryMorph";
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

import { LIBRARY_HOLD_MS } from "../util/gesture";
import { HoldButton } from "../components/HoldButton";
import { DialogFrame } from "../components/DialogFrame";
import "./annotateDialog.css";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { HubLibraryRefresh, type HubLibraryRefreshAction } from "../components/HubLibraryRefresh";
import { useLibraryDeleteArm } from "../util/armedDelete";
import { DOUBLE_TAP_MS } from "../util/gesture";
import { shouldDismissBackdrop } from "../util/backdropDismiss";
import {
  annotateDocLabel,
  ANNOTATE_LIBRARY_EVENT,
  trashAnnotateDoc,
  deleteAnnotateDoc,
  listAnnotateDocs,
  listAnnotateTrash,
  setAnnotateDocLocked,
  type AnnotateDocMeta,
} from "../util/annotateStore";
import { LibraryPadlock } from "./LibraryPadlock";
import { PadNameField } from "./PadNameField";
import { LibraryMenuRow, LibrarySearch } from "./LibrarySearch";
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
  docId?: string | null;
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
  docName?: string;
  dirty?: boolean;
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

function DocumentIcon({ web = false }: { web?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {web ? <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></> : <path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h7M8 16h5" />}
  </svg>;
}

function MenuRowLabel({ label, description }: { label: string; description?: string }) {
  return <span className="lc-annotate-menu-label">
    <svg className="lc-annotate-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {label === "Save" ? <path d="M4 3h13l3 3v15H4V3Zm3 0v6h9V3M8 21v-8h8v8" /> : label === "Open" ? <path d="M3 7V4h6l3 3h7v4M3 9h18l-3 11H3L1 9h2Z" /> : label === "Pull" ? <path d="M12 3v13m-5-5 5 5 5-5M3 16v5h18v-5" /> : label === "New" ? <path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 14h8M12 10v8" /> : label === "Recent" ? <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2" /> : <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />}
    </svg>
    <span className="lc-annotate-row-copy"><strong>{label}</strong>{description && <span className="lc-muted">{description}</span>}</span>
  </span>;
}

function MainMenuRow({ label, description, disabled, onConfirm }: {
  label: string; description?: string; disabled?: boolean; onConfirm: () => void;
}) {
  return <HoldButton holdMs={LIBRARY_HOLD_MS} label={label} className="lc-hold-choice" disabled={disabled} onConfirm={onConfirm}>
    <MenuRowLabel label={label} description={description} />
  </HoldButton>;
}

export function AnnotateDialog(props: AnnotateDialogProps) {
  const [docs, setDocs] = useState<AnnotateDocMeta[]>(() => listAnnotateDocs());
  const [trash, setTrash] = useState<AnnotateDocMeta[]>(() => listAnnotateTrash());
  const [pickingRecent, setPickingRecent] = useState(false);
  const [pickingSnapshots, setPickingSnapshots] = useState(false);
  const [section, setSection] = useState<"main" | "open" | "new" | "sets" | "export" | "more">("main");
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
  const [libraryFilters,setLibraryFilters] = useState<string[]>([]);
  const [showTrash,setShowTrash] = useState(false);
  const [libraryQuery,setLibraryQuery] = useState("");
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
    setLibraryQuery("");
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
  const contextCandidate = isLeave ? docs.find((doc) => doc.id === props.docId) : currentDoc;
  const contextDoc = contextCandidate && (contextCandidate.docType === "web") === isWeb ? contextCandidate : undefined;
  const hasContext = isLeave || (allowSave && ((entry?.docType ?? contextDoc?.docType) === "web") === isWeb);
  const contextName = hasContext ? props.docName?.trim() || contextDoc?.name || "" : "";
  const syncStatus = contextDoc ? (contextDoc.hubAckUpdatedAt === contextDoc.updatedAt && !props.dirty ? "synced" : "not synced") : null;
  const visibleDocs = docs.filter((doc) =>
    (isWeb ? doc.docType === "web" : doc.docType !== "web") &&
    (section !== "sets" || (currentDoc && doc.hash === currentDoc.hash)),
  );
  const visibleTrash = (props.mode === "entry" ? trash : []).filter((doc) =>
    (isWeb ? doc.docType === "web" : doc.docType !== "web") &&
    (section !== "sets" || (currentDoc && doc.hash === currentDoc.hash)),
  );

  const toggleFilter = (kind: string) => setLibraryFilters(current => current.includes(kind) ? current.filter(item => item !== kind) : [...current, kind]);
  const matchesQuery = (doc: AnnotateDocMeta) => (libraryFilters.length === 0 || libraryFilters.includes(doc.docType)) && `${doc.name} ${doc.label ?? ""}`.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase());

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

  const morphRef = useLibraryMorph(`${section}:${pickingRecent}:${pickingSnapshots}:${newTitle!==null}:${saveTitle!==null}`);
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
      <DialogFrame ref={morphRef}
        className={`lc-attempt-modal lc-library-holds lc-library-menu lc-annotate-dialog ${isWeb ? "lc-library-web" : "lc-library-annotate"}`}
        titleId="lc-annotate-dialog-title"
        title={isLeave ? "Leave document?" : section === "open" && !pickingRecent ? "Open" : section === "new" ? "New" : section === "export" ? "Export" : section === "more" ? "More" : section === "sets" ? "Annotations" : pickingRecent ? "Recents" : isWeb ? "Web" : "Annotate"}
        subtitle={isWeb ? "Write onto a page snapshot" : "Ink for this document"}
        icon={<DocumentIcon web={isWeb} />}
        mode={isWeb ? "browse" : "annotate"}
        shape="blocky"
        ariaLabel={isLeave ? "Leave document?" : isWeb ? "Web pad" : "Document pad"}
        onClose={props.onCancel}
        closeDisabled={locked}
      >
        {contextName && <div className="lc-dialog-context"><div className="lc-annotate-context">
          <DocumentIcon web={isWeb} /><span className="lc-annotate-context-title" title={contextName}>{contextName}</span>
          {syncStatus && <span className="lc-annotate-context-sync">{syncStatus}</span>}
        </div></div>}
        <div className="lc-settings-body lc-dialog-body lc-scroll-pane">
          {(saveTitle !== null || newTitle !== null) && <p className="lc-muted">
            {saveTitle !== null
              ? "Name this pad. Hold Save to keep the suggested name."
              : "Name the note. It lives in this app — there is no file on disk until you export it."}
          </p>}
          {pickingRecent && <LibrarySearch value={libraryQuery} onChange={setLibraryQuery} label={isWeb ? "Search saved pages" : "Search saved documents"} disabled={locked} filters={libraryFilters} onToggleFilter={toggleFilter} kinds={isWeb ? [] : ["pdf","markdown","epub"]} showTrash={showTrash} onTrashChange={setShowTrash}/>}
          {pickingRecent && !(showTrash ? archived : visibleDocs).some(matchesQuery) && <p className="lc-muted">No matching saved items.</p>}
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
              <HoldButton holdMs={LIBRARY_HOLD_MS}
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
              <HoldButton holdMs={LIBRARY_HOLD_MS}
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
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
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
              {(showTrash ? [] : visibleDocs).filter(matchesQuery).map((doc) => {
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
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
                    label={`Open ${title}`}
                    className="lc-scratch-load-hold"
                    disabled={locked}
                    onTap={onRename ? () => tapLoadRow(doc.id, title) : undefined}
                    onConfirm={() => entry.onChoose("recent", doc.id)}
                    resetKey={error}
                  >
                    <strong title={doc.name}>{doc.name}</strong>
                    {doc.label?.trim() && doc.label.trim() !== doc.name.trim() && <span className="lc-muted lc-library-subtitle" title={doc.label}>{doc.label}</span>}
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
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
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
              {showTrash && archived.length > 0 && (
                <>
                  {archived.filter(matchesQuery).map((doc) => (
                    <LibraryTrashRow key={`arch-${doc.id}`} name={annotateDocLabel(doc)} updatedAt={doc.updatedAt} disabled={locked}
                      onRestore={async()=>{if(props.mode!=="entry")return;await props.onRestoreTrash?.(doc.id);refreshList();}}
                      onDelete={async()=>{await deleteAnnotateDoc(doc.id,true);refreshList();}}/>
                  ))}
                </>
              )}
            </div>
          ) : (
            <div className="lc-settings-choice">
              {isLeave ? (
                <div className="lc-document-menu">
                  <LibraryMenuRow label="Save" disabled={locked} onConfirm={beginSave} />
                  <LibraryMenuRow label="Discard" disabled={locked} onConfirm={() => props.onChoose("discard")} />
                </div>
              ) : (
                <div className="lc-document-menu">
                  {section === "main" && <>
                    {allowSave && !isWeb && <MainMenuRow label="Save" description="Save ink to the annotation library" disabled={locked} onConfirm={beginSave} />}
                    {isWeb && <MainMenuRow label="New" description="Start a blank page" disabled={locked} onConfirm={() => props.onChoose("page")} />}
                    {isWeb
                      ? <MainMenuRow label="Recent" description="Reopen a page you were on" disabled={locked || (!visibleDocs.length && !archived.length)} onConfirm={() => setPickingRecent(true)} />
                      : <MainMenuRow label="Open" description="Load ink from a saved file" disabled={locked} onConfirm={() => setSection("open")} />}
                    {props.onRefreshHub && <HubLibraryRefresh onRefresh={props.onRefreshHub} disabled={locked}><MenuRowLabel label="Pull" description={isWeb ? "Fetch pages from your other devices" : "Fetch the latest ink from your other devices"} /></HubLibraryRefresh>}
                    {(!isWeb || allowSave) && <MainMenuRow label="More" disabled={locked} onConfirm={() => setSection("more")} />}
                  </>}
                  {section === "open" && <>
                    <LibraryMenuRow label="Load" disabled={locked} onConfirm={() => props.onChoose("open")} />
                    <LibraryMenuRow label="Recents" disabled={locked || (!visibleDocs.length && !archived.length)} onConfirm={() => setPickingRecent(true)} />
                    {allowSave && <LibraryMenuRow label="Annotations" disabled={locked} onConfirm={() => setSection("sets")} />}
                  </>}
                  {section === "new" && <LibraryMenuRow label="Markdown file" disabled={locked} onConfirm={() => setNewTitle("")} />}
                  {section === "sets" && allowSave && <>
                    <LibraryMenuRow label="New" disabled={locked} onConfirm={() => props.onChoose("fork")} />
                    <LibraryMenuRow label="Saved" disabled={locked} onConfirm={() => setPickingRecent(true)} />
                    <LibraryMenuRow label="Import" disabled={locked} onConfirm={() => props.onChoose("import")} />
                  </>}
                  {section === "export" && <>
                    <LibraryMenuRow label="PDF" disabled={locked} onConfirm={() => props.onChoose("export-pdf")} />
                    <LibraryMenuRow label="Annotations" disabled={locked} onConfirm={() => props.onChoose("export")} />
                    {entry?.docType !== "pdf" && <LibraryMenuRow label={entry?.docType === "epub" ? "EPUB" : "Markdown + images"} disabled={locked} onConfirm={() => props.onChoose("export-document")} />}
                  </>}
                  {section === "more" && <>
                    {!allowSave && !isWeb && <LibraryMenuRow label="New" disabled={locked} onConfirm={() => setSection("new")} />}
                    {isWeb && allowSave && <LibraryMenuRow label="Save" disabled={locked} onConfirm={beginSave} />}
                    {allowSave && !isWeb && <>
                      <LibraryMenuRow label="Export" disabled={locked} onConfirm={() => setSection("export")} />
                      <LibraryMenuRow label="Restore" disabled={locked || !snapshotKey} onConfirm={openSnapshots} />
                    </>}
                  </>}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="lc-settings-foot lc-dialog-foot">
          {(section !== "main" || pickingRecent || pickingSnapshots || newTitle !== null || saveTitle !== null) && (
            <button
              type="button"
              className="lc-secondary lc-dialog-action"
              disabled={locked}
              onClick={() => {
                if (!pickingRecent && !pickingSnapshots && newTitle === null && saveTitle === null) setSection(section === "sets" ? "open" : section === "export" || section === "new" ? "more" : "main");
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
          <button type="button" className="lc-secondary lc-dialog-action" disabled={locked} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </DialogFrame>
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
