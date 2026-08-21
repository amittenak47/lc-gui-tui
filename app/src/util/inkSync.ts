/**
 * Handwriting and graph edges, moving between devices.
 *
 * Ink and edges were the only two rows that were both *authored* and
 * *unsynced* — the one combination that loses information for good. A snapshot
 * could carry them, but a snapshot is a restore point you reach for by hand;
 * an edit made on the desktop has to reach the tablet without anyone asking.
 *
 * The unit is a page, not a pad. Two devices writing on two pages of one
 * notebook have not disagreed about anything, and a pad-wide newest-wins would
 * throw one of them away for no reason. Only the same page, changed on both
 * sides since they last agreed, is a conflict — and that is rare enough, and
 * costly enough, to be worth saying out loud rather than resolving silently.
 *
 * Edges are stated facts with ids, so the merge is a union. Deleting is the
 * only event that needs a rule, and `gone` already models it.
 */

import type { EdgeRowDto, InkPageDigestDto, InkPageDto, LcClient } from "../api/client";
import { b64ToBytes, bytesToB64 } from "../api/nativeHttp";
import {
  annotateDocKey,
  getInkPageRecords,
  inkPageKey,
  type InkPageRecord,
  whiteboardDocKey,
} from "./inkPageStore";
import { STORE_INK_PAGES, withStore } from "./idb";
import { gzipBytes } from "./gzip";
import { packEncodedInk } from "../canvas/inkCodec";
import {
  deleteEdge,
  edgeIsGone,
  listEdges,
  listGoneEdgeIds,
  putEdge,
  type Edge,
} from "./noteLinks";
import { loadPadHub } from "./padHub";

export type InkPadKind = "annotate" | "whiteboard";

export function inkDocKey(kind: InkPadKind, key: string): string {
  return kind === "whiteboard" ? whiteboardDocKey(key) : annotateDocKey(key);
}

/**
 * A page both devices changed since they last agreed.
 *
 * `since` is the sync watermark, so "newer than it" means "written here since
 * the last time this device and the hub were in step". Both sides newer than
 * that is the only situation where taking the newest silently discards
 * something a person drew.
 */
export interface InkConflict {
  kind: InkPadKind;
  key: string;
  pageId: number;
  localUpdatedAt: number;
  remoteUpdatedAt: number;
}

export function isInkConflict(
  local: { updatedAt: number } | undefined,
  remote: { updated_at: number },
  since: number,
): boolean {
  if (!local) return false;
  if (local.updatedAt === remote.updated_at) return false;
  return local.updatedAt > since && remote.updated_at > since;
}

/**
 * Newest wins, and a tie keeps what is already here.
 *
 * The tie matters: two devices that saved in the same millisecond would
 * otherwise resolve by whichever pinged last, which is not a rule.
 */
export function remoteWins(
  local: { updatedAt: number } | undefined,
  remote: { updated_at: number },
): boolean {
  if (!local) return true;
  return remote.updated_at > local.updatedAt;
}

async function gzOf(row: InkPageRecord): Promise<Uint8Array<ArrayBuffer> | null> {
  if (row.gz && row.gz.byteLength > 0) {
    return row.gz instanceof Uint8Array
      ? (row.gz as Uint8Array<ArrayBuffer>)
      : new Uint8Array(row.gz);
  }
  if (!row.inkC) return null;
  try {
    return await gzipBytes(packEncodedInk(row.inkC));
  } catch {
    return null;
  }
}

async function writeInkPage(
  docKey: string,
  page: { page_id: number; updated_at: number; gz: string },
): Promise<void> {
  const raw = b64ToBytes(page.gz);
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const row: InkPageRecord = {
    v: 1,
    docKey,
    pageId: page.page_id,
    gz: new Uint8Array(buf),
    // Not dirty: this copy came *from* the hub, so pushing it back would be
    // this device restating what it was just told.
    dirty: false,
    updatedAt: page.updated_at,
  };
  await withStore(STORE_INK_PAGES, "readwrite", (store) => {
    store.put(row, inkPageKey(docKey, row.pageId));
  });
}

/**
 * Pull the pages a digest says are newer, and push the ones that are newer here.
 *
 * The digest is on the ping and carries no strokes, so a quiet fifteen seconds
 * costs one request and moves nothing. Bytes are fetched per pad, and only for
 * pads that actually have a page to move.
 */
export async function syncInkPages(
  client: LcClient,
  digests: InkPageDigestDto[],
  pads: Array<{ kind: InkPadKind; key: string }>,
  since: number,
): Promise<InkConflict[]> {
  if (!loadPadHub()) return [];
  const conflicts: InkConflict[] = [];
  const byPad = new Map<string, InkPageDigestDto[]>();
  for (const row of digests) {
    if (row.kind !== "annotate" && row.kind !== "whiteboard") continue;
    const id = `${row.kind}:${row.key}`;
    const list = byPad.get(id);
    if (list) list.push(row);
    else byPad.set(id, [row]);
  }

  const wanted = new Map<string, { kind: InkPadKind; key: string }>();
  for (const pad of pads) wanted.set(`${pad.kind}:${pad.key}`, pad);
  for (const [id, rows] of byPad) {
    const pad = wanted.get(id) ?? {
      kind: rows[0]!.kind as InkPadKind,
      key: rows[0]!.key,
    };
    wanted.set(id, pad);
  }

  for (const [id, pad] of wanted) {
    const docKey = inkDocKey(pad.kind, pad.key);
    const localRows = await getInkPageRecords(docKey);
    const localBy = new Map(localRows.map((row) => [row.pageId, row]));
    const remoteDigests = byPad.get(id) ?? [];
    const remoteBy = new Map(remoteDigests.map((row) => [row.page_id, row]));

    const toPull = remoteDigests.filter((row) => {
      const local = localBy.get(row.page_id);
      if (isInkConflict(local, row, since)) {
        conflicts.push({
          kind: pad.kind,
          key: pad.key,
          pageId: row.page_id,
          localUpdatedAt: local!.updatedAt,
          remoteUpdatedAt: row.updated_at,
        });
      }
      return remoteWins(local, row);
    });

    if (toPull.length > 0) {
      const bytes = await client.getInkPages(pad.kind, pad.key).catch(() => [] as InkPageDto[]);
      const bytesBy = new Map(bytes.map((row) => [row.page_id, row]));
      for (const digest of toPull) {
        const full = bytesBy.get(digest.page_id);
        if (!full?.gz) continue;
        await writeInkPage(docKey, full);
      }
    }

    for (const row of localRows) {
      const remote = remoteBy.get(row.pageId);
      if (remote && remote.updated_at >= row.updatedAt) continue;
      const gz = await gzOf(row);
      if (!gz) continue;
      await client
        .putInkPage({
          kind: pad.kind,
          key: pad.key,
          page_id: row.pageId,
          updated_at: row.updatedAt,
          gz: bytesToB64(gz),
        })
        .catch(() => undefined);
    }
  }
  return conflicts;
}

function edgeToDto(edge: Edge): EdgeRowDto {
  return {
    id: edge.id,
    from_type: edge.from.type,
    from_id: edge.from.id,
    to_type: edge.to.type,
    to_id: edge.to.id,
    kind: edge.kind,
    created_at: edge.createdAt,
    payload: edge,
  };
}

function edgeFromDto(row: EdgeRowDto): Edge | null {
  if (!row?.id) return null;
  const payload = row.payload;
  if (payload && typeof payload === "object" && "from" in payload && "to" in payload) {
    return payload as Edge;
  }
  return null;
}

/**
 * Union the edges, minus anything tombstoned on either side.
 *
 * Both halves matter. Without pushing the local tombstone, the hub keeps
 * handing the edge back; without honouring the remote one, this device keeps
 * handing it over. Either way the two trade a deleted edge forever.
 */
export async function syncEdges(
  client: LcClient,
  incoming: EdgeRowDto[],
  goneIds: string[],
): Promise<void> {
  if (!loadPadHub()) return;
  // A tombstone the hub reports has to land here, or this device offers the
  // edge back on its next push.
  for (const id of goneIds) {
    await deleteEdge(id);
  }
  const goneSet = new Set(goneIds);
  for (const row of incoming) {
    if (goneSet.has(row.id)) continue;
    const edge = edgeFromDto(row);
    if (!edge) continue;
    if (await edgeIsGone(edge.id)) continue;
    await putEdge(edge);
  }
  // And the other half: a delete that never leaves this device is one the hub
  // keeps handing back.
  const localGone = await listGoneEdgeIds();
  for (const id of localGone) {
    if (goneSet.has(id)) continue;
    await client.tombstoneEdge(id).catch(() => undefined);
    goneSet.add(id);
  }
  const local = await listEdges();
  const known = new Set(incoming.map((row) => row.id));
  const push = local.filter((edge) => !known.has(edge.id) && !goneSet.has(edge.id));
  if (push.length > 0) await client.putEdges(push.map(edgeToDto));
}
