import type { ArtifactRef } from "./padArtifacts";
import { newTabId, type TabRecord } from "./tabs";

export function artifactTab(artifact: ArtifactRef, title: string): TabRecord {
  const base = { id: newTabId(artifact.kind === "whiteboard" ? "whiteboard" : "annotate"), title, artifact, dirty: false, lastActive: Date.now() };
  return artifact.kind === "whiteboard" ? { ...base, kind: "whiteboard", notebookId: null } :
    { ...base, kind: "annotate", docId: null, hash: null, source: null, docType: artifact.kind, indexed: "idle" };
}
