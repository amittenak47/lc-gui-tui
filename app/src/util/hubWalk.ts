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
import {
  footnoteInkKeys,
  isInkConflict,
  inkDocKey,
  splitFootnoteInkHubKey,
  syncEdges,
  syncInkPages,
} from "./inkSync";
import { localFootnoteBoardIds } from "./annotateStore";

export type HubPadKind = "annotate" | "whiteboard";

export interface WalkPad {
  kind: HubPadKind;
  id: string;
  /** The last hub write this device has actually seen. */
  hubAckUpdatedAt(): number;
  buildBody(): AnnotatePadDto | WhiteboardPadDto | Promise<AnnotatePadDto | WhiteboardPadDto>;
  /**
   * Remember the row this device just wrote.
   *
   * Without it a successful push left the ack where it was, so the next walk
   * compared the hub's copy — the one this device had put there a moment ago —
   * against a stale acknowledgement, found it newer, and raised a conflict
   * with the device's own previous upload.
   */
  markHubAck?(updatedAt: number): void | Promise<void>;
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

/**
 * The snapshot every stage of one walk compares against.
 *
 * Split from the request because the walk already pings once, at stage A, to
 * find out whether the hub is up — and that answer *is* this. Fetching it
 * twice per tap downloaded the same full listing again and, worse, let two
 * stages of one walk look at two different worlds.
 */
export function snapshotFromPing(ping: {
  annotate?: WalkSnapshot["annotateRows"];
  whiteboard?: WalkSnapshot["whiteboardRows"];
  ink?: InkPageDigestDto[];
  edges?: EdgeRowDto[];
  gone_edges?: string[];
}): WalkSnapshot {
  return {
    annotateRows: ping.annotate ?? [],
    whiteboardRows: ping.whiteboard ?? [],
    inkDigests: ping.ink ?? [],
    edges: ping.edges ?? [],
    goneEdges: ping.gone_edges ?? [],
  };
}

export async function snapshotHub(client: LcClient): Promise<WalkSnapshot> {
  return snapshotFromPing(await client.pingPadSync(0));
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
    const body = await Promise.resolve(pad.buildBody());
    const written =
      pad.kind === "annotate"
        ? await client.putAnnotatePad(pad.id, body as AnnotatePadDto)
        : await client.putWhiteboardPad(pad.id, body as WhiteboardPadDto);
    const hubUpdatedAt = written.updated_at ?? Date.now();
    // Acked here rather than at the call site, so no path can push and forget.
    await pad.markHubAck?.(hubUpdatedAt);
    return { outcome: "ok", hubUpdatedAt };
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
): Promise<
  | { outcome: "ok" }
  | { outcome: "conflict"; pageId: number; inkKey: string; wbId?: string }
> {
  /*
   * A document's own pages, and every scratch board hanging off its marks.
   *
   * The boards are their own hub keys — `{padId}/fn/{wbId}` — so they conflict,
   * push and pull per page like everything else, instead of riding inside the
   * pad's JSON. See `footnoteInkKeys` for which boards are worth naming.
   */
  const inkKeys = [
    pad.id,
    ...(pad.kind === "annotate"
      ? await footnoteInkKeys(pad.id, snapshot.inkDigests, () =>
          localFootnoteBoardIds(pad.id),
        )
      : []),
  ];
  const digests = snapshot.inkDigests.filter(
    (row) => row.kind === pad.kind && inkKeys.includes(row.key),
  );
  if (digests.length > 0) {
    const { getInkPageRecords } = await import("./inkPageStore");
    const localByKey = new Map<string, Map<number, { updatedAt: number }>>();
    for (const key of inkKeys) {
      const rows = await getInkPageRecords(inkDocKey(pad.kind, key));
      localByKey.set(key, new Map(rows.map((row) => [row.pageId, row])));
    }
    for (const digest of digests) {
      const local = localByKey.get(digest.key)?.get(digest.page_id);
      if (isInkConflict(local, digest, since)) {
        return {
          outcome: "conflict",
          pageId: digest.page_id,
          inkKey: digest.key,
          ...(splitFootnoteInkHubKey(digest.key)?.wbId
            ? { wbId: splitFootnoteInkHubKey(digest.key)!.wbId }
            : {}),
        };
      }
    }
  }
  /*
   * Strict: a transfer that failed must fail the walk.
   *
   * This used to swallow both directions and return "ok" regardless, so a
   * hub that went away mid-stage still ended the walk on "Synced" with the
   * strokes still only on one device.
   */
  await syncInkPages(
    client,
    digests,
    inkKeys.map((key) => ({ kind: pad.kind, key })),
    since,
    { strict: true },
  );
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
