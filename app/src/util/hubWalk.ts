/**
 * The Sync walk's pad stages (E–H), one tap, in order.
 *
 * These differ from the fifteen-second auto-sync helpers on purpose: the walk
 * is a decision. A conflict here must stop everything and touch nothing — no
 * LWW overwrite, no queueing a doomed PUT behind a 409, no pulling hub rows
 * over local ink. The reader resolves; then the walk resumes at F.
 */

import type { AnnotatePadDto, EdgeRowDto, InkPageDigestDto, LcClient, WhiteboardPadDto } from "../api/client";
import { LcApiError } from "../api/client";
import { isInkConflict, syncEdges, syncInkPages } from "./inkSync";

export type HubPadKind = "annotate" | "whiteboard";

export interface WalkPad {
  kind: HubPadKind;
  id: string;
  /** The last hub write this device has actually seen. */
  hubAckUpdatedAt(): number;
  buildBody(): AnnotatePadDto | WhiteboardPadDto;
}

export type PadStageResult =
  | { outcome: "ok"; hubUpdatedAt: number }
  | {
      outcome: "conflict";
      /** What the hub holds now, when it could be read before stopping. */
      hubUpdatedAt: number | null;
      detail: string;
    };

/** One ping, reused by every stage of one walk so all stages see the same world. */
export interface WalkSnapshot {
  annotateRows: Array<{ id: string; updated_at: number; deleted_at?: number | null }>;
  whiteboardRows: Array<{ id: string; updated_at: number; deleted_at?: number | null }>;
  inkDigests: InkPageDigestDto[];
  edges: EdgeRowDto[];
  goneEdges: string[];
}

export async function snapshotHub(client: LcClient): Promise<WalkSnapshot> {
  const ping = await client.pingPadSync(0);
  return {
    annotateRows: ping.annotate ?? [],
    whiteboardRows: ping.whiteboard ?? [],
    inkDigests: ping.ink ?? [],
    edges: ping.edges ?? [],
    goneEdges: ping.gone_edges ?? [],
  };
}

function rowFor(snapshot: WalkSnapshot, pad: WalkPad) {
  const rows = pad.kind === "annotate" ? snapshot.annotateRows : snapshot.whiteboardRows;
  return rows.find((row) => row.id === pad.id && row.deleted_at == null);
}

/**
 * E — push this pad's JSON with compare-and-swap semantics.
 *
 * Two ways to stop, both before any apply: the hub row moved since our last
 * acknowledged write (pushing would silently win on recency), or the PUT came
 * back 409 (the hub disagreed with our base). Network errors are different:
 * they fail loudly rather than queueing a write the walk never confirmed.
 */
export async function walkPushPad(
  client: LcClient,
  pad: WalkPad,
  snapshot: WalkSnapshot,
): Promise<PadStageResult> {
  const row = rowFor(snapshot, pad);
  const acked = pad.hubAckUpdatedAt();
  if (row && row.updated_at > acked) {
    return {
      outcome: "conflict",
      hubUpdatedAt: row.updated_at,
      detail: `the hub has changes from ${new Date(row.updated_at).toLocaleString()}`,
    };
  }

  try {
    const written =
      pad.kind === "annotate"
        ? await client.putAnnotatePad(pad.id, pad.buildBody() as AnnotatePadDto)
        : await client.putWhiteboardPad(pad.id, pad.buildBody() as WhiteboardPadDto);
    return { outcome: "ok", hubUpdatedAt: written.updated_at ?? Date.now() };
  } catch (cause) {
    if (cause instanceof LcApiError && cause.status === 409) {
      return {
        outcome: "conflict",
        hubUpdatedAt: null,
        detail: "the hub rejected this sync because its copy changed first",
      };
    }
    throw cause;
  }
}

/**
 * F — handwriting for this pad only.
 *
 * Conflicts are detected against the same snapshot stage E saw, and stop the
 * walk before anything moves. A clean pad pulls newer remote pages and pushes
 * dirty local ones via the ordinary per-pad sync.
 */
export async function walkSyncInk(
  client: LcClient,
  pad: WalkPad,
  snapshot: WalkSnapshot,
  since: number,
): Promise<{ outcome: "ok" } | { outcome: "conflict"; pageId: number }> {
  const digests = snapshot.inkDigests.filter((row) => row.kind === pad.kind && row.key === pad.id);
  if (digests.length > 0) {
    const { getInkPageRecords } = await import("./inkPageStore");
    const docKey = `${pad.kind}:${pad.id}`;
    const localRows = await getInkPageRecords(docKey);
    const localBy = new Map(localRows.map((row) => [row.pageId, row]));
    for (const digest of digests) {
      if (isInkConflict(localBy.get(digest.page_id), digest, since)) {
        return { outcome: "conflict", pageId: digest.page_id };
      }
    }
  }
  await syncInkPages(client, digests, [{ kind: pad.kind, key: pad.id }], since);
  return { outcome: "ok" };
}

/**
 * G — note links and their snapshots.
 *
 * Edges union both sides (deletes included); snapshots only fill in what this
 * device is missing, so there is nothing here that can clobber local work.
 */
export async function walkSyncLinks(client: LcClient, snapshot: WalkSnapshot): Promise<void> {
  await syncEdges(client, snapshot.edges, snapshot.goneEdges);
}
