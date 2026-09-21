import {
  artifactCatalogFields, type ArtifactAssociation, type ArtifactCatalog,
  type ArtifactContent, type ArtifactParent, type PadArtifact,
} from "./padArtifacts";

export class ArtifactEditConflict extends Error {
  constructor() { super("Attachments changed since this edit started. Keep both versions and resolve the conflict."); }
}

type ArtifactPatch = Partial<Pick<PadArtifact, "title" | "associations" | "content">>;
export type ArtifactCatalogEdit =
  | { type: "create"; id: string; title: string; content: ArtifactContent; associations: ArtifactAssociation[] }
  | { type: "update"; id: string; expectedRevision: string; patch: ArtifactPatch }
  | { type: "delete" | "restore"; id: string; expectedRevision: string }
  | { type: "detach"; association: ArtifactAssociation };

function contentIdentity(content: ArtifactContent): string {
  return JSON.stringify([content.kind, content.kind === "whiteboard" ? content.boardId : content.documentId]);
}

function associationKey(association: ArtifactAssociation): string {
  return JSON.stringify([association.kind, association.kind === "file" ? null :
    association.kind === "thread" ? association.rootId : association.footnoteId]);
}

/** Shared local/remote transition rules. Omission by older callers preserves data. */
export function requireArtifactCatalogTransition(
  previous: unknown, incoming: unknown, parent: ArtifactParent,
): ArtifactCatalog | undefined {
  const before = artifactCatalogFields(previous, parent).artifacts;
  const next = artifactCatalogFields(incoming, parent).artifacts;
  if (!next) return before;
  if (!before) return next;
  if (before.revision === next.revision && JSON.stringify(before) !== JSON.stringify(next)) {
    throw new Error("Attachment catalog revision was reused for different content.");
  }
  const byId = new Map(next.artifacts.map((entry) => [entry.id, entry]));
  for (const old of before.artifacts) {
    const item = byId.get(old.id);
    if (!item) throw new Error("Attachment deletion records must be retained.");
    if (old.createdAt !== item.createdAt || contentIdentity(old.content) !== contentIdentity(item.content)) {
      throw new Error("Attachment identity cannot change; create an explicit copy instead.");
    }
    if (old.revision === item.revision && JSON.stringify(old) !== JSON.stringify(item)) {
      throw new Error("Attachment revision was reused for different content.");
    }
    if (old.deletedAt !== undefined && item.deletedAt === undefined &&
        (item.revision === old.revision || item.restoredFrom !== old.revision)) {
      throw new Error("Restoring an attachment must name its current deletion revision.");
    }
  }
  return next;
}

/**
 * Pure edit builder, not a storage lock. Persistence must compare the base
 * revision AGAIN inside its write transaction after staging dependencies.
 */
export function editArtifactCatalog(
  previous: ArtifactCatalog | undefined, parent: ArtifactParent,
  expectedCatalogRevision: string | null, edit: ArtifactCatalogEdit, now = Date.now(),
): ArtifactCatalog {
  const before = artifactCatalogFields(previous, parent).artifacts;
  if ((before?.revision ?? null) !== expectedCatalogRevision) throw new ArtifactEditConflict();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid attachment edit timestamp.");
  const entries = before?.artifacts ?? [];
  let changed = false;
  let artifacts: PadArtifact[];
  if (edit.type === "create") {
    if (entries.some((item) => item.id === edit.id)) throw new ArtifactEditConflict();
    artifacts = [...entries, { id: edit.id, title: edit.title, content: edit.content,
      associations: edit.associations, revision: crypto.randomUUID(), createdAt: now, updatedAt: now }];
    changed = true;
  } else if (edit.type === "detach") {
    const key = associationKey(edit.association);
    artifacts = entries.map((item) => {
      if (item.deletedAt !== undefined) return item;
      const associations = item.associations.filter((association) => associationKey(association) !== key);
      if (associations.length === item.associations.length) return item;
      changed = true;
      // Last association removed means unfiled/recoverable, NOT deleted.
      return { ...item, associations, revision: crypto.randomUUID(), updatedAt: Math.max(now, item.updatedAt + 1) };
    });
  } else {
    const current = entries.find((item) => item.id === edit.id);
    if (!current || current.revision !== edit.expectedRevision) throw new ArtifactEditConflict();
    if (edit.type === "restore" ? current.deletedAt === undefined : current.deletedAt !== undefined) {
      throw new Error("Attachment is not in the required live/deleted state for this edit.");
    }
    const updatedAt = Math.max(now, current.updatedAt + 1);
    let next: PadArtifact = { ...current, revision: crypto.randomUUID(), updatedAt };
    if (edit.type === "delete") next.deletedAt = updatedAt;
    else if (edit.type === "restore") {
      delete next.deletedAt;
      next.restoredFrom = current.revision;
    } else if (edit.type === "update") {
      // Do not spread an untrusted patch: identity/tombstone fields are immutable here.
      if (edit.patch.title !== undefined) next.title = edit.patch.title;
      if (edit.patch.associations !== undefined) next.associations = edit.patch.associations;
      if (edit.patch.content !== undefined) next.content = edit.patch.content;
    }
    artifacts = entries.map((item) => item.id === next.id ? next : item);
    changed = true;
  }
  if (!changed && before) return before;
  return requireArtifactCatalogTransition(before, {
    v: 1, parent, revision: crypto.randomUUID(), artifacts,
  }, parent)!;
}
