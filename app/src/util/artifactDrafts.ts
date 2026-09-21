import { getContent, putContent, deleteContent } from "./contentStore";
import { artifactRefKey, type ArtifactRef, type PadArtifact } from "./padArtifacts";
import type { ArtifactSnapshot } from "./artifactRepository";
import { packEncodedInk, unpackEncodedInk } from "../canvas/inkCodec";
import { bytesToB64, b64ToBytes } from "../api/nativeHttp";

export interface ArtifactDraft { v: 1; item: PadArtifact; title: string; snapshot: ArtifactSnapshot }
const key = (ref: ArtifactRef) => `artifact-draft:${artifactRefKey(ref)}`;
const writes = new Map<string, Promise<void>>();
function ordered(id: string, write: () => Promise<void>): Promise<void> {
  const next = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(write);
  writes.set(id, next);
  const release = () => { if (writes.get(id) === next) writes.delete(id); };
  void next.then(release, release);
  return next;
}
// putContent's private-WebView JSON fallback cannot round-trip a Map. Keep an
// explicit entry list there, rather than silently losing draft strokes.
export async function putArtifactDraft(ref: ArtifactRef, draft: ArtifactDraft) {
  const payload = { ...draft, snapshot: { ...draft.snapshot,
    value: { ...draft.snapshot.value, ink: [...draft.snapshot.value.ink].map(([id, ink]) => [id, bytesToB64(packEncodedInk(ink))]) } } };
  await ordered(key(ref), () => putContent(key(ref), payload));
}
export async function getArtifactDraft(ref: ArtifactRef): Promise<ArtifactDraft | null> {
  await writes.get(key(ref))?.catch(() => {});
  const raw = await getContent<ArtifactDraft>(key(ref));
  if (!raw || raw.v !== 1 || raw.item.id !== ref.artifactId) return null;
  const pages = raw.snapshot.value.ink as unknown as Array<[number, string]>;
  if (!Array.isArray(pages)) throw new Error("Local attachment draft ink is invalid; the draft was kept.");
  raw.snapshot.value.ink = new Map(pages.map(([id, packed]) => {
    const ink = unpackEncodedInk(b64ToBytes(packed));
    if (!ink) throw new Error("Local attachment draft ink is damaged; the draft was kept.");
    return [id, ink];
  }));
  return raw;
}
export const deleteArtifactDraft = (ref: ArtifactRef) => ordered(key(ref), () => deleteContent(key(ref)));
