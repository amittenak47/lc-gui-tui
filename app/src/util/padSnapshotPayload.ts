/**
 * Snapshot extras that travel with a pad: ink pages, graph edges, source text.
 *
 * The live annotate row already has source; ink left the board blob for
 * IndexedDB; edges were never pad content. A snapshot that omits them cannot
 * restore a device. Shape only — gathering from stores lives in
 * `padSnapshotExtras.ts` so this file stays free of IndexedDB.
 */

import { b64ToBytes, bytesToB64 } from "../api/nativeHttp";
import type { Edge, NodeRef, NodeType } from "./noteLinks";

export type SnapshotPadKind = "annotate" | "whiteboard";

export interface SnapshotInkPage {
  pageId: number;
  updatedAt: number;
  /** base64 of the gzip `packEncodedInk` bytes already on the page record. */
  gz: string;
}

export function padNodeRef(
  kind: SnapshotPadKind,
  key: string,
  docType?: string,
): NodeRef {
  if (kind === "whiteboard") return { type: "whiteboard", id: key };
  if (docType === "web") return { type: "web", id: key };
  return { type: "annotate", id: key };
}

export function snapshotInkDocKey(kind: SnapshotPadKind, key: string): string {
  return kind === "whiteboard" ? `wb:${key}` : `md:${key}`;
}

export function inkPageToSnapshot(page: {
  pageId: number;
  updatedAt: number;
  gz: Uint8Array<ArrayBuffer> | Uint8Array;
}): SnapshotInkPage {
  const copy = page.gz instanceof Uint8Array ? page.gz : new Uint8Array(page.gz);
  return {
    pageId: page.pageId,
    updatedAt: page.updatedAt,
    gz: bytesToB64(copy),
  };
}

export function snapshotInkToBytes(
  page: SnapshotInkPage,
): { pageId: number; updatedAt: number; gz: Uint8Array<ArrayBuffer> } | null {
  if (!page.gz || typeof page.pageId !== "number") return null;
  try {
    const raw = b64ToBytes(page.gz);
    const gz = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    return { pageId: page.pageId, updatedAt: page.updatedAt, gz: new Uint8Array(gz) };
  } catch {
    return null;
  }
}

function isNodeRef(value: unknown): value is NodeRef {
  if (!value || typeof value !== "object") return false;
  const row = value as NodeRef;
  return typeof row.type === "string" && typeof row.id === "string";
}

const NODE_TYPES: ReadonlySet<NodeType> = new Set([
  "annotate",
  "whiteboard",
  "practice",
  "web",
  "thread",
]);

export function parseSnapshotEdges(value: unknown): Edge[] {
  if (!Array.isArray(value)) return [];
  const out: Edge[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Edge;
    if (typeof row.id !== "string" || !row.id) continue;
    if (typeof row.kind !== "string") continue;
    if (!isNodeRef(row.from) || !isNodeRef(row.to)) continue;
    if (!NODE_TYPES.has(row.from.type) || !NODE_TYPES.has(row.to.type)) continue;
    out.push({
      id: row.id,
      from: row.from,
      to: row.to,
      kind: row.kind as Edge["kind"],
      createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    });
  }
  return out;
}

export function parseSnapshotInk(value: unknown): SnapshotInkPage[] {
  if (!Array.isArray(value)) return [];
  const out: SnapshotInkPage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as SnapshotInkPage;
    if (typeof row.pageId !== "number" || typeof row.updatedAt !== "number") continue;
    if (typeof row.gz !== "string" || !row.gz) continue;
    out.push({ pageId: row.pageId, updatedAt: row.updatedAt, gz: row.gz });
  }
  return out;
}

export function parseSnapshotSource(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
