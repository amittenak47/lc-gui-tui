/**
 * Read-only "what does the hub already have?" probes.
 *
 * Fired once after first paint of an opened document. None of these mutate
 * anything on either side — no apply, no reload, no queue — because deciding
 * what to copy where belongs to the Sync tap, not to opening. A stale hint is
 * harmless: the tap-time walk re-runs the same questions against the live hub.
 */

import { loadPadHub } from "./padHub";

export interface DocHubHint {
  /** Document content hash the hint was probed for. */
  hash: string;
  /**
   * `updated_at` of this pad's row on the hub, or null when the hub has no
   * row for it yet. First push will not be a conflict.
   */
  padUpdatedAt: number | null;
  /** True when the hub answers for this document's bytes. */
  bytesOnHub: boolean;
  /**
   * True when the hub index reports the document indexed with pages —
   * extract can be skipped later. Local docs.db is never consulted here.
   */
  indexedOnHub: boolean;
}

interface SyncListRow {
  id?: unknown;
  updated_at?: unknown;
  deleted_at?: unknown;
}

function rowUpdatedAt(row: SyncListRow): number | null {
  return typeof row.updated_at === "number" ? row.updated_at : null;
}

export async function fetchDocHubHint(opts: {
  hash: string;
  /** This session's annotate pad id, when the document has one. */
  padId?: string | null;
}): Promise<DocHubHint> {
  const hub = loadPadHub();
  if (!hub) throw new Error("no hub configured");
  const base = `${hub.url}/`;
  const headers = { "x-lc-token": hub.token };
  const hashPath = encodeURIComponent(opts.hash);

  const hint: DocHubHint = {
    hash: opts.hash,
    padUpdatedAt: null,
    bytesOnHub: false,
    indexedOnHub: false,
  };

  // Each probe fails alone: an unreachable hub must not turn one answer into
  // three lies. Whatever did not come back reads as "not there", which is the
  // safe direction — the tap-time walk re-checks before acting anyway.
  const probes: Array<Promise<void>> = [];

  if (opts.padId) {
    const padId = opts.padId;
    probes.push(
      (async () => {
        /*
         * One pad, not the library.
         *
         * This used to ask `pads/sync?since=0`, which answers with every
         * changed pad *body* and every snapshot, so opening one document
         * pulled the whole hub through the room to read a single timestamp
         * off it. The route serves tombstoned rows as 404, so an absent or
         * deleted pad reads as "the hub has no row", same as before.
         */
        const res = await fetch(`${base}pads/annotate/${encodeURIComponent(padId)}`, {
          headers,
        });
        if (!res.ok) return;
        const row = (await res.json().catch(() => null)) as SyncListRow | null;
        if (row) hint.padUpdatedAt = rowUpdatedAt(row);
      })(),
    );
  }

  // HEAD: axum serves it off the GET route without a body, so existence costs
  // nothing instead of pulling a whole book through the room.
  probes.push(
    (async () => {
      const res = await fetch(`${base}docs/${hashPath}/bytes`, {
        method: "HEAD",
        headers,
      });
      hint.bytesOnHub = res.ok;
    })(),
  );

  probes.push(
    (async () => {
      const res = await fetch(`${base}docs/${hashPath}/index`, { headers });
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as {
        indexed?: unknown;
        page_count?: unknown;
      } | null;
      hint.indexedOnHub =
        json?.indexed === true && typeof json.page_count === "number" && json.page_count > 0;
    })(),
  );

  await Promise.allSettled(probes);
  return hint;
}
