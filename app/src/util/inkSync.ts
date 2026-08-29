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
  deleteInkPages,
  encodedFromRecord,
  getInkPageRecords,
  inkPageKey,
  type InkPageRecord,
  whiteboardDocKey,
} from "./inkPageStore";
import { STORE_INK_PAGES, withStore } from "./idb";
import { bytesFromMaybeGzip, gzipBytes } from "./gzip";
import {
  decodeInkOps,
  encodeInkOps,
  packEncodedInk,
  unpackEncodedInk,
  type EncodedInk,
} from "../canvas/inkCodec";
import type { HubInkChoice } from "./hubConflictStash";
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
 * Both stroke sets on one page, this device first then the other.
 *
 * Seq numbers are not a shared clock across devices, so concatenating encoded
 * shards and sorting by `s` would interleave two independent sequences.
 * Decoding and re-encoding puts the other copy on top of this one.
 */
export function mergeEncodedPages(
  local: Map<number, EncodedInk>,
  server: Map<number, EncodedInk>,
): Map<number, EncodedInk> {
  const ids = new Set<number>([...local.keys(), ...server.keys()]);
  const out = new Map<number, EncodedInk>();
  for (const pageId of ids) {
    const here = local.get(pageId);
    const there = server.get(pageId);
    if (here && there) {
      out.set(pageId, encodeInkOps([...decodeInkOps(here), ...decodeInkOps(there)]));
    } else if (here) {
      out.set(pageId, here);
    } else if (there) {
      out.set(pageId, there);
    }
  }
  return out;
}

async function encodedFromGzB64(gz: string): Promise<EncodedInk | null> {
  try {
    return unpackEncodedInk(await bytesFromMaybeGzip(b64ToBytes(gz)));
  } catch {
    return null;
  }
}

async function encodedPagesFromDtos(
  pages: readonly InkPageDto[],
): Promise<Map<number, EncodedInk>> {
  const out = new Map<number, EncodedInk>();
  for (const page of pages) {
    if (!page.gz) continue;
    const encoded = await encodedFromGzB64(page.gz);
    if (encoded) out.set(page.page_id, encoded);
  }
  return out;
}

/**
 * This device's pages as hub DTOs, for the conflict stash.
 *
 * `pageIds` narrows the work to the pages that will actually be looked at.
 * Freezing a conflict used to gzip every page of the pad, which on a textbook
 * someone has read through is the whole of their handwriting compressed at the
 * moment the pill is already parked — to render a preview of one page. An ink
 * conflict names its page, so pass that; a pad conflict does not, so it still
 * takes the lot.
 *
 * This is a *preview* list. It is not the set of pages that will be written on
 * resolve — see {@link applyInkChoice}, which takes the hub's page ids
 * separately for exactly that reason.
 */
export async function localInkAsDtos(
  kind: InkPadKind,
  key: string,
  pageIds?: readonly number[],
): Promise<InkPageDto[]> {
  const wanted = pageIds ? new Set(pageIds) : null;
  const rows = await getInkPageRecords(inkDocKey(kind, key));
  const out: InkPageDto[] = [];
  for (const row of rows) {
    if (wanted && !wanted.has(row.pageId)) continue;
    const gz = await gzOf(row);
    if (!gz) continue;
    out.push({
      kind,
      key,
      page_id: row.pageId,
      updated_at: row.updatedAt,
      gz: bytesToB64(gz),
    });
  }
  return out;
}

/**
 * Write the reader's ink choice into IDB and onto the hub.
 *
 * Keep local / merge / none must PUT, or the hub still holds the copy they
 * threw away and the next walk brings it back. Keep server only writes IDB
 * (those bytes already came from the hub).
 */
async function emptyInkGz(): Promise<string> {
  return bytesToB64(await gzipBytes(packEncodedInk(encodeInkOps([]))));
}

export async function applyInkChoice(
  client: LcClient,
  kind: InkPadKind,
  key: string,
  choice: HubInkChoice,
  serverInk: readonly InkPageDto[] | null,
  opts: {
    /**
     * Every page id the hub holds for this pad, from the ping digest.
     *
     * Keep Local and Drop Both only need to *name* the hub's pages, to empty-
     * PUT the ones this device does not have — and the digest already carries
     * those ids, so neither has any business reading the stash's preview list.
     * That list is now scoped to the colliding page, and treating it as the
     * whole hub set would leave discarded handwriting on the hub to come back
     * on the next walk. Absent, the served bytes stand in as before.
     */
    hubPageIds?: readonly number[];
  } = {},
): Promise<void> {
  const docKey = inkDocKey(kind, key);
  const now = Date.now();
  const hubPages = serverInk ?? [];
  /** Hub ids from the digest when we have it, else whatever we downloaded. */
  const hubIds = opts.hubPageIds ?? (serverInk ? serverInk.map((page) => page.page_id) : null);
  if (choice === "local") {
    await pushInkPagesToHub(client, kind, key);
    // Hub-only page ids stay on the hub unless we empty-PUT them. Keep Local
    // used to upload this device's pages and leave the rest, so discarded
    // handwriting came back on the next walk.
    if (hubIds) {
      const localIds = new Set(
        (await getInkPageRecords(docKey)).map((row) => row.pageId),
      );
      const emptyGz = await emptyInkGz();
      for (const pageId of new Set(hubIds)) {
        if (localIds.has(pageId)) continue;
        await client.putInkPage({
          kind,
          key,
          page_id: pageId,
          updated_at: now,
          gz: emptyGz,
        });
      }
    }
    return;
  }
  if (choice === "server") {
    /*
     * A failed GET is `null`, not `[]`. Empty is a real "the hub has no ink"
     * and clears this device. A failed download must not.
     */
    if (serverInk == null) return;
    await deleteInkPages(docKey);
    for (const page of serverInk) {
      if (!page.gz) continue;
      await writeInkPage(docKey, page);
    }
    return;
  }
  if (choice === "none") {
    const local = await getInkPageRecords(docKey);
    const ids = new Set<number>([
      ...local.map((row) => row.pageId),
      // Same as Keep Local: naming the hub's pages is enough to clear them,
      // and the digest names them all where the preview list does not.
      ...(hubIds ?? []),
    ]);
    await deleteInkPages(docKey);
    const emptyGz = await emptyInkGz();
    for (const pageId of ids) {
      const body = { page_id: pageId, updated_at: now, gz: emptyGz };
      await writeInkPage(docKey, body);
      await client.putInkPage({ kind, key, page_id: pageId, updated_at: now, gz: emptyGz });
    }
    return;
  }
  const localMap = new Map<number, EncodedInk>();
  for (const row of await getInkPageRecords(docKey)) {
    const encoded = await encodedFromRecord(row);
    if (encoded) localMap.set(row.pageId, encoded);
  }
  const merged = mergeEncodedPages(localMap, await encodedPagesFromDtos(hubPages));
  const gzByPage = new Map<number, string>();
  for (const [pageId, encoded] of merged) {
    const gz = bytesToB64(await gzipBytes(packEncodedInk(encoded)));
    gzByPage.set(pageId, gz);
    await writeInkPage(docKey, { page_id: pageId, updated_at: now, gz });
  }
  for (const [pageId, gz] of gzByPage) {
    await client.putInkPage({ kind, key, page_id: pageId, updated_at: now, gz });
  }
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
 * Conflict escape hatches for the Sync walk's ink stage (F).
 *
 * A dual-write page stops the walk with the split open; whichever whole pane
 * the reader keeps, these converge the two sides to it so the next walk sees
 * agreement instead of the same fight again. They are per-pad, not per-page,
 * because ink stays "whole pane" — nobody has answered for strokes yet.
 *
 * These throw. Both used to swallow their transfers — a failed download became
 * an empty list of pages and a failed upload was counted as one anyway — so a
 * reader who resolved a conflict over their handwriting, and moved nothing,
 * was told "Synced". A walk that cannot move the strokes has to say so.
 */

/** Take the hub's copies: overwrite this device's pages from what it holds. */
export async function pullInkPagesOverLocal(
  client: LcClient,
  kind: InkPadKind,
  key: string,
): Promise<number> {
  const bytes = await client.getInkPages(kind, key);
  const docKey = inkDocKey(kind, key);
  let written = 0;
  for (const full of bytes) {
    if (!full.gz) continue;
    await writeInkPage(docKey, full);
    written++;
  }
  return written;
}

/** Keep this device's copies: restate every local page on the hub. */
export async function pushInkPagesToHub(
  client: LcClient,
  kind: InkPadKind,
  key: string,
): Promise<number> {
  const localRows = await getInkPageRecords(inkDocKey(kind, key));
  let pushed = 0;
  for (const row of localRows) {
    const gz = await gzOf(row);
    if (!gz) continue;
    await client.putInkPage({
      kind,
      key,
      page_id: row.pageId,
      updated_at: row.updatedAt,
      gz: bytesToB64(gz),
    });
    // Counted after the write, not before it.
    pushed++;
  }
  return pushed;
}

/**
 * Pull the pages a digest says are newer, and push the ones that are newer here.
 *
 * The digest is on the ping and carries no strokes, so a quiet fifteen seconds
 * costs one request and moves nothing. Bytes are fetched per pad, and only for
 * pads that actually have a page to move.
 *
 * `strict` decides what a failed transfer means. The background ping runs every
 * fifteen seconds and swallows them: a page that did not move this time moves
 * next time, and there is nobody to tell. The Sync walk is a decision someone
 * made, once, and reports an outcome — so there it throws, and the pill parks
 * on Ink instead of walking on to "Synced" over strokes that never left.
 */
export async function syncInkPages(
  client: LcClient,
  digests: InkPageDigestDto[],
  pads: Array<{ kind: InkPadKind; key: string }>,
  since: number,
  opts: { strict?: boolean } = {},
): Promise<InkConflict[]> {
  const strict = opts.strict === true;
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
      const bytes = strict
        ? await client.getInkPages(pad.kind, pad.key)
        : await client.getInkPages(pad.kind, pad.key).catch(() => [] as InkPageDto[]);
      const bytesBy = new Map(bytes.map((row) => [row.page_id, row]));
      for (const digest of toPull) {
        const full = bytesBy.get(digest.page_id);
        if (!full?.gz) {
          // A truncated GET used to `continue` here, so the walk could still
          // reach Synced with strokes named by the digest but never written.
          if (strict) {
            throw new Error(
              `Ink page ${digest.page_id} was missing from the hub download`,
            );
          }
          continue;
        }
        await writeInkPage(docKey, full);
      }
    }

    for (const row of localRows) {
      const remote = remoteBy.get(row.pageId);
      if (remote && remote.updated_at >= row.updatedAt) continue;
      const gz = await gzOf(row);
      if (!gz) continue;
      const put = client.putInkPage({
        kind: pad.kind,
        key: pad.key,
        page_id: row.pageId,
        updated_at: row.updatedAt,
        gz: bytesToB64(gz),
      });
      if (strict) await put;
      else await put.catch(() => undefined);
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
