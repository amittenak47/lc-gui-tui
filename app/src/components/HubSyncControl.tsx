/**
 * The one-tap hub Sync pill, parked in the board chrome slot.
 *
 * Step-2 stub: tapping walks the stage labels (Index → Pad → Ink → Links →
 * Pull → Synced) so the depth morph and the chrome placement can be judged,
 * but every stage is a no-op — no hub traffic yet. Later steps replace the
 * timer walk with the real Index→Pad→Ink→Links→Pull pipeline.
 */

import { useEffect, useRef, useState } from "react";

import type { LcClient } from "../api/client";
import type { DocHubHint } from "../util/hubHint";
import type { DocWorkProgress } from "./DocIndexChip";
import { pushDocBytes } from "../util/padSync";
import { MorphBar } from "./MorphBar";

export type HubSyncStage =
  | "idle"
  | "index"
  | "pad"
  | "ink"
  | "links"
  | "pull"
  | "synced";

/** Walk order after a tap; `idle` sits outside it. */
const WALK: HubSyncStage[] = ["index", "pad", "ink", "links", "pull", "synced"];

const LABEL: Record<HubSyncStage, string> = {
  idle: "Sync",
  index: "Index",
  pad: "Pad",
  ink: "Ink",
  links: "Links",
  pull: "Pull",
  synced: "Synced",
};

/** How long each stub stage holds before the label advances. */
const STAGE_MS = 650;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * PUT the document bytes exactly once per walk.
 *
 * `pushDocBytes` already queues on failure, so an unreachable hub costs one
 * queued job, never a retry storm.
 */
async function pushBytesOnce(client: LcClient, hash: string, bytes: ArrayBuffer): Promise<void> {
  await pushDocBytes(client, hash, bytes);
}

/**
 * What the walk needs to reach the world outside the pill.
 *
 * `doc` is a read-only snapshot of what is open (null on whiteboards and
 * home): hash, name, kind, and the text/bytes an index or byte upload would
 * need. The callbacks surface Index-stage work on the chip, which stays idle
 * unless the walk reports.
 */
export interface HubSyncWalkHost {
  doc(): {
    hash: string;
    name: string;
    docType: string;
    text: string;
    bytes: ArrayBuffer | null;
  } | null;
  onIndexProgress(progress: DocWorkProgress | null): void;
  onIndexError(message: string | null): void;
}

export interface HubSyncControlProps {
  /**
   * What the hub already had when this document was opened — read-only hint
   * only. When the hub row exists, is not older than local-at-open, and the
   * index is done, idle reads Synced; anything else reads Sync.
   */
  hubHint?: (DocHubHint & { padUpToDate?: boolean }) | null;
  /** Present only when there is something to sync with; gates the real walk. */
  client?: LcClient | null;
  host?: HubSyncWalkHost | null;
}

export function HubSyncControl({ hubHint = null, client = null, host = null }: HubSyncControlProps) {
  const [stage, setStage] = useState<HubSyncStage>("idle");
  const [walkError, setWalkError] = useState<string | null>(null);
  const walkingRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  // Clearing on unmount keeps the stub walk from writing state into a dead
  // tree; the real walk will own its own teardown per stage.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const onTap = () => {
    if (stage === "idle") {
      setWalkError(null);
      if (client && host) {
        void runWalk("index");
        return;
      }
      // No client wired (tests, or a bare mount): the label walk alone.
      setStage(WALK[0]);
      return;
    }
    // Mid-walk taps do nothing; the walk owns itself until it lands.
    if (walkError && client && host) {
      // Parked on a failed stage: this tap retries from there.
      setWalkError(null);
      void runWalk(stage);
      return;
    }
    if (stage !== "synced") return;
    // A finished walk resets to idle so the next tap runs it again.
    setStage("idle");
  };

  /*
   * The real walk. Stages A–D are live: hub check, byte upload when missing,
   * index (hub-side extract from bytes), embed budgets. E–H are still stubs
   * until their steps land; a failure anywhere parks the pill on that stage's
   * label with the error, and the next tap retries from there.
   */
  const runWalk = async (_from: HubSyncStage) => {
    if (walkingRef.current) return;
    walkingRef.current = true;
    host?.onIndexError(null);
    try {
      // — A: is the hub even up? A dead hub ends the walk before any write.
      setStage("index");
      const doc = host?.doc() ?? null;
      await client!.pingPadSync(0);

      if (!doc || doc.docType === "web") {
        // Whiteboard/home have no document to index; web pads deliberately
        // skip indexing and byte upload for now.
        // TODO(web-index): web pads neither upload bytes nor index yet.
        host?.onIndexProgress(null);
      } else {
        // — B: bytes on the hub? If not and we hold them, PUT once.
        const status = await client!.getDocIndex(doc.hash).catch(() => null);
        const hintSaysMissing = hubHint != null && !hubHint.bytesOnHub;
        if ((hintSaysMissing || status === null) && doc.bytes) {
          await pushBytesOnce(client!, doc.hash, doc.bytes);
        }

        // — C: index. Skip when the hub already has pages; otherwise ask the
        // hub to extract from its own copy of the bytes. EPUB is the one kind
        // the hub cannot read from bytes: its parsing is plain zip + HTML
        // (no pdf.js worker), so it extracts here at tap time, never on open.
        if (!(status?.indexed && (status.page_count ?? 0) > 0)) {
          if (doc.docType === "epub") {
            const { extractDocumentPages } = await import("../util/docExtract");
            host?.onIndexProgress({ done: 0, total: 0 });
            const pages = await extractDocumentPages({
              docType: "epub",
              name: doc.name,
              text: doc.text,
              bytes: doc.bytes,
              hash: doc.hash,
              onProgress: (done, total) => host?.onIndexProgress({ done, total }),
            });
            host?.onIndexProgress(null);
            if (pages.length === 0) {
              throw new Error("no text could be read from this file");
            }
            await client!.putDocIndex(doc.hash, {
              name: doc.name,
              doc_type: doc.docType,
              pages: pages.map((p) => ({ page: p.page, text: p.text, heading: p.heading })),
            });
          } else if (doc.docType === "pdf" || doc.docType === "markdown" || doc.docType === "code") {
            const result = await client!.indexFromBytes(doc.hash, {
              name: doc.name,
              doc_type: doc.docType,
              source_text:
                doc.docType === "pdf" ? undefined : doc.text,
            });
            if (!result.indexed) {
              throw new Error("the harness did not keep the index");
            }
          }
          // Any other kind has nothing to do here.
        }

        // — D: embed to full, one budget at a time. No model configured reads
        // as a skip, not a failure — Ask just stays word-only.
        const fresh = await client!.getDocIndex(doc.hash).catch(() => null);
        const embedState = (fresh as (typeof fresh & { embed_state?: string }) | null)
          ?.embed_state;
        if (embedState !== "full" && fresh?.indexed) {
          host?.onIndexProgress({ done: fresh.chunks_embedded ?? 0, total: fresh.chunks_total ?? 0 });
          for (let guard = 0; guard < 500; guard++) {
            const budget = await client!.embedDoc(doc.hash);
            host?.onIndexProgress({ done: budget.done, total: budget.total });
            if (budget.reason) {
              // A refused/absent model is a skip; anything else is real.
              if (/model/i.test(budget.reason)) break;
              throw new Error(budget.reason);
            }
            if (budget.total > 0 && budget.done >= budget.total) break;
            if (budget.total === 0) break;
          }
          host?.onIndexProgress(null);
        }
      }
      host?.onIndexProgress(null);

      // — E–H land with their own steps; walk the labels so one tap keeps
      // meaning "the whole thing".
      setStage("pad");
      for (const next of ["ink", "links", "pull", "synced"] as HubSyncStage[]) {
        await wait(STAGE_MS);
        setStage(next);
      }
      walkingRef.current = false;
    } catch (cause) {
      walkingRef.current = false;
      const message = cause instanceof Error ? cause.message : String(cause);
      setWalkError(message);
      // Stay parked on the failing stage; the next tap retries from it.
    }
  };

  useEffect(() => {
    // Stub mode only (tests / bare mount). With a client wired, the real
    // walk drives the labels — a background timer would drag a parked
    // stage forward past its own failure.
    if (client && host) return;
    const at = WALK.indexOf(stage);
    if (at === -1 || at === WALK.length - 1) return;
    timerRef.current = window.setTimeout(() => {
      setStage(WALK[at + 1]);
    }, STAGE_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [stage, client, host]);

  const busy = stage !== "idle" && stage !== "synced";

  // Idle label per the open policy: Synced needs pad + index on the hub and
  // no newer local ink than the hub knows about at open time.
  const syncedAtRest =
    stage === "idle" &&
    hubHint != null &&
    hubHint.padUpdatedAt != null &&
    hubHint.padUpToDate !== false &&
    hubHint.indexedOnHub;
  const restStage: HubSyncStage = syncedAtRest ? "synced" : "idle";
  const activeStage = busy || stage === "synced" ? stage : restStage;

  return (
    <span className="lc-hub-sync-dock">
      <button
        type="button"
        className="lc-hub-sync lc-tip-target"
        onClick={onTap}
        aria-label={busy ? `Hub sync: ${LABEL[stage]}` : "Hub sync"}
        data-stage={stage}
        data-error={walkError ?? undefined}
        title={walkError ?? undefined}
      >
        <MorphBar
          axis="depth"
          active={activeStage}
          className="lc-hub-sync-morph"
          animateOnMount={false}
        >
          {(Object.keys(LABEL) as HubSyncStage[]).map((id) => (
            <span key={id} data-morph-id={id}>
              {LABEL[id]}
            </span>
          ))}
        </MorphBar>
      </button>
    </span>
  );
}
