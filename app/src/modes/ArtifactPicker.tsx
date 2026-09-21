import { useEffect, useRef, useState } from "react";
import type { ArtifactAssociation, ArtifactCatalog, ArtifactKind, ArtifactParent, ArtifactRef } from "../util/padArtifacts";
import { ARTIFACTS_CHANGED, artifactRef, createArtifact, mutateArtifacts, readArtifactCatalog } from "../util/artifactRepository";
import { buildWhiteboardTemplate } from "../templates/whiteboard";
import { buildAnnotateTemplate } from "../templates/annotate";
import { convertToExcalidrawElements } from "../canvas/convertSkeletons";
import { useShell } from "../shellContext";
import { isDarkTheme } from "../theme/appThemes";
import { syncArtifactParent } from "../util/artifactSync";
import { ArtifactCards } from "./ArtifactCards";
import "./artifacts.css";

export interface ArtifactPickerProps {
  parent: ArtifactParent;
  associations: ArtifactAssociation[];
  onAttach: (ref: ArtifactRef) => void;
  onOpen: (ref: ArtifactRef) => void;
  onClose: () => void;
  markChoices?: Array<{ id: string; title: string; selected: boolean }>;
  onToggleMark?: (id: string) => void;
}
export function ArtifactPicker({ parent, associations, onAttach, onOpen, onClose, markChoices = [], onToggleMark }: ArtifactPickerProps) {
  const { themeId, client } = useShell();
  const [catalog, setCatalog] = useState<ArtifactCatalog>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState("");
  const refresh = () => readArtifactCatalog(parent).then(setCatalog).catch(cause => setError(String(cause)));
  useEffect(() => { void refresh(); const listener = () => { void refresh(); }; window.addEventListener(ARTIFACTS_CHANGED, listener); return () => window.removeEventListener(ARTIFACTS_CHANGED, listener); }, [parent.kind, parent.id]);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try { await action(); await refresh(); await syncArtifactParent(client, parent); }
    catch (cause) { setError(String(cause)); } finally { running.current = false; setBusy(false); }
  };
  const create = (kind: ArtifactKind) => run(async () => {
    const name = title.trim() || (kind === "whiteboard" ? "Whiteboard" : kind === "code" ? "Code.py" : "Note.md");
    const board = { v: 1 as const, elements: convertToExcalidrawElements(kind === "whiteboard" ? buildWhiteboardTemplate(1, isDarkTheme(themeId)) : buildAnnotateTemplate(1600, isDarkTheme(themeId))), appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
    const ref = await createArtifact(parent, name, associations, kind === "whiteboard" ? { kind, value: { board, pageCount: 1, programs: [], ink: new Map() } } :
      { kind, value: { owned: true, docType: kind, name, source: kind === "markdown" ? `# ${name.replace(/\.md$/i, "")}\n` : "", board, footnotes: [], agent: [], ink: new Map() } });
    onAttach(ref); onOpen(ref);
  });
  return <div className="lc-artifact-picker" role="dialog" aria-modal="true" aria-label="Attachments">
    <header><strong>Attachments</strong><button disabled={busy} onClick={onClose}>Close</button></header>
    {markChoices.length > 0 && <><strong>Footnotes for the next question</strong><nav>{markChoices.map(mark => <button key={mark.id} aria-pressed={mark.selected} onClick={() => onToggleMark?.(mark.id)}>{mark.title}</button>)}</nav><hr /></>}
    <p>Owned by this document or board. Attach the same item to several marks or threads without copying it.</p>
    <input aria-label="New attachment title" placeholder="New attachment title (optional)" value={title} onChange={event => setTitle(event.target.value)} />
    <nav>{(["whiteboard", "markdown", "code"] as const).map(kind => <button key={kind} disabled={busy} onClick={() => void create(kind)}>New {kind}</button>)}</nav>
    <hr /><input aria-label="Filter attachments" placeholder="Find a whiteboard or file" value={filter} onChange={event => setFilter(event.target.value)} />
    {error && <p role="alert">{error}</p>}
    {!catalog?.artifacts.length && <p>No saved attachments yet.</p>}
    {catalog?.artifacts.filter(item => item.title.toLowerCase().includes(filter.toLowerCase())).map(item => {
      const ref = artifactRef(parent, item);
      return <div className="lc-artifact-picker-row" key={item.id}>
        <span>{item.title}{item.deletedAt !== undefined ? " · Trash" : !item.associations.length ? " · Unfiled" : ""}</span>
        {item.deletedAt === undefined && <>
          <ArtifactCards references={[ref]} onOpen={onOpen} />
          <button disabled={busy} onClick={() => void run(async () => {
            const next = [...item.associations];
            for (const association of associations) if (!next.some(entry => JSON.stringify(entry) === JSON.stringify(association))) next.push(association);
            await mutateArtifacts(parent, catalog.revision, { type: "update", id: item.id, expectedRevision: item.revision, patch: { associations: next } });
            onAttach(ref); onClose();
          })}>Attach here</button>
          <button disabled={busy} onClick={() => void run(async () => {
            const remove = new Set(associations.map(association => JSON.stringify(association)));
            await mutateArtifacts(parent, catalog.revision, { type: "update", id: item.id, expectedRevision: item.revision,
              patch: { associations: item.associations.filter(association => !remove.has(JSON.stringify(association))) } });
          })}>Unfile here</button>
        </>}
        <button disabled={busy} onClick={() => void run(async () => {
          if (item.deletedAt === undefined && !window.confirm(`Move “${item.title}” to attachment Trash? Existing cards will retain their links.`)) return;
          await mutateArtifacts(parent, catalog.revision, { type: item.deletedAt === undefined ? "delete" : "restore", id: item.id, expectedRevision: item.revision });
        })}>{item.deletedAt === undefined ? "Trash" : "Restore"}</button>
      </div>;
    })}
  </div>;
}
