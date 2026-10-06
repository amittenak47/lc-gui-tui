import { useEffect, useState } from "react";
import { listRecoveryCopies, exportRecoveryCopy, type RecoveryCopy } from "../util/syncRecovery";
import { listAllPadSnapshots, getPadSnapshot, type PadSnapshotMeta } from "../util/padSnapshotStore";
import { restoreRetainedRecord, recoveryExportValue } from "../util/recoveryRestore";
import { restorePadSnapshotLocally } from "../util/artifactSnapshotRestore";

/** The existing library's backup flow includes removed parents and recovered copies. */
export function RetainedCopies({ kind, onRestored }: { kind: "annotate" | "whiteboard"; onRestored: () => void }) {
  const [copies, setCopies] = useState<RecoveryCopy[]>([]);
  const [snapshots, setSnapshots] = useState<PadSnapshotMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void Promise.all([listRecoveryCopies(), listAllPadSnapshots()]).then(([rows, backups]) => {
      if (!disposed) { setCopies(rows); setSnapshots(backups.filter(row => row.kind === kind)); }
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [kind]);
  const perform = async (work: () => Promise<void>) => {
    setPending(true); setError(null);
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const exportValue = async (name: string, value: unknown) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(await recoveryExportValue(value), null, 2)], { type: "application/json" }));
    try { const link = document.createElement("a"); link.href = url; link.download = `${name.replace(/[^a-z0-9._-]/gi, "_")}-backup.json`; link.click(); }
    finally { URL.revokeObjectURL(url); }
  };
  return <div className="lc-settings-choice">
    <p className="lc-muted">Retained copies stay on this device after restoration. Restoring keeps the current book as another retained copy.</p>
    {copies.map(copy => <div className="lc-scratch-load-entry" key={copy.id}>
      <strong>{String(copy.record?.meta.label ?? copy.record?.meta.title ?? copy.record?.meta.name ?? "Retained local copy")}</strong>
      <button type="button" disabled={pending} onClick={() => void perform(async () => exportValue(copy.bookId ?? "retained", await exportRecoveryCopy(copy.id)))}>Export copy</button>
      {copy.type === "record" && <button type="button" disabled={pending} onClick={() => {
        if (selected !== copy.id) { setSelected(copy.id); return; }
        void perform(async () => { await restoreRetainedRecord(copy.id); onRestored(); setNotice("The book was restored locally. Sync it when ready."); setSelected(null); });
      }}>{selected === copy.id ? "Confirm restore" : "Restore locally"}</button>}
    </div>)}
    {snapshots.map(snapshot => <div className="lc-scratch-load-entry" key={snapshot.snapshotId ?? `${snapshot.kind}:${snapshot.key}:${snapshot.tier}`}>
      <strong>{snapshot.name}</strong><span className="lc-muted">{snapshot.tier} · {new Date(snapshot.writtenAt).toLocaleString()}</span>
      <button type="button" disabled={pending} onClick={() => void perform(async () => {
        const row = await getPadSnapshot(snapshot.kind, snapshot.key, snapshot.tier, snapshot.snapshotId);
        if (!row) throw new Error("This backup cannot be read. Its stored copy was kept.");
        await exportValue(snapshot.name, row);
      })}>Export snapshot</button>
      <button type="button" disabled={pending} onClick={() => {
        const id = snapshot.snapshotId ?? `${snapshot.kind}:${snapshot.key}:${snapshot.tier}`;
        if (selected !== id) { setSelected(id); return; }
        void perform(async () => {
          const row = await getPadSnapshot(snapshot.kind, snapshot.key, snapshot.tier, snapshot.snapshotId);
          if (!row) throw new Error("This backup cannot be read. Its stored copy was kept.");
          await restorePadSnapshotLocally({ kind: snapshot.kind, id: snapshot.key }, row, row.artifactBundle);
          if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("lc-pad-hub", { detail: { kind: snapshot.kind, id: snapshot.key, op: "reload" } }));
          onRestored(); setNotice("The book was restored locally. Sync it when ready."); setSelected(null);
        });
      }}>{selected === (snapshot.snapshotId ?? `${snapshot.kind}:${snapshot.key}:${snapshot.tier}`) ? "Confirm restore" : "Restore locally"}</button>
    </div>)}
    {!copies.length && !snapshots.length && !error && <p className="lc-muted">No retained copies on this device.</p>}
    {error && <p className="lc-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>;
}
