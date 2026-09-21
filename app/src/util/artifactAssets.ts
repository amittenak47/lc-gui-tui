/** Immutable transfer copies; never restore these over a dirty live editor. */
import type { BoardBlob } from "../canvas/BoardHandle";
import { unpackEncodedInk } from "../canvas/inkCodec";
import { b64ToBytes } from "../api/nativeHttp";
import { parseVizProgram } from "../viz/schema";
import { parseArtifactSourceReference, REFERENCE_TEXT_LIMIT } from "./artifactReference";
import {
  artifactIdentity, parseArtifactParent, artifactDependencyKey,
  type ArtifactDependency, type ArtifactParent,
} from "./padArtifacts";

export interface ArtifactAssetLocator {
  parent: ArtifactParent;
  dependency: ArtifactDependency;
}
export interface ArtifactAsset extends ArtifactAssetLocator {
  /** Exact serialized JSON. Same revision must always carry identical bytes. */
  payload: string;
}
export const ARTIFACT_ASSET_MAX_BYTES = 24 * 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function pageId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function invalid(): never { throw new Error("Invalid attachment content; existing data was kept."); }

export function parseArtifactAssetLocator(raw: unknown): ArtifactAssetLocator {
  if (!object(raw)) return invalid();
  const parent = parseArtifactParent(raw.parent);
  const dep = raw.dependency;
  if (!parent || !object(dep) || !artifactIdentity(dep.id) || !artifactIdentity(dep.revision)) return invalid();
  let dependency: ArtifactDependency;
  if (dep.kind === "ink" && pageId(dep.pageId)) {
    dependency = { kind: "ink", id: dep.id, revision: dep.revision, pageId: dep.pageId };
  } else if (dep.kind === "scene" || dep.kind === "document") {
    dependency = { kind: dep.kind, id: dep.id, revision: dep.revision };
  } else return invalid();
  return { parent, dependency };
}

function validateBoard(value: unknown): asserts value is BoardBlob {
  if (!object(value) || value.v !== 1 || !Array.isArray(value.elements) || !object(value.appState)) return invalid();
  const state = value.appState;
  if (typeof state.scrollX !== "number" || !Number.isFinite(state.scrollX) ||
      typeof state.scrollY !== "number" || !Number.isFinite(state.scrollY) ||
      typeof state.zoom !== "number" || !Number.isFinite(state.zoom) || state.zoom <= 0) return invalid();
  // Typed arrays cannot safely travel as plain JSON; handwriting has its own payload.
  if (value.ink !== undefined || value.inkC !== undefined) return invalid();
  if (value.inkPages !== undefined) {
    if (!object(value.inkPages) || value.inkPages.v !== 1 || !Array.isArray(value.inkPages.pageIds) ||
        !value.inkPages.pageIds.every(pageId) ||
        new Set(value.inkPages.pageIds).size !== value.inkPages.pageIds.length) return invalid();
  }
}

function validatePackedInk(value: unknown): void {
  if (typeof value !== "string" || !value.length) return invalid();
  try {
    const bytes = b64ToBytes(value);
    if (bytes.length < 12) return invalid();
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metadataLength = header.getUint32(8, true);
    if (metadataLength > bytes.length - 12) return invalid();
    const metadata: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + metadataLength)));
    if (!object(metadata) || !Array.isArray(metadata.meta)) return invalid();
    let length = 12 + metadataLength;
    // The legacy codec tolerates short buffers. Validate before it allocates
    // typed arrays so damaged transfers cannot silently become zeroed ink.
    for (const op of metadata.meta) {
      if (!object(op)) return invalid();
      for (const [field, width] of [["xyN", 2], ["prN", 1], ["slN", 1], ["rrN", 2]] as const) {
        const count = op[field];
        if (!pageId(count) || count > (bytes.length - length) / width) return invalid();
        length += count * width;
      }
    }
    if (length !== bytes.length || !unpackEncodedInk(bytes)) return invalid();
  } catch { return invalid(); }
}

/** Full client validation runs before writing a received revision. */
export function parseArtifactAsset(raw: unknown): ArtifactAsset {
  const locator = parseArtifactAssetLocator(raw);
  if (!object(raw) || typeof raw.payload !== "string" ||
      raw.payload.length > ARTIFACT_ASSET_MAX_BYTES ||
      new TextEncoder().encode(raw.payload).byteLength > ARTIFACT_ASSET_MAX_BYTES) return invalid();
  const payload: unknown = JSON.parse(raw.payload);
  if (!object(payload) || payload.v !== 1) return invalid();
  switch (locator.dependency.kind) {
    case "scene": {
      validateBoard(payload.board);
      if (typeof payload.pageCount !== "number" || !Number.isSafeInteger(payload.pageCount) || payload.pageCount < 1) return invalid();
      if (!Array.isArray(payload.programs) || payload.programs.some((program) => !parseVizProgram(program))) return invalid();
      break;
    }
    case "ink":
      validatePackedInk(payload.packed);
      break;
    case "document": {
      const reference = parseArtifactSourceReference(payload.sourceReference);
      if (reference && (typeof payload.source !== "string" || payload.source.length > REFERENCE_TEXT_LIMIT)) return invalid();
      if (payload.owned !== true || (payload.docType !== "code" && payload.docType !== "markdown") ||
          typeof payload.name !== "string" || !payload.name.trim() || typeof payload.source !== "string" ||
          !Array.isArray(payload.footnotes) || !Array.isArray(payload.agent) || !Array.isArray(payload.ink)) return invalid();
      // Legacy mutable fnwb pointers require their own dependency transfer.
      // Until that migration exists, do not accept a deceptively complete file.
      if (payload.footnotes.some((note) => !object(note) ||
          (note.whiteboards !== undefined && (!Array.isArray(note.whiteboards) || note.whiteboards.length > 0)))) return invalid();
      validateBoard(payload.board);
      const pages = new Set<number>();
      for (const ink of payload.ink) {
        if (!object(ink) || !pageId(ink.pageId) || pages.has(ink.pageId)) return invalid();
        validatePackedInk(ink.packed);
        pages.add(ink.pageId);
      }
      const expected = payload.board.inkPages?.pageIds ?? [];
      if (expected.length !== pages.size || expected.some((id) => !pages.has(id))) return invalid();
      break;
    }
  }
  return { ...locator, payload: raw.payload };
}

export function artifactAssetKey(asset: ArtifactAssetLocator): string {
  return `artifact-asset:v1:${artifactDependencyKey(asset.parent, asset.dependency)}`;
}

export function requireArtifactAssetAck(sent: ArtifactAsset, received: unknown): void {
  const actual = parseArtifactAsset(received);
  if (artifactAssetKey(actual) !== artifactAssetKey(sent) || actual.payload !== sent.payload) {
    throw new Error("Attachment transfer was not acknowledged; retry before syncing the parent.");
  }
}
