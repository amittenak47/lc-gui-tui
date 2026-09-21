import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useShell, NO_CHROME } from "../shellContext";
import { loadBoardComponent, type BoardComponent } from "../canvas/boardChunk";
import type { BoardHandle } from "../canvas/BoardHandle";
import { buildWhiteboardTemplate, buildScratchPageSkeletons, WHITEBOARD_PAGE_LIMIT } from "../templates/whiteboard";
import { buildAnnotateTemplate, ANNOTATE_REGION } from "../templates/annotate";
import { isDarkTheme } from "../theme/appThemes";
import { AnnotateDocument } from "./AnnotateDocument";
import { AnnotateMarkdownEditor } from "./AnnotateMarkdownEditor";
import { readArtifact, saveArtifact, createArtifact, type ArtifactSnapshot } from "../util/artifactRepository";
import { getArtifactDraft, putArtifactDraft, deleteArtifactDraft } from "../util/artifactDrafts";
import { artifactRefKey, type PadArtifact } from "../util/padArtifacts";
import { artifactTab } from "../util/artifactTabs";
import { syncArtifactParent } from "../util/artifactSync";
import { applyViz } from "../viz/apply";
import { Timeline } from "../viz/Timeline";
import type { TabRecord } from "../util/tabs";
import "./artifacts.css";

const MonacoBlock = lazy(() => import("./MonacoBlock"));
export interface ArtifactWorkspaceProps {
  tab: TabRecord;
  active: boolean;
  showing: boolean;
  splitRole?: "a" | "b" | null;
  onClose?: () => void;
}

/** Same canvas and text editors as regular pads; only the ownership/save boundary differs. */
export function ArtifactWorkspace({ tab, active, showing, splitRole, onClose }: ArtifactWorkspaceProps) {
  const ref = tab.artifact!;
  const identity = artifactRefKey(ref);
  const { themeId, readingSize, setChrome, patchTab, setWorkspaceApi, openWorkspace, client } = useShell();
  const [Board, setBoard] = useState<BoardComponent | null>(null);
  const [item, setItem] = useState<PadArtifact | null>(null);
  const [snapshot, setSnapshot] = useState<ArtifactSnapshot | null>(null);
  const [title, setTitle] = useState(tab.title);
  const [editing, setEditing] = useState(false);
  const [height, setHeight] = useState(1600);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [page, setPage] = useState(0);
  const board = useRef<BoardHandle | null>(null);
  const hydrated = useRef(false);
  const changing = useRef(false);
  const generation = useRef(0);
  const live = useRef({ item, snapshot, title, dirty });
  live.current = { item, snapshot, title, dirty };
  const restore = useCallback(async (next: ArtifactSnapshot) => {
    const canvas = board.current;
    if (!canvas) return;
    hydrated.current = false;
    const blob = next.value.board;
    canvas.restoreBoard(blob.elements, blob.appState, {
      skeletons: next.kind === "whiteboard" ? buildWhiteboardTemplate(next.value.pageCount, isDarkTheme(themeId)) : buildAnnotateTemplate(1600, isDarkTheme(themeId)),
      ink: [], files: blob.files, inkPalettes: blob.inkPalettes,
    });
    await canvas.waitForTemplate();
    // The canvas's passive ink attachment may lag the template promise.
    // primeInkSnap waits for that attachment; ingest must not hit a null ref.
    await canvas.primeInkSnap();
    canvas.ingestInkPages(next.value.ink);
    if (next.kind === "whiteboard") for (const program of next.value.programs) applyViz({
      getSceneElements: () => canvas.getElements(), updateScene: ({ elements }) => canvas.setElements(elements),
      getViewportBounds: () => canvas.getViewportBounds(),
    }, skeletons => canvas.convert(skeletons), program, 0);
    await canvas.primeInkSnap();
    hydrated.current = true;
  }, [themeId]);
  const reload = useCallback(async (drafts = true) => {
    const token = ++generation.current;
    setError(null);
    try {
      const [savedResult, draft, component] = await Promise.all([readArtifact(ref).then(value => ({ value, error: null as unknown })).catch(error => ({ value: null, error })), drafts ? getArtifactDraft(ref) : null, loadBoardComponent()]);
      if (!savedResult.value && !draft) throw savedResult.error;
      const saved = savedResult.value;
      if (generation.current !== token) return;
      setItem(draft?.item ?? saved!.item);
      setTitle(draft?.title ?? saved!.item.title);
      setSnapshot(draft?.snapshot ?? saved!.snapshot);
      setPage(0);
      setLoadVersion(version => version + 1);
      setDirty(Boolean(draft));
      setStatus(draft ? "Recovered local draft. Save publishes it to the parent." : "Saved with parent");
      if (savedResult.error) setError(`Saved version unavailable. Recovered your local draft: ${String(savedResult.error)}`);
      setBoard(() => component);
    } catch (cause) { if (generation.current === token) setError(String(cause)); }
  }, [identity]);
  useEffect(() => { void reload(); return () => { generation.current++; }; }, [reload]);
  useEffect(() => { if (Board && snapshot) void restore(snapshot).catch(cause => setError(String(cause))); }, [Board, loadVersion]);
  const changed = () => {
    if (!hydrated.current || changing.current) return;
    setDirty(true);
  };
  const capture = (): ArtifactSnapshot => {
    const current = live.current.snapshot;
    const canvas = board.current;
    if (!current || !canvas || !hydrated.current) throw new Error("Wait for the attachment to finish opening.");
    if (canvas.isInking()) throw new Error("Lift the pen before saving.");
    const { ink: _ink, inkC: _inkC, ...blob } = canvas.saveBoard({ assembleInk: false });
    const ink = new Map(current.value.ink);
    for (const [page, encoded] of canvas.takeDirtyInkPages()) ink.set(page, encoded);
    const wanted = new Set(blob.inkPages?.pageIds ?? []);
    for (const page of ink.keys()) if (!wanted.has(page)) ink.delete(page);
    // Keep all scene elements: regular Save deliberately drops temporary coach
    // shapes, but an explicitly saved drawing owns those shapes/programs.
    blob.elements = canvas.getElements();
    return { ...current, value: { ...current.value, board: blob, ink,
      ...(current.kind !== "whiteboard" ? { name: live.current.title } : {}) } } as ArtifactSnapshot;
  };
  const persistDraft = async () => {
    if (changing.current) { await getArtifactDraft(ref); return; }
    if (!live.current.dirty || !live.current.item) return;
    await putArtifactDraft(ref, { v: 1, item: live.current.item, title: live.current.title, snapshot: capture() });
  };
  const save = async (copy = false) => {
    if (changing.current) throw new Error("Wait for the current attachment save to finish.");
    if (!live.current.item) return;
    changing.current = true; setPending(true); setError(null);
    try {
      const next = capture();
      await putArtifactDraft(ref, { v: 1, item: live.current.item, title: live.current.title, snapshot: next });
      if (copy) {
        const created = await createArtifact(ref.parent, `${live.current.title} (copy)`, live.current.item.associations, next);
        // The original draft stays recoverable until explicitly discarded.
        openWorkspace(artifactTab(created, `${live.current.title} (copy)`));
        onClose?.();
      } else {
        const written = await saveArtifact(ref, live.current.item.revision, live.current.title, next);
        await deleteArtifactDraft(ref);
        // Do not restore the board after a save: retain camera/undo stack.
        live.current = { item: written, title: written.title, snapshot: next, dirty: false };
        setSnapshot(next); setItem(written); setDirty(false);
        setStatus("Saved locally; syncing parent…");
      }
      const synced = await syncArtifactParent(client, ref.parent);
      setStatus(synced ? "Saved and synced with parent" : "Saved locally; parent sync pending");
    } catch (cause) { setError(`${String(cause)} Your draft is kept. Save a copy to keep both versions.`); throw cause; }
    finally { changing.current = false; setPending(false); }
  };
  const actions = useRef({ persistDraft, save }); actions.current = { persistDraft, save };
  useEffect(() => {
    if (onClose) return;
    setWorkspaceApi(tab.id, { park: () => actions.current.persistDraft(),
      leave: async () => { if (live.current.dirty) await actions.current.save(); return true; },
      abortLoad: async () => { generation.current++; }, isLoadActive: () => false });
    return () => setWorkspaceApi(tab.id, null);
  }, [tab.id, onClose, setWorkspaceApi]);
  useEffect(() => {
    if (active && !onClose) setChrome({ ...NO_CHROME, pad: true });
  }, [active, onClose, setChrome]);
  useEffect(() => { if (!onClose) patchTab(tab.id, { dirty, title }); }, [dirty, title, tab.id, onClose, patchTab]);
  useEffect(() => {
    if (!dirty) return;
    const timer = window.setInterval(() => { void actions.current.persistDraft().catch(cause => setError(String(cause))); }, 3000);
    return () => window.clearInterval(timer);
  }, [dirty]);
  const close = async () => { await persistDraft(); onClose?.(); };
  const doc = snapshot && snapshot.kind !== "whiteboard" ? snapshot.value : null;
  const updateSource = (source: string) => {
    setSnapshot(current => current && current.kind !== "whiteboard" ? { ...current, value: { ...current.value, source } } : current);
    setDirty(true);
  };
  return <section className={[onClose ? "lc-artifact-overlay" : "lc-canvas-wrap", "lc-artifact-workspace", !showing && "lc-canvas-parked", splitRole && `is-split-${splitRole}`].filter(Boolean).join(" ")} aria-label="Attachment editor">
    <header className="lc-artifact-actions">
      <input aria-label="Attachment title" value={title} disabled={pending} onChange={event => { setTitle(event.target.value); setDirty(true); }} />
      <button disabled={!item || pending} onClick={() => void save().catch(() => {})}>Save</button>
      <button disabled={!item || pending} onClick={() => void save(true).catch(() => {})}>Save a copy</button>
      <button disabled={!item || pending || !dirty} onClick={() => { if (window.confirm("Discard this local draft and reopen the saved attachment?")) void deleteArtifactDraft(ref).then(() => reload(false)).catch(cause => setError(String(cause))); }}>Discard draft</button>
      {onClose && <><button disabled={pending} onClick={() => void persistDraft().then(() => { openWorkspace(artifactTab(ref, title)); onClose(); }).catch(cause => setError(String(cause)))}>Open tab</button>
        <button disabled={pending} onClick={() => void close().catch(cause => setError(String(cause)))}>Close</button></>}
    </header>
    {error && <p role="alert" className="lc-warning">{error} {!item && <button onClick={() => void reload()}>Retry</button>}</p>}
    <small role="status">{status || "Opening attachment…"}</small>
    {snapshot?.kind === "whiteboard" && <nav aria-label="Attachment pages">
      <button disabled={pending || page === 0} onClick={() => { setPage(page - 1); board.current?.fitRegion(`pad-${page - 1}`); }}>Previous page</button>
      <span>Page {page + 1} / {snapshot.value.pageCount}</span>
      <button disabled={pending || page + 1 >= snapshot.value.pageCount} onClick={() => { setPage(page + 1); board.current?.fitRegion(`pad-${page + 1}`); }}>Next page</button>
      <button disabled={pending || snapshot.value.pageCount >= WHITEBOARD_PAGE_LIMIT} onClick={() => {
        const canvas = board.current; if (!canvas || !hydrated.current) return;
        const index = snapshot.value.pageCount;
        canvas.appendScratchPage(buildScratchPageSkeletons(index, isDarkTheme(themeId)));
        setSnapshot({ ...snapshot, value: { ...snapshot.value, pageCount: index + 1 } });
        setPage(index); setDirty(true); canvas.fitRegion(`pad-${index}`);
      }}>Add page</button>
    </nav>}
    <div className="lc-artifact-canvas">
      {Board && snapshot && <Board ref={board} filmScope={`artifact:${tab.id}`} themeId={themeId} readingSize={readingSize}
        onChange={changed} interactive={!pending} chromeEnabled={active} splitPaused={!showing} annotateToggle docPaper
        focusRegion={doc ? ANNOTATE_REGION : `pad-${page}`} mobileRegion={doc ? ANNOTATE_REGION : `pad-${page}`}
        editToggle={Boolean(doc)} editing={editing} onToggleEdit={() => setEditing(value => !value)}
        pageContentHeight={doc ? height : undefined} transparentCanvas={Boolean(doc)} selectableContent={editing}
        pageContent={doc ? editing ? doc.docType === "code" ? <Suspense fallback={<p>Opening code editor…</p>}><MonacoBlock value={doc.source} language={title.endsWith(".js") ? "javascript" : title.endsWith(".ts") ? "typescript" : "python"} themeId={themeId} onChange={updateSource} onReady={() => {}} onContentHeight={setHeight} height={`${height}px`} /></Suspense>
          : <AnnotateMarkdownEditor value={doc.source} onChange={updateSource} onMeasure={setHeight} />
          : <AnnotateDocument source={doc.docType === "code" ? `\`\`\`\n${doc.source}\n\`\`\`` : doc.source} onMeasure={setHeight} /> : undefined} />}
    </div>
    {snapshot?.kind === "whiteboard" && snapshot.value.programs.map(program => <Timeline key={program.id} program={program} onFrame={frame => {
      const canvas = board.current; if (!canvas || !hydrated.current) return;
      applyViz({ getSceneElements: () => canvas.getElements(), updateScene: ({ elements }) => canvas.setElements(elements), getViewportBounds: () => canvas.getViewportBounds() }, skeletons => canvas.convert(skeletons), program, frame);
    }} />)}
  </section>;
}
