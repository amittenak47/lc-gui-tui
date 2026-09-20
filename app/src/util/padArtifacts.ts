/** Phase 3 identities. Content stays in the existing scene/ink/document stores. */
export type ArtifactKind = "whiteboard" | "code" | "markdown";
export interface ArtifactParent {
  kind: "annotate" | "whiteboard" | "problem";
  /** Annotation-set/notebook/problem ID, never a document content hash. */
  id: string;
}

/** A link, not ownership, a thumbnail, a file path, or a copy of the content. */
export interface ArtifactRef {
  parent: ArtifactParent;
  artifactId: string;
  kind: ArtifactKind;
}

export type ArtifactAssociation =
  | { kind: "file" }
  | { kind: "thread"; rootId: string }
  | { kind: "footnote"; footnoteId: string };

export type ArtifactContent =
  | {
      kind: "whiteboard";
      boardId: string;
      /** Scene + page count + viz programs are one versioned dependency. */
      sceneRevision: string;
      /** Page 0 (spanning strokes) is valid. Empty means genuinely no shards. */
      ink: Array<{ pageId: number; revision: string }>;
    }
  | {
      kind: "code" | "markdown";
      /** Must resolve to an app-owned document, not an arbitrary disk path. */
      documentId: string;
      sourceRevision: string;
    };

export interface PadArtifact {
  id: string;
  title: string;
  /** Opaque revision. Never resolve concurrent edits using a timestamp. */
  revision: string;
  createdAt: number;
  updatedAt: number;
  associations: ArtifactAssociation[];
  content: ArtifactContent;
  /** Retain identity/content references for explicit restore; never filter out. */
  deletedAt?: number;
}

export interface ArtifactCatalog {
  v: 1;
  parent: ArtifactParent;
  revision: string;
  artifacts: PadArtifact[];
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function artifactKind(value: unknown): value is ArtifactKind {
  return value === "whiteboard" || value === "code" || value === "markdown";
}

function parseParent(value: unknown): ArtifactParent | undefined {
  if (!record(value) || !identity(value.id)) return undefined;
  if (value.kind !== "annotate" && value.kind !== "whiteboard" && value.kind !== "problem") return undefined;
  return { kind: value.kind, id: value.id };
}

export function artifactRefKey(ref: ArtifactRef): string {
  // A tuple avoids collisions between IDs containing ':' or '/'.
  return JSON.stringify([ref.parent.kind, ref.parent.id, ref.artifactId, ref.kind]);
}

/** Untrusted transcript/footnote links: keep valid identities, ignore extra data. */
export function sanitizeArtifactRefs(value: unknown): ArtifactRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const refs: ArtifactRef[] = [];
  for (const entry of value) {
    if (!record(entry) || !identity(entry.artifactId) || !artifactKind(entry.kind)) continue;
    const parent = parseParent(entry.parent);
    if (!parent) continue;
    const ref = { parent, artifactId: entry.artifactId, kind: entry.kind };
    const key = artifactRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs.length ? refs : undefined;
}

function parseAssociation(value: unknown): ArtifactAssociation | undefined {
  if (!record(value)) return undefined;
  if (value.kind === "file") return { kind: "file" };
  if (value.kind === "thread" && identity(value.rootId)) return { kind: "thread", rootId: value.rootId };
  if (value.kind === "footnote" && identity(value.footnoteId)) return { kind: "footnote", footnoteId: value.footnoteId };
  return undefined;
}

/** One shared artifact for all selected marks; no implicit notebook-library entry. */
export function artifactCreationAssociations(context: {
  activeFootnoteId?: string;
  attachedFootnoteIds?: readonly string[];
  referencedFootnoteIds?: readonly string[];
  threadRootId?: string;
}): ArtifactAssociation[] {
  const attached = [context.activeFootnoteId, ...(context.attachedFootnoteIds ?? [])].filter(identity);
  const marks = attached.length ? attached : (context.referencedFootnoteIds ?? []).filter(identity);
  if (marks.length) return [...new Set(marks)].map((footnoteId) => ({ kind: "footnote", footnoteId }));
  if (identity(context.threadRootId)) return [{ kind: "thread", rootId: context.threadRootId }];
  return [{ kind: "file" }];
}

function invalid(): never {
  throw new Error("Invalid artifact catalog; keep the existing copy and retry the transfer.");
}

function parseContent(value: unknown): ArtifactContent {
  if (!record(value)) return invalid();
  if (value.kind === "code" || value.kind === "markdown") {
    if (!identity(value.documentId) || !identity(value.sourceRevision)) return invalid();
    return { kind: value.kind, documentId: value.documentId, sourceRevision: value.sourceRevision };
  }
  if (value.kind !== "whiteboard" || !identity(value.boardId) || !identity(value.sceneRevision) || !Array.isArray(value.ink)) return invalid();
  const pageIds = new Set<number>();
  const ink = value.ink.map((page) => {
    if (!record(page) || !timestamp(page.pageId) || !identity(page.revision) || pageIds.has(page.pageId)) return invalid();
    pageIds.add(page.pageId);
    return { pageId: page.pageId, revision: page.revision };
  });
  return { kind: "whiteboard", boardId: value.boardId, sceneRevision: value.sceneRevision, ink };
}

/**
 * Absence is legacy, malformed/newer data is NOT an empty catalog. Fail closed
 * rather than drop an unrecognised row and advertise a successful sync.
 */
export function parseArtifactCatalog(value: unknown): ArtifactCatalog | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || value.v !== 1 || !identity(value.revision) || !Array.isArray(value.artifacts)) return invalid();
  const parent = parseParent(value.parent);
  if (!parent) return invalid();
  const ids = new Set<string>();
  const artifacts = value.artifacts.map((entry): PadArtifact => {
    if (!record(entry) || !identity(entry.id) || ids.has(entry.id) || !identity(entry.revision) ||
        typeof entry.title !== "string" || !entry.title.trim() ||
        !timestamp(entry.createdAt) || !timestamp(entry.updatedAt) || entry.updatedAt < entry.createdAt ||
        !Array.isArray(entry.associations)) return invalid();
    if (entry.deletedAt !== undefined && (!timestamp(entry.deletedAt) || entry.deletedAt < entry.createdAt || entry.deletedAt > entry.updatedAt)) return invalid();
    ids.add(entry.id);
    const associations = entry.associations.map((raw) => parseAssociation(raw) ?? invalid());
    if (new Set(associations.map((association) => JSON.stringify(association))).size !== associations.length) return invalid();
    return {
      id: entry.id, title: entry.title, revision: entry.revision,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, associations,
      content: parseContent(entry.content),
      ...(entry.deletedAt !== undefined ? { deletedAt: entry.deletedAt as number } : {}),
    };
  });
  return { v: 1, parent, revision: value.revision, artifacts };
}

/** Validate before changing storage; an absent legacy field does not mean delete. */
export function artifactCatalogFields(
  value: unknown,
  parent: ArtifactParent,
): { artifacts?: ArtifactCatalog } {
  const artifacts = parseArtifactCatalog(value);
  if (!artifacts) return {};
  if (artifacts.parent.kind !== parent.kind || artifacts.parent.id !== parent.id) {
    throw new Error("Artifact catalog belongs to a different parent; existing content was kept.");
  }
  return { artifacts };
}

export type ArtifactDependency =
  | { kind: "scene"; id: string; revision: string }
  | { kind: "ink"; id: string; pageId: number; revision: string }
  | { kind: "document"; id: string; revision: string };

/** Stable key for a *validated* dependency, including its owner and revision. */
export function artifactDependencyKey(parent: ArtifactParent, dependency: ArtifactDependency): string {
  return JSON.stringify([parent.kind, parent.id, dependency.kind, dependency.id,
    dependency.kind === "ink" ? dependency.pageId : null, dependency.revision]);
}

/** Deleted artifacts remain in the catalog but do not block a deletion transfer. */
export function artifactDependencies(artifact: PadArtifact): ArtifactDependency[] {
  if (artifact.deletedAt !== undefined) return [];
  const content = artifact.content;
  if (content.kind !== "whiteboard") return [{ kind: "document", id: content.documentId, revision: content.sourceRevision }];
  return [
    { kind: "scene", id: content.boardId, revision: content.sceneRevision },
    ...content.ink.map((page): ArtifactDependency => ({ kind: "ink", id: content.boardId, ...page })),
  ];
}

/**
 * Receipts are issued only after validated scene/ink/source writes. A thumbnail,
 * matching ID, or older revision is insufficient. This is not a network probe.
 */
export function missingArtifactDependencies(
  catalog: ArtifactCatalog,
  receipts: ReadonlySet<string>,
): ArtifactDependency[] {
  const missing = new Map<string, ArtifactDependency>();
  for (const artifact of catalog.artifacts) {
    for (const dependency of artifactDependencies(artifact)) {
      const key = artifactDependencyKey(catalog.parent, dependency);
      if (!receipts.has(key)) missing.set(key, dependency);
    }
  }
  return [...missing.values()];
}
