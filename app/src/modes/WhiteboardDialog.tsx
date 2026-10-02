import {LibraryTrashRow} from "./LibraryTrashRow";
import {useLibraryMorph} from "./useLibraryMorph";
/**
 * Scratchpad leave / entry menus — save, discard, load, or start blank.
 */

import { useEffect, useRef, useState } from "react";

import { LIBRARY_HOLD_MS } from "../util/gesture";
import { HoldButton } from "../components/HoldButton";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DialogFrame } from "../components/DialogFrame";
import { HubLibraryRefresh, type HubLibraryRefreshAction } from "../components/HubLibraryRefresh";
import { LibrarySearch } from "./LibrarySearch";
import { LibraryTimes } from "./LibraryTimes";
import { useLibraryDeleteArm } from "../util/armedDelete";
import { DOUBLE_TAP_MS } from "../util/gesture";
import { shouldDismissBackdrop } from "../util/backdropDismiss";
import {
  deleteWhiteboardNotebook,
  WHITEBOARD_LIBRARY_EVENT,
  listWhiteboardNotebooks,
  listWhiteboardTrash,
  setWhiteboardNotebookLocked,
  type WhiteboardNotebookMeta,
} from "../util/whiteboardStore";
import { LibraryPadlock } from "./LibraryPadlock";
import { PadNameField } from "./PadNameField";
import { TOMBSTONE_COPY } from "../util/padSync";
import {
  listPadSnapshots,
  PAD_SNAPSHOT_TIERS,
  type PadSnapshotMeta,
} from "../util/padSnapshotStore";
import "./whiteboardDialog.css";

export type ScratchLeaveChoice = "save" | "discard" | "load";
export type ScratchEntryChoice = "new" | "load" | "save" | "snapshot" | "import" | "export" | "export-png";

interface NotebookContextProps {
  notebookId?: string | null;
}

interface LeaveProps extends NotebookContextProps {
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
  /** First explicit Save still needs a title. */
  needsName?: boolean;
  defaultName?: string;
  onChoose: (choice: ScratchLeaveChoice, notebookId?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string) => void | Promise<void>;
}

interface EntryProps extends NotebookContextProps {
  onRefreshHub?: HubLibraryRefreshAction;
  mode: "entry";
  pending?: boolean;
  exiting?: boolean;
  error?: string | null;
  /** When already inside a notebook, offer Save alongside New / Load. */
  allowSave?: boolean;
  dirty?: boolean;
  /** Notebook id — used to list rolling snapshots. */
  snapshotKey?: string | null;
  /** First explicit Save still needs a title. */
  needsName?: boolean;
  /** Prefill / placeholder for that first Save. */
  defaultName?: string;
  onChoose: (choice: ScratchEntryChoice, notebookId?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string) => void | Promise<void>;
  onRestoreTrash?: (id: string) => void | Promise<void>;
  onRename?: (id: string, title: string) => void | Promise<void>;
}

export type WhiteboardDialogProps = LeaveProps | EntryProps;

function NotebookIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8M8 16l1-5L18 2a2 2 0 0 1 3 3l-9 9-4 2Z" />
  </svg>;
}

function MenuRowLabel({ label, description }: { label: string; description?: string }) {
  return <span className="lc-whiteboard-menu-label">
    {["New", "Open", "Pull", "More"].includes(label) && <svg className="lc-whiteboard-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {label === "New" ? <path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 14h8M12 10v8" /> : label === "Open" ? <path d="M3 7V4h6l3 3h7v4M3 9h18l-3 11H3L1 9h2Z" /> : label === "More" ? <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" /> : <path d="M12 3v13m-5-5 5 5 5-5M3 16v5h18v-5" />}
    </svg>}
    <span className="lc-whiteboard-row-copy"><strong>{label}</strong>{description && <span className="lc-muted">{description}</span>}</span>
  </span>;
}

function WhiteboardMenuRow({ label, description, disabled, onConfirm }: {
  label: string; description?: string; disabled?: boolean; onConfirm: () => void;
}) {
  return <HoldButton holdMs={LIBRARY_HOLD_MS} label={label} className="lc-hold-choice" disabled={disabled} onConfirm={onConfirm}>
    <MenuRowLabel label={label} description={description} />
  </HoldButton>;
}

export function WhiteboardDialog(props: WhiteboardDialogProps) {
  const [notebooks, setNotebooks] = useState<WhiteboardNotebookMeta[]>(() =>
    listWhiteboardNotebooks(),
  );
  const [trash, setTrash] = useState<WhiteboardNotebookMeta[]>(() => listWhiteboardTrash());
  const [section,setSection] = useState<"main"|"open"|"more"|"export">("main");
  const [pickingLoad, setPickingLoad] = useState(false);
  const [pickingSnapshots, setPickingSnapshots] = useState(false);
  const [snapshots, setSnapshots] = useState<PadSnapshotMeta[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [saveTitle, setSaveTitle] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [showTrash,setShowTrash] = useState(false);
  const [libraryQuery,setLibraryQuery] = useState("");
  const lastTapRef = useRef({ id: "", at: 0 });
  const backdropDown = useRef(false);
  const { tapArmed, arm } = useLibraryDeleteArm();

  useEffect(() => {
    const refresh = () => {
      setNotebooks(listWhiteboardNotebooks());
      setTrash(listWhiteboardTrash());
    };
    window.addEventListener(WHITEBOARD_LIBRARY_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(WHITEBOARD_LIBRARY_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    setNotebooks(listWhiteboardNotebooks());
    setTrash(listWhiteboardTrash());
    setPickingLoad(false);
    setPickingSnapshots(false);
    setSaveTitle(null);
    setRenamingId(null);
    setLibraryQuery("");
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
  const locked = pending || exiting;
  const needsName = Boolean(props.needsName);
  const defaultName = props.defaultName?.trim() || "";
  const onRename = props.mode === "entry" ? props.onRename : undefined;
  const notebook = notebooks.find(row => row.id === (props.notebookId ?? snapshotKey));
  const contextTitle = isLeave || allowSave ? notebook?.title || defaultName : "";
  const syncStatus = notebook ? (!props.dirty && notebook.hubAckUpdatedAt === notebook.updatedAt ? "synced" : "not synced") : "";

  const matchesQuery = (entry: WhiteboardNotebookMeta) => entry.title.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase());

  const refreshList = () => {
    setNotebooks(listWhiteboardNotebooks());
    setTrash(listWhiteboardTrash());
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
      arm();
    } catch {
      /* ignore */
    }
    setPendingId(null);
    refreshList();
  };

  const morphRef = useLibraryMorph(`${section}:${pickingLoad}:${pickingSnapshots}:${saveTitle!==null}`);
  const archived = props.mode === "entry" ? trash : [];

  return (
    <div
      className={["lc-settings-backdrop", exiting && "lc-leave-dialog-exit"]
        .filter(Boolean)
        .join(" ")}
      role="presentation"
      onPointerDownCapture={(event) => {
        // The menu can mount while its toolbar icon is still held. Releasing
        // that gesture onto the new backdrop must not count as dismissal.
        backdropDown.current = event.target === event.currentTarget;
      }}
      onPointerCancel={() => { backdropDown.current = false; }}
      onClick={(event) => {
        const startedOnBackdrop = backdropDown.current;
        backdropDown.current = false;
        if (!locked && shouldDismissBackdrop(startedOnBackdrop, event.target, event.currentTarget)) props.onCancel();
      }}
    >
      <DialogFrame ref={morphRef}
        className="lc-attempt-modal lc-library-holds lc-library-menu lc-library-whiteboard lc-whiteboard-dialog"
        ariaLabel={isLeave ? "Leave whiteboard?" : "Open whiteboard"}
        titleId="lc-whiteboard-dialog-title"
        title={isLeave ? "Leave whiteboard?" : pickingLoad ? "Load" : pickingSnapshots ? "Restore" : section === "open" ? "Open" : section === "more" ? "More" : section === "export" ? "Export" : "Whiteboard"}
        subtitle="Notebooks"
        icon={<NotebookIcon />}
        mode="whiteboard"
        shape="blocky"
        onClose={props.onCancel}
        closeDisabled={locked}
      >
        {contextTitle && <div className="lc-dialog-context">
          <div className="lc-whiteboard-context">
            <NotebookIcon />
            <span className="lc-whiteboard-context-title" title={contextTitle}>{contextTitle}</span>
            {syncStatus && <span className="lc-whiteboard-context-sync">{syncStatus}</span>}
          </div>
        </div>}
        <div className="lc-settings-body lc-dialog-body lc-scroll-pane">
          {pickingLoad && <LibrarySearch value={libraryQuery} onChange={setLibraryQuery} label="Search saved whiteboards" disabled={locked} showTrash={showTrash} onTrashChange={setShowTrash}/>}
          {pickingLoad && !(showTrash ? archived : notebooks).some(matchesQuery) && <p className="lc-muted">No matching saved items.</p>}
          {error && <div className="lc-warning">{error}</div>}

          {saveTitle !== null ? (
            <div className="lc-settings-choice">
              <p className="lc-muted lc-whiteboard-name-hint">Name this notebook. Hold Save to keep the suggested name.</p>
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
                <span className="lc-muted">Keep this notebook in the library.</span>
              </HoldButton>
            </div>
          ) : pickingSnapshots ? (
            <div className="lc-settings-choice">
              {PAD_SNAPSHOT_TIERS.map((tier) => {
                const row = snapshots.find((snap) => snap.tier === tier.id);
                return (
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
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
              {(showTrash ? [] : notebooks).filter(matchesQuery).map((entry) => (
                <div key={entry.id} className="lc-scratch-load-entry">
                  {renamingId === entry.id ? (
                    <PadNameField
                      value={renameDraft}
                      disabled={locked}
                      autoFocus
                      onChange={setRenameDraft}
                      onSubmit={() => void commitRename(entry.id)}
                      onBlur={() => void commitRename(entry.id)}
                    />
                  ) : (
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
                    label={`Load ${entry.title}`}
                    className="lc-scratch-load-hold"
                    disabled={locked}
                    onTap={onRename ? () => tapLoadRow(entry.id, entry.title) : undefined}
                    onConfirm={() => props.onChoose("load", entry.id)}
                    resetKey={error}
                  >
                    <strong>{entry.title}</strong>
                    <span className="lc-muted">
                      {entry.pageCount} page{entry.pageCount === 1 ? "" : "s"}
                    </span>
                    <LibraryTimes {...entry}/>
                  </HoldButton>
                  )}
                  {renamingId !== entry.id && (
                  <>
                  <LibraryPadlock
                    name={entry.title}
                    locked={Boolean(entry.locked)}
                    disabled={locked}
                    onToggle={() => {
                      setWhiteboardNotebookLocked(entry.id, !entry.locked);
                      refreshList();
                    }}
                  />
                  {!entry.locked && (
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
                    label={`Delete ${entry.title}`}
                    className="lc-scratch-load-trash"
                    disabled={locked}
                    ariaLabel={
                      tapArmed
                        ? `Delete ${entry.title} — tap to delete`
                        : `Delete ${entry.title} — hold to delete`
                    }
                    onTap={tapArmed ? () => void confirmRemove(entry.id) : undefined}
                    onConfirm={() => {
                      if (tapArmed) void confirmRemove(entry.id);
                      else removeNotebook(entry.id);
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
              ))}
              {showTrash && archived.length > 0 && (
                <>
                  {archived.filter(matchesQuery).map((entry) => (
                    <LibraryTrashRow key={`arch-${entry.id}`} name={entry.title} updatedAt={entry.updatedAt} disabled={locked}
                      onRestore={async()=>{if(props.mode!=="entry")return;await props.onRestoreTrash?.(entry.id);refreshList();}}
                      onDelete={async()=>{await deleteWhiteboardNotebook(entry.id,true);refreshList();}}/>
                  ))}
                </>
              )}
            </div>
          ) : (
            <div className="lc-settings-choice">
              {isLeave ? (
                <div className="lc-document-menu">
                  <WhiteboardMenuRow label="Save" disabled={locked} onConfirm={beginSave} />
                  <WhiteboardMenuRow label="Discard" disabled={locked} onConfirm={() => props.onChoose("discard")} />
                </div>
              ) : (
                <>
                  {section === "main" && <>
                    <WhiteboardMenuRow label="New" description="Start a blank notebook" disabled={locked} onConfirm={() => props.onChoose("new")} />
                    <WhiteboardMenuRow label="Open" description="Pick a notebook from the library" disabled={locked} onConfirm={() => setSection("open")} />
                    {props.onRefreshHub && <HubLibraryRefresh onRefresh={props.onRefreshHub} disabled={locked}>
                      <MenuRowLabel label="Pull" description="Fetch notebooks from your other devices" />
                    </HubLibraryRefresh>}
                    <WhiteboardMenuRow label="More" disabled={locked} onConfirm={() => setSection("more")} />
                  </>}
                  {section === "open" && <>
                    <WhiteboardMenuRow label="Load" disabled={locked || (!notebooks.length && !archived.length)} onConfirm={() => setPickingLoad(true)} />
                    <WhiteboardMenuRow label="Recents" disabled={locked || (!notebooks.length && !archived.length)} onConfirm={() => setPickingLoad(true)} />
                  </>}
                  {section === "more" && <>
                    {allowSave && <>
                      <WhiteboardMenuRow label="Save" disabled={locked} onConfirm={beginSave} />
                      <WhiteboardMenuRow label="Export" disabled={locked} onConfirm={() => setSection("export")} />
                      <WhiteboardMenuRow label="Restore" disabled={locked || !snapshotKey} onConfirm={openSnapshots} />
                    </>}
                    <WhiteboardMenuRow label="Annotations" disabled={locked} onConfirm={() => props.onChoose("import")} />
                  </>}
                  {section === "export" && <>
                    <WhiteboardMenuRow label="PNG" disabled={locked} onConfirm={() => props.onChoose("export-png")} />
                    <WhiteboardMenuRow label="Annotations" disabled={locked} onConfirm={() => props.onChoose("export")} />
                  </>}
                </>
              )}
            </div>
          )}
        </div>

        <div className="lc-settings-foot lc-dialog-foot">
          {(section !== "main" || pickingLoad || pickingSnapshots || saveTitle !== null) && (
            <button
              type="button"
              className="lc-secondary lc-dialog-action"
              disabled={locked}
              onClick={() => {
                if (!pickingLoad && !pickingSnapshots && saveTitle === null) setSection(section === "export" ? "more" : "main");
                setPickingLoad(false);
                setPickingSnapshots(false);
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
          title="Remove this notebook?"
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
