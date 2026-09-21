import { useEffect, useRef, useState } from "react";
import { artifactRefKey, type ArtifactRef } from "../util/padArtifacts";
import { ARTIFACTS_CHANGED, readArtifact, type ArtifactSnapshot } from "../util/artifactRepository";
import "./artifacts.css";

function BoardThumbnail({ snapshot }: { snapshot: ArtifactSnapshot }) {
  const node = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ exportToCanvas, getCommonBounds }, { decodeInkOps }, { paintInkAtScale }] = await Promise.all([
        import("../canvas/boardScene"), import("../canvas/inkCodec"), import("../canvas/rasterInk"),
      ]);
      if (cancelled) return;
      const blob = snapshot.value.board;
      const [x, y, right, bottom] = getCommonBounds(blob.elements);
      const scale = Math.min(320 / Math.max(1, right - x), 160 / Math.max(1, bottom - y));
      const scene = await exportToCanvas({ elements: blob.elements, files: blob.files, appState: { exportScale: scale } });
      if (cancelled || !node.current) return;
      const canvas = node.current;
      canvas.width = scene.width; canvas.height = scene.height;
      const ctx = canvas.getContext("2d"); if (!ctx) return;
      ctx.drawImage(scene, 0, 0);
      const ink = document.createElement("canvas"); ink.width = scene.width; ink.height = scene.height;
      const inkCtx = ink.getContext("2d"); if (!inkCtx) return;
      for (const encoded of snapshot.value.ink.values()) {
        if (cancelled) return;
        paintInkAtScale(inkCtx, decodeInkOps(encoded), { x, y }, scale);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      if (!cancelled) ctx.drawImage(ink, 0, 0);
    })().catch(() => {}); // A preview is disposable, never content readiness.
    return () => { cancelled = true; };
  }, [snapshot]);
  return <canvas ref={node} style={{ width: "100%", height: 72, objectFit: "contain" }} aria-label="Whiteboard preview" />;
}

function ArtifactCard({ reference, onOpen }: { reference: ArtifactRef; onOpen: (ref: ArtifactRef) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof readArtifact>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    let visible = typeof IntersectionObserver === "undefined";
    const refresh = () => { if (visible) void readArtifact(reference).then(value => { if (!cancelled) { setData(value); setError(null); } }).catch(cause => { if (!cancelled) { setData(null); setError(String(cause)); } }); };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting); if (visible) refresh();
    });
    if (anchor.current) observer?.observe(anchor.current);
    refresh();
    window.addEventListener(ARTIFACTS_CHANGED, refresh);
    return () => { cancelled = true; observer?.disconnect(); window.removeEventListener(ARTIFACTS_CHANGED, refresh); };
  }, [artifactRefKey(reference)]);
  return <button ref={anchor} className="lc-artifact-card" type="button" title={error ?? "Preview attachment"} onClick={() => onOpen(reference)}>
    <strong>{data?.item.title ?? `${reference.kind} attachment`}</strong>
    {data?.snapshot.kind === "whiteboard" ? <BoardThumbnail snapshot={data.snapshot} /> : data ? <pre>{data.snapshot.value.source.slice(0, 300)}</pre> : <small>{error ?? "Loading preview…"}</small>}
    <small>{reference.kind} · Tap to open</small>
  </button>;
}

export function ArtifactCards({ references, onOpen }: { references?: ArtifactRef[]; onOpen: (ref: ArtifactRef) => void }) {
  return references?.length ? <div className="lc-artifact-cards">{references.map(ref => <ArtifactCard key={artifactRefKey(ref)} reference={ref} onOpen={onOpen} />)}</div> : null;
}
