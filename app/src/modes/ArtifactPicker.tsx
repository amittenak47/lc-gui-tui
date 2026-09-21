import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ArtifactAssociation, ArtifactCatalog, ArtifactKind, ArtifactParent, ArtifactRef, PadArtifact } from "../util/padArtifacts";
import { ARTIFACTS_CHANGED, artifactRef, createArtifact, mutateArtifacts, readArtifactCatalog } from "../util/artifactRepository";
import { buildWhiteboardTemplate } from "../templates/whiteboard";
import { buildAnnotateTemplate } from "../templates/annotate";
import { convertToExcalidrawElements } from "../canvas/convertSkeletons";
import { HoldButton } from "../components/HoldButton";
import { Tip } from "../components/Tip";
import { useShell } from "../shellContext";
import { isDarkTheme } from "../theme/appThemes";
import { syncArtifactParent } from "../util/artifactSync";
import { shouldDismissBackdrop } from "../util/backdropDismiss";
import { footnoteChipLabel } from "../util/docFootnotes";
import { footnoteThemeVars } from "../util/footnoteTheme";
import "./artifacts.css";

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
  parent: ArtifactParent;
  associations: ArtifactAssociation[];
  /** Paperclip on a turn, C on the composer, or a footnote's catalog. */
  scope?: ArtifactPickerScope;
  onAttach: (ref: ArtifactRef) => void;
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

function BoardIcon() {
  return (
    <AdornIcon>
      <rect
        x="2.6"
        y="3.5"
        width="10.8"
        height="9"
        rx="1.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path
        d="M5.1 9.3c.7-1.5 1.7-2.3 2.6-1.2.9 1.1 1.6.2 2.5-1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </AdornIcon>
  );
}

function NoteIcon() {
  return (
    <AdornIcon>
      <path
        d="M4.2 2.8h5.3L11.8 5.2v8H4.2V2.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 2.9v2.4h2.2M6 8.3h4M6 10.5h2.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </AdornIcon>
  );
}

function CodeIcon() {
  return (
    <AdornIcon>
      <path
        d="M6.2 4.5 2.9 8l3.3 3.5M9.8 4.5 13.1 8l-3.3 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </AdornIcon>
  );
}

const CREATE_KINDS: Array<{ kind: ArtifactKind; label: string; Icon: () => ReactNode }> = [
  { kind: "whiteboard", label: "Board", Icon: BoardIcon },
  { kind: "markdown", label: "Note", Icon: NoteIcon },
  { kind: "code", label: "Code", Icon: CodeIcon },
];

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
  return "Owned by this pad. Attach the same item to several footnotes or threads, or pin one onto the chat as a reference.";
}

function kindLabel(kind: ArtifactKind): string {
  return CREATE_KINDS.find((entry) => entry.kind === kind)?.label ?? kind;
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

export function ArtifactPicker({
  parent,
  associations,
  scope = "catalog",
  onAttach,
  onOpen,
  onClose,
  footnoteChoices = [],
  onToggleFootnote,
}: ArtifactPickerProps) {
  const { themeId, client } = useShell();
  const [catalog, setCatalog] = useState<ArtifactCatalog>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [createKind, setCreateKind] = useState<ArtifactKind | null>("markdown");
  const [filterKind, setFilterKind] = useState<ArtifactKind | null>(null);
  const [exiting, setExiting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [fnOpen, setFnOpen] = useState(false);
  const [fnPos, setFnPos] = useState<{ left: number; top: number } | null>(null);
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
      if (fnOpen) {
        setFnOpen(false);
        return;
      }
      requestCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fnOpen]);

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
      onAttach(ref);
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
            <p className="lc-muted">{pickerCopy(scope)}</p>
          </div>
          <div className="lc-settings-body">
            <form
              className="lc-artifact-picker-compose"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
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
                  {CREATE_KINDS.map(({ kind: next, label, Icon }) => (
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
                        <Icon />
                      </HoldButton>
                    </Tip>
                  ))}
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
                disabled={busy || !createKind}
                aria-label="Create attachment"
              >
                <CreateIcon />
              </button>
            </form>
            <div className="lc-artifact-picker-catalog">
              {error && <p role="alert">{error}</p>}
              {loaded && !catalog?.artifacts.length && <p className="lc-artifact-picker-empty">No saved attachments yet.</p>}
              {loaded && (catalog?.artifacts.length ?? 0) > 0 && !visible.length && (
                <p className="lc-artifact-picker-empty">No matching attachments.</p>
              )}
              <div className="lc-artifact-picker-list">
                {visible.map((item) => {
                  const ref = artifactRef(parent, item);
                  const attached = coversAssociations(item, filingNow);
                  const status = statusLabel(item, attached, scope);
                  return (
                    <div className="lc-artifact-picker-row" key={item.id}>
                      <div className="lc-artifact-picker-row-main">
                        <span className="lc-artifact-picker-kind">{kindLabel(item.content.kind)}</span>
                        <span className="lc-artifact-picker-row-title">{item.title}</span>
                        {status ? <span className="lc-artifact-picker-status">{status}</span> : null}
                      </div>
                      <div className="lc-artifact-picker-row-actions">
                        {item.deletedAt === undefined && (
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
                                onAttach(ref);
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
                          </>
                        )}
                        <button
                          type="button"
                          className="lc-secondary"
                          disabled={busy}
                          onClick={() => void run(async () => {
                            if (item.deletedAt === undefined && !window.confirm(`Move “${item.title}” to attachment Trash? Existing cards will retain their links.`)) return;
                            await mutateArtifacts(parent, catalog!.revision, {
                              type: item.deletedAt === undefined ? "delete" : "restore",
                              id: item.id,
                              expectedRevision: item.revision,
                            });
                          })}
                        >
                          {item.deletedAt === undefined ? "Trash" : "Restore"}
                        </button>
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
