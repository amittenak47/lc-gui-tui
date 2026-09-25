import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ArtifactAssociation, ArtifactCatalog, ArtifactKind, ArtifactParent, ArtifactRef, PadArtifact } from "../util/padArtifacts";
import { ARTIFACTS_CHANGED, artifactRef, createArtifact, mutateArtifacts, readArtifactCatalog } from "../util/artifactRepository";
import { buildWhiteboardTemplate } from "../templates/whiteboard";
import { buildAnnotateTemplate } from "../templates/annotate";
import { convertToExcalidrawElements } from "../canvas/convertSkeletons";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { HoldButton } from "../components/HoldButton";
import { Tip } from "../components/Tip";
import { useShell } from "../shellContext";
import { isDarkTheme } from "../theme/appThemes";
import { useLibraryDeleteArm } from "../util/armedDelete";
import { isArtifactLocked, setArtifactLocked } from "../util/artifactLocks";
import { syncArtifactParent } from "../util/artifactSync";
import { shouldDismissBackdrop } from "../util/backdropDismiss";
import { footnoteChipLabel } from "../util/docFootnotes";
import { footnoteThemeVars } from "../util/footnoteTheme";
import { ArtifactKindIcon, artifactKindLabel } from "./ArtifactKindIcon";
import { LibraryPadlock } from "./LibraryPadlock";
import "./artifacts.css";
import { NumberWheel } from "../canvas/NumberWheel";
import { listAnnotateDocs, annotateDocLabel } from "../util/annotateStore";
import { captureLibraryReference, referenceSnapshot, type ArtifactReferenceCapture } from "../util/artifactReferenceSources";

export type ArtifactPickerScope = "catalog" | "message" | "footnote";

export interface ArtifactPickerFootnote {
  id: string;
  title: string;
  number?: number;
  color?: string;
  palette?: string[];
  selected: boolean;
}

export interface ArtifactPickerProps {
  pageChoices?: Array<{ id: string; title: string; pages?: number; kind: "code" | "markdown" }>;
  capturePage?: (id: string, page: number) => Promise<ArtifactReferenceCapture>;
  parent: ArtifactParent;
  associations: ArtifactAssociation[];
  /** Paperclip on a turn, C on the composer, or a footnote's catalog. */
  scope?: ArtifactPickerScope;
  onAttach: (ref: ArtifactRef, associations: ArtifactAssociation[]) => void | Promise<void>;
  onOpen: (ref: ArtifactRef) => void;
  onClose: () => void;
  footnoteChoices?: ArtifactPickerFootnote[];
  onToggleFootnote?: (id: string) => void;
}

const EXIT_MS = 180;

function AdornIcon({ children }: { children: ReactNode }) {
  return (
    <svg className="lc-artifact-picker-adorn-icon" viewBox="0 0 16 16" aria-hidden>
      {children}
    </svg>
  );
}

function FootnotesIcon() {
  return (
    <AdornIcon>
      <path
        d="M3.4 4.3h9.2M3.4 7.2h9.2M3.4 10.1h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path
        d="M11.2 9.2v4.2M10.2 10.3h2M10.4 13.4h1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </AdornIcon>
  );
}

const CREATE_KINDS: ArtifactKind[] = ["whiteboard", "markdown", "code"];
/** Wheel range when a library file's length is not known until capture. */
const UNKNOWN_SOURCE_PAGES = 240;

function sourceLabel(value: "saved" | "files" | "pages"): string {
  if (value === "saved") return "Saved";
  if (value === "files") return "Files";
  return "Pages & regions";
}

function associationKey(entry: ArtifactAssociation): string {
  return JSON.stringify(entry);
}

function coversAssociations(item: PadArtifact, associations: ArtifactAssociation[]): boolean {
  const have = new Set(item.associations.map(associationKey));
  return associations.every((entry) => have.has(associationKey(entry)));
}

function pickerCopy(scope: ArtifactPickerScope): string {
  if (scope === "message") {
    return "Pin a catalog item onto this turn, or create a new whiteboard, note, or code as a reference.";
  }
  if (scope === "footnote") {
    return "Pin catalog items onto these footnotes. The same item can sit on several without copying it.";
  }
  return "";
}

function kindLabel(kind: ArtifactKind): string {
  return artifactKindLabel(kind);
}

function statusLabel(item: PadArtifact, attached: boolean, scope: ArtifactPickerScope): string {
  if (item.deletedAt !== undefined) return "Trash";
  if (attached) {
    if (scope === "message") return "On this turn";
    if (scope === "footnote") return "On these footnotes";
    return "On this thread";
  }
  if (!item.associations.length) return "Unfiled";
  return "";
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function CreateIcon() {
  return (
    <svg className="lc-artifact-picker-submit-icon" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M8 5.1v5.8M5.1 8h5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
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
  );
}

function RestoreGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

export function ArtifactPicker({
  parent,
  associations,
  scope = "catalog",
  onAttach,
  onOpen,
  onClose,
  footnoteChoices = [],
  onToggleFootnote,
  pageChoices = [],
  capturePage,
}: ArtifactPickerProps) {
  const { themeId, client } = useShell();
  const [catalog, setCatalog] = useState<ArtifactCatalog>();
  const [source, setSource] = useState<"saved" | "files" | "pages">("saved");
  const [sourcePages, setSourcePages] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [createKind, setCreateKind] = useState<ArtifactKind | null>("markdown");
  const [filterKind, setFilterKind] = useState<ArtifactKind | null>(null);
  const [exiting, setExiting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [fnOpen, setFnOpen] = useState(false);
  const [fnPos, setFnPos] = useState<{ left: number; top: number } | null>(null);
  const [pendingTrash, setPendingTrash] = useState<PadArtifact | null>(null);
  const [lockTick, setLockTick] = useState(0);
  const { tapArmed, arm } = useLibraryDeleteArm();
  const running = useRef(false);
  const backdropDown = useRef(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  const requestCloseRef = useRef<(after?: () => void) => void>(() => {});
  const fnBtnRef = useRef<HTMLButtonElement>(null);
  const fnMenuRef = useRef<HTMLDivElement>(null);
  onCloseRef.current = onClose;

  const refresh = () => readArtifactCatalog(parent)
    .then(setCatalog)
    .catch((cause) => setError(String(cause)))
    .finally(() => setLoaded(true));
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    void refresh();
    const listener = () => { void refresh(); };
    window.addEventListener(ARTIFACTS_CHANGED, listener);
    return () => window.removeEventListener(ARTIFACTS_CHANGED, listener);
  }, [parent.kind, parent.id]);

  const requestClose = (after?: () => void) => {
    if (exiting) return;
    setFnOpen(false);
    afterClose.current = after;
    if (reducedMotion()) {
      after?.();
      onCloseRef.current();
      return;
    }
    setExiting(true);
  };
  requestCloseRef.current = requestClose;

  useEffect(() => {
    if (!exiting) return;
    const id = window.setTimeout(() => {
      afterClose.current?.();
      onCloseRef.current();
    }, EXIT_MS);
    return () => window.clearTimeout(id);
  }, [exiting]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pendingTrash) return;
      if (fnOpen) {
        setFnOpen(false);
        return;
      }
      requestCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fnOpen, pendingTrash]);

  useEffect(() => {
    if (!fnOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (fnBtnRef.current?.contains(target) || fnMenuRef.current?.contains(target)) return;
      setFnOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [fnOpen]);

  const openFootnotes = () => {
    if (fnOpen) {
      setFnOpen(false);
      return;
    }
    const rect = fnBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 216;
    const left = Math.min(rect.left, window.innerWidth - width - 12);
    setFnPos({ left: Math.max(12, left), top: rect.bottom + 6 });
    setFnOpen(true);
  };

  const filing = (): ArtifactAssociation[] => {
    const selected = footnoteChoices.filter((entry) => entry.selected);
    if (selected.length) return selected.map((entry) => ({ kind: "footnote", footnoteId: entry.id }));
    return associations;
  };

  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      await syncArtifactParent(client, parent);
    } catch (cause) {
      setError(String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const create = (nextKind: ArtifactKind | null = createKind) => {
    if (!nextKind) return;
    return run(async () => {
      const name = query.trim() || (nextKind === "whiteboard" ? "Whiteboard" : nextKind === "code" ? "Code.py" : "Note.md");
      const board = {
        v: 1 as const,
        elements: convertToExcalidrawElements(nextKind === "whiteboard" ? buildWhiteboardTemplate(1, isDarkTheme(themeId)) : buildAnnotateTemplate(1600, isDarkTheme(themeId))),
        appState: { scrollX: 0, scrollY: 0, zoom: 1 },
      };
      const ref = await createArtifact(parent, name, filing(), nextKind === "whiteboard"
        ? { kind: nextKind, value: { board, pageCount: 1, programs: [], ink: new Map() } }
        : { kind: nextKind, value: { owned: true, docType: nextKind, name, source: nextKind === "markdown" ? `# ${name.replace(/\.md$/i, "")}\n` : "", board, footnotes: [], agent: [], ink: new Map() } });
      await onAttach(ref, filing());
      requestClose(() => onOpen(ref));
    });
  };

  const visible = catalog?.artifacts.filter((item) => {
    if (filterKind && item.content.kind !== filterKind) return false;
    return item.title.toLowerCase().includes(query.trim().toLowerCase());
  }) ?? [];
  const attachLabel = scope === "catalog" ? "Pin to chat" : "Attach";
  const pickedFootnotes = footnoteChoices.filter((entry) => entry.selected).length;
  const filingNow = filing();
  const referenceRows = source === "files" ? listAnnotateDocs().map(doc => ({ id: doc.id, title: annotateDocLabel(doc),
    kind: doc.docType === "code" ? "code" as const : "markdown" as const,
    unit: doc.docType === "pdf" ? "Page" : doc.docType === "epub" ? "Chapter" : "Section", pages: undefined as number | undefined }))
    : pageChoices.map(choice => ({ ...choice, unit: "Page" }));
  const visibleReferences = referenceRows.filter(row => (!filterKind || row.kind === filterKind) && row.title.toLowerCase().includes(query.trim().toLowerCase()));
  const attachReference = (id: string) => run(async () => {
    const page = sourcePages[id] ?? 1;
    const captured = source === "files" ? await captureLibraryReference(id, page) : await capturePage?.(id, page);
    if (!captured) throw new Error("The selected page is no longer available.");
    const board = { v: 1 as const, elements: convertToExcalidrawElements(buildAnnotateTemplate(1600, isDarkTheme(themeId))),
      appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
    const ref = await createArtifact(parent, captured.title, filing(), { kind: captured.kind, value: referenceSnapshot(captured, board) });
    await onAttach(ref, filing());
    requestClose();
  });

  const applyLifecycle = (item: PadArtifact, type: "delete" | "restore") =>
    run(async () => {
      await mutateArtifacts(parent, catalog!.revision, {
        type,
        id: item.id,
        expectedRevision: item.revision,
      });
      arm();
    });

  const confirmTrash = async (item: PadArtifact) => {
    await applyLifecycle(item, "delete");
    setPendingTrash(null);
  };

  return createPortal(
    <>
      <div
        className={[
          "lc-settings-backdrop",
          "lc-artifact-picker-backdrop",
          exiting ? "lc-leave-dialog-exit" : "lc-server-gate-enter",
        ].join(" ")}
        role="presentation"
        onPointerDown={(event) => {
          backdropDown.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          const startedOnBackdrop = backdropDown.current;
          backdropDown.current = false;
          if (shouldDismissBackdrop(startedOnBackdrop, event.target, event.currentTarget)) requestClose();
        }}
      >
        <div
          className="lc-settings-modal lc-artifact-picker-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="lc-artifact-picker-title"
        >
          <div className="lc-settings-head">
            <h2 id="lc-artifact-picker-title">Attachments</h2>
            {pickerCopy(scope) ? <p className="lc-muted">{pickerCopy(scope)}</p> : null}
          </div>
          <div className="lc-settings-body">
            <form
              className="lc-artifact-picker-compose"
              onSubmit={(event) => {
                event.preventDefault();
                if (source === "saved") void create();
              }}
            >
              <div className="lc-artifact-picker-adorn-start">
                {footnoteChoices.length > 0 && (
                  <Tip
                    tip={pickedFootnotes ? `Footnotes · ${pickedFootnotes} selected` : "Footnotes"}
                    placement="top"
                  >
                    <button
                      ref={fnBtnRef}
                      type="button"
                      className={`lc-artifact-picker-adorn lc-artifact-picker-fn${pickedFootnotes || fnOpen ? " is-active" : ""}`}
                      aria-label="Footnotes"
                      aria-haspopup="menu"
                      aria-expanded={fnOpen}
                      onClick={openFootnotes}
                    >
                      <FootnotesIcon />
                      {pickedFootnotes ? (
                        <span className="lc-artifact-picker-adorn-count">{pickedFootnotes}</span>
                      ) : null}
                    </button>
                  </Tip>
                )}
                <div className="lc-artifact-picker-kinds" role="group" aria-label="Attachment kind">
                  {CREATE_KINDS.map((next) => {
                    const label = artifactKindLabel(next);
                    return (
                    <Tip key={next} tip={`${label} — tap to create, hold to filter`} placement="top">
                      <HoldButton
                        label={label}
                        ariaLabel={label}
                        className={`lc-artifact-picker-adorn lc-hold-icon${createKind === next ? " is-active" : ""}${filterKind === next ? " is-filter" : ""}`}
                        pressed={createKind === next}
                        holdThrough
                        onTap={() => setCreateKind((current) => (current === next ? null : next))}
                        onConfirm={() => setFilterKind((current) => (current === next ? null : next))}
                      >
                        <ArtifactKindIcon kind={next} className="lc-artifact-picker-adorn-icon" />
                      </HoldButton>
                    </Tip>
                    );
                  })}
                </div>
              </div>
              <input
                aria-label="Search catalog or name a new attachment"
                placeholder="Search or create…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button
                type="submit"
                className="lc-artifact-picker-submit"
                disabled={busy || !createKind || source !== "saved"}
                aria-label="Create attachment"
              >
                <CreateIcon />
              </button>
            </form>
            <div className="lc-artifact-picker-sources" role="group" aria-label="Attachment source">
              {(["saved", "files", ...(pageChoices.length ? ["pages"] as const : [])] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`lc-artifact-picker-source${source === value ? " is-active" : ""}`}
                  aria-pressed={source === value}
                  disabled={busy}
                  onClick={() => setSource(value)}
                >
                  {sourceLabel(value)}
                </button>
              ))}
            </div>
            <div className="lc-artifact-picker-catalog">
              {error && <p role="alert">{error}</p>}
              {source !== "saved" && <p className="lc-artifact-picker-empty">Attach a read-only excerpt. The source stays unchanged.</p>}
              {source === "saved" && loaded && !catalog?.artifacts.length && <p className="lc-artifact-picker-empty">No saved attachments yet.</p>}
              {source === "saved" && loaded && (catalog?.artifacts.length ?? 0) > 0 && !visible.length && (
                <p className="lc-artifact-picker-empty">No matching attachments.</p>
              )}
              <div className="lc-artifact-picker-list">
                {source !== "saved" && visibleReferences.map((row) => {
                  const pageMax = row.pages && row.pages >= 1 ? row.pages : UNKNOWN_SOURCE_PAGES;
                  const page = Math.min(pageMax, Math.max(1, sourcePages[row.id] ?? 1));
                  const pageLabel = `${row.title} ${row.unit.toLowerCase()}`;
                  return (
                    <div className="lc-artifact-picker-row lc-artifact-picker-reference-row" key={row.id}>
                      <span className="lc-artifact-picker-kind">
                        <ArtifactKindIcon kind={row.kind} className="lc-artifact-picker-adorn-icon" />
                      </span>
                      <span className="lc-artifact-picker-row-title">{row.title}</span>
                      <span className="lc-artifact-picker-status">Read-only</span>
                      <div className="lc-artifact-picker-reference-end">
                        <span className="lc-artifact-picker-unit">{row.unit}</span>
                        <NumberWheel
                          value={page}
                          min={1}
                          max={pageMax}
                          step={1}
                          allowFineScrub={false}
                          enabled={!busy}
                          label={pageLabel}
                          format={(size) => String(Math.round(size))}
                          onChange={(next) => {
                            const chosen = Math.min(pageMax, Math.max(1, Math.round(next)));
                            setSourcePages((current) => ({ ...current, [row.id]: chosen }));
                          }}
                        />
                        <button
                          type="button"
                          className="lc-artifact-picker-attach"
                          disabled={busy}
                          aria-label={attachLabel}
                          onClick={() => void attachReference(row.id)}
                        >
                          <CreateIcon />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {source !== "saved" && !visibleReferences.length && <p className="lc-artifact-picker-empty">No matching sources.</p>}
                {source === "saved" && visible.map((item) => {
                  const ref = artifactRef(parent, item);
                  const attached = coversAssociations(item, filingNow);
                  const status = statusLabel(item, attached, scope);
                  const trashed = item.deletedAt !== undefined;
                  const locked = lockTick >= 0 && isArtifactLocked(parent, item.id);
                  return (
                    <div className={`lc-artifact-picker-row${trashed ? " is-trashed" : ""}`} key={item.id}>
                      <div className="lc-artifact-picker-row-main">
                        <span className="lc-artifact-picker-kind" aria-label={kindLabel(item.content.kind)} title={kindLabel(item.content.kind)}>
                          <ArtifactKindIcon kind={item.content.kind} className="lc-artifact-picker-adorn-icon" />
                        </span>
                        <span className="lc-artifact-picker-row-title">{item.title}</span>
                        {status ? <span className="lc-artifact-picker-status">{status}</span> : null}
                      </div>
                      <div className="lc-artifact-picker-row-actions">
                        {!trashed && (
                          <>
                            <button type="button" className="lc-secondary" disabled={busy} onClick={() => requestClose(() => onOpen(ref))}>
                              Open
                            </button>
                            <button
                              type="button"
                              disabled={busy || attached}
                              onClick={() => void run(async () => {
                                const next = [...item.associations];
                                for (const association of filingNow) {
                                  if (!next.some((entry) => associationKey(entry) === associationKey(association))) next.push(association);
                                }
                                await mutateArtifacts(parent, catalog!.revision, {
                                  type: "update",
                                  id: item.id,
                                  expectedRevision: item.revision,
                                  patch: { associations: next },
                                });
                                await onAttach(ref, filing());
                                requestClose();
                              })}
                            >
                              {attached ? "Attached" : attachLabel}
                            </button>
                            {attached && (
                              <button
                                type="button"
                                className="lc-secondary"
                                disabled={busy}
                                onClick={() => void run(async () => {
                                  const remove = new Set(filingNow.map(associationKey));
                                  await mutateArtifacts(parent, catalog!.revision, {
                                    type: "update",
                                    id: item.id,
                                    expectedRevision: item.revision,
                                    patch: { associations: item.associations.filter((entry) => !remove.has(associationKey(entry))) },
                                  });
                                })}
                              >
                                Unfile
                              </button>
                            )}
                            <LibraryPadlock
                              name={item.title}
                              locked={locked}
                              disabled={busy}
                              className="lc-artifact-picker-lock"
                              onToggle={() => {
                                setArtifactLocked(parent, item.id, !locked);
                                setLockTick((n) => n + 1);
                              }}
                            />
                            {!locked && (
                              <HoldButton
                                label={`Delete ${item.title}`}
                                className="lc-artifact-picker-trash"
                                disabled={busy}
                                ariaLabel={
                                  tapArmed
                                    ? `Delete ${item.title} — tap to delete`
                                    : `Delete ${item.title} — hold to delete`
                                }
                                onTap={tapArmed ? () => void confirmTrash(item) : undefined}
                                onConfirm={() => {
                                  if (tapArmed) void confirmTrash(item);
                                  else setPendingTrash(item);
                                }}
                                resetKey={error}
                              >
                                <TrashGlyph />
                              </HoldButton>
                            )}
                          </>
                        )}
                        {trashed && (
                          <HoldButton
                            label={`Restore ${item.title}`}
                            className="lc-artifact-picker-restore"
                            disabled={busy}
                            ariaLabel={
                              tapArmed
                                ? `Restore ${item.title} — tap to restore`
                                : `Restore ${item.title} — hold to restore`
                            }
                            onTap={tapArmed ? () => void applyLifecycle(item, "restore") : undefined}
                            onConfirm={() => void applyLifecycle(item, "restore")}
                            resetKey={error}
                          >
                            <RestoreGlyph />
                          </HoldButton>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="lc-settings-foot">
            <button type="button" className="lc-secondary" disabled={busy && !exiting} onClick={() => requestClose()}>
              Close
            </button>
          </div>
        </div>
        {pendingTrash && (
          <ConfirmDialog
            title="Remove this attachment?"
            message="It leaves the live catalog."
            detail="Existing cards keep their links. Restore it from this list."
            confirmLabel="Delete"
            pending={busy}
            error={error}
            onConfirm={() => void confirmTrash(pendingTrash)}
            onCancel={() => setPendingTrash(null)}
          />
        )}
      </div>
      {fnOpen && fnPos && (
        <div
          ref={fnMenuRef}
          className="lc-agent-scope-menu lc-agent-footnote-menu lc-artifact-picker-fn-menu is-side-right"
          role="menu"
          aria-label="Page footnotes"
          style={{ left: fnPos.left, top: fnPos.top }}
        >
          {footnoteChoices.map((mark) => {
            const chipLabel = footnoteChipLabel(mark.number, mark.title);
            return (
              <button
                key={mark.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={mark.selected}
                aria-label={chipLabel}
                className={`lc-footnote-chip${mark.selected ? " is-picked" : ""}`}
                style={footnoteThemeVars(mark.color, mark.palette ?? [])}
                onClick={() => onToggleFootnote?.(mark.id)}
              >
                <span className="lc-fn-badge" aria-hidden>
                  {mark.number ?? ""}
                </span>
                {mark.title?.trim() ? (
                  <span className="lc-footnote-chip-label">{mark.title.trim()}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </>,
    document.body,
  );
}
