/** Explicit conflict resolution: never silently drop the losing authored version. */
import type { LcClient } from "../api/client";
import { artifactCatalogFields, type ArtifactCatalog, type ArtifactParent, type PadArtifact } from "./padArtifacts";
import { requireArtifactCatalogTransition } from "./artifactCatalogEdits";
import { downloadArtifactAssets } from "./artifactAssetSync";
import { loadOwnedDocumentSnapshot, stageOwnedDocumentSnapshot } from "./artifactDocuments";
import { loadWhiteboardArtifactSnapshot, stageWhiteboardArtifactSnapshot } from "./artifactWhiteboards";
import { mutateArtifacts, readArtifactCatalog } from "./artifactRepository";

export async function reconcileArtifactConflict(client: LcClient, parent: ArtifactParent, rawRemote: unknown, preference: "local" | "server"): Promise<ArtifactCatalog | undefined> {
  const local = await readArtifactCatalog(parent);
  const catalog = await prepareArtifactConflict(client, parent, local, rawRemote, preference);
  if (!catalog || catalog === local) return local;
  const saved = await mutateArtifacts(parent, local?.revision ?? null, { type: "snapshot", catalog });
  requireArtifactCatalogTransition(rawRemote, saved, parent);
  return saved;
}

/** Stage copies without publishing: callers can commit a whole parent atomically. */
export async function prepareArtifactConflict(client: LcClient, parent: ArtifactParent, local: ArtifactCatalog | undefined, rawRemote: unknown, preference: "local" | "server"): Promise<ArtifactCatalog | undefined> {
  const remote = artifactCatalogFields(rawRemote, parent).artifacts;
  if (!remote) return local;
  if (local?.revision === remote.revision && JSON.stringify(local) === JSON.stringify(remote)) return local;
  await downloadArtifactAssets(client, remote);
  const entries = new Map((local?.artifacts ?? []).map(item => [item.id, item]));
  const copies: PadArtifact[] = [];
  const copy = async (item: PadArtifact) => {
    if (item.deletedAt !== undefined) return;
    const id = crypto.randomUUID(), contentId = crypto.randomUUID();
    const content = item.content.kind === "whiteboard"
      ? await stageWhiteboardArtifactSnapshot(parent, contentId, await loadWhiteboardArtifactSnapshot(parent, item.content))
      : await stageOwnedDocumentSnapshot(parent, contentId, await loadOwnedDocumentSnapshot(parent, item.content));
    copies.push({ id, content, title: `${item.title} (conflict copy)`, revision: crypto.randomUUID(),
      createdAt: Date.now(), updatedAt: Date.now(), associations: item.associations });
  };
  for (const incoming of remote.artifacts) {
    const current = entries.get(incoming.id);
    if (!current) { entries.set(incoming.id, incoming); continue; }
    if (JSON.stringify(current) === JSON.stringify(incoming)) continue;
    let winner = preference === "local" ? current : incoming;
    // Deletion is not undone by selecting an old active version. An explicit
    // restore naming that exact tombstone is the only exception.
    if (current.deletedAt !== undefined && incoming.deletedAt === undefined && incoming.restoredFrom !== current.revision) winner = current;
    if (incoming.deletedAt !== undefined && current.deletedAt === undefined && current.restoredFrom !== incoming.revision) winner = incoming;
    const loser = winner === current ? incoming : current;
    if (loser.deletedAt === undefined && (winner.deletedAt !== undefined || JSON.stringify(loser.content) !== JSON.stringify(winner.content))) await copy(loser);
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1, incoming.updatedAt + 1);
    const merged: PadArtifact = { ...winner, revision: crypto.randomUUID(), updatedAt };
    if (winner.deletedAt === undefined) {
      if (current.deletedAt !== undefined) merged.restoredFrom = current.revision;
      else if (incoming.deletedAt !== undefined) merged.restoredFrom = incoming.revision;
      merged.associations = [...new Map([...current.associations, ...incoming.associations].map(entry => [JSON.stringify(entry), entry])).values()];
    }
    entries.set(incoming.id, merged);
  }
  const catalog: ArtifactCatalog = { v: 1, parent, revision: crypto.randomUUID(), artifacts: [...entries.values(), ...copies] };
  requireArtifactCatalogTransition(local, catalog, parent);
  requireArtifactCatalogTransition(remote, catalog, parent);
  return catalog;
}
