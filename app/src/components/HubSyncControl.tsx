/**
 * The one-tap hub Sync pill, parked in the board chrome slot.
 *
 * Step-2 stub: tapping walks the stage labels (Index → Pad → Ink → Links →
 * Pull → Synced) so the depth morph and the chrome placement can be judged,
 * but every stage is a no-op — no hub traffic yet. Later steps replace the
 * timer walk with the real Index→Pad→Ink→Links→Pull pipeline.
 */

import { useEffect, useRef, useState } from "react";

import type { AnnotatePadDto, LcClient, WhiteboardPadDto } from "../api/client";
import type { DocHubHint } from "../util/hubHint";
import {
  type HubConflictResolution,
  type HubPadConflict,
  clearHubConflict,
  stashHubConflict,
} from "../util/hubConflictStash";
import { localInkAsDtos } from "../util/inkSync";
import { PAD_HUB_EVENT, loadPadHub } from "../util/padHub";
import { pushDocBytes } from "../util/padSync";
import type { DocWorkProgress } from "./DocIndexChip";
import {
  snapshotFromPing,
  snapshotHub,
  walkPushPad,
  walkSyncInk,
  walkSyncLinks,
  type HubPadKind,
} from "../util/hubWalk";
import { MorphBar } from "./MorphBar";

/**
 * What the walk is doing, for the tab chip beside the document's name.
 *
 * The pill morphs its own labels and is the thing you tap; this is the
 * progress display next to what it is working on. Index is one stage holding
 * two jobs that skip independently — the hub having the text already says
 * nothing about embeddings — so the label has to follow the job, not the
 * stage word.
 *
 * `null` means nothing is running.
 */
export interface HubWalkReport {
  stage: HubSyncStage;
  /** Which half of Index is running. Absent while neither is. */
  job?: "extract" | "embed" | null;
  /** Counted where there is a count; a sweep everywhere else. */
  progress: DocWorkProgress | null;
  /** The walk parked on this stage. */
  error?: string | null;
  /** The walk is asking the reader to pick a copy, not doing work. */
  waiting?: "conflict";
}

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

/**
 * The pill belongs on a pad you can sync, not on Home / Explore / practice.
 *
 * Home is a workspace too, and it used to portal this control into the shared
 * board-chrome slot — so the library cards wore a Sync button that indexed
 * nothing (no document) and claimed nothing (no pad).
 */
export function tabOffersHubSync(kind: string): boolean {
  return kind === "annotate" || kind === "whiteboard" || kind === "web";
}

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

class WalkAborted extends Error {
  constructor() {
    super("walk aborted");
    this.name = "WalkAborted";
  }
}

/** A stage stopped because both sides changed; nothing was applied. */
class WalkConflict extends Error {
  constructor(
    public readonly stageLabel: "pad" | "ink",
    detail: string,
  ) {
    super(detail);
    this.name = "WalkConflict";
  }
}

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
  /** The open pad's id and kind, or null on boards without a hub pad. */
  pad(): Promise<{
    kind: HubPadKind;
    id: string;
    hubAckUpdatedAt(): number;
    buildBody(): AnnotatePadDto | WhiteboardPadDto | Promise<AnnotatePadDto | WhiteboardPadDto>;
    /** Record the row a successful push left on the hub. */
    markHubAck(updatedAt: number): void;
  } | null>;
  /**
   * H: show the open pad as this walk left it.
   *
   * Ink and pad JSON land in IDB first; this is what puts them on the board
   * that is already on screen. May be async — the walk waits so Pull runs
   * after Ink, not over a reload that started too early.
   */
  emitReload(): void | Promise<void>;
  /** How far back "changed after this" reaches for ink conflicts. */
  inkSince(): number;
  /**
   * A conflict stopped the walk before anything was applied. Show the
   * Local | Server split, let the reader choose, write the choice into this
   * device's stores, then resolve with what was kept — the walk owns every
   * bit of hub traffic that follows.
   */
  onConflict(conflict: HubPadConflict): Promise<HubConflictResolution>;
  onIndexProgress(progress: DocWorkProgress | null): void;
  /** How far the Sync walk has got, for the tab chip. Null when idle (not Synced). */
  onWalkProgress(report: HubWalkReport | null): void;
  onIndexError(message: string | null): void;
  /**
   * The hub holds an index for this document.
   *
   * The walk indexed it, or found it already there. Nothing said so, so a
   * successful walk left the document-index chip reading whatever it read
   * before — usually "not indexed", about a document that now is.
   */
  onIndexDone(): void;
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
  /**
   * Bumped by the workspace every time the open pad is edited.
   *
   * "Synced" is a claim about a moment, and the pill had no way to notice the
   * moment passing: it stayed on Synced while the reader kept writing. This is
   * the smallest thing that can be compared — the value when the walk landed
   * against the value now — and it re-renders, which a ref would not.
   */
  editSeq?: number;
}

export function HubSyncControl({
  hubHint = null,
  client = null,
  host = null,
  editSeq = 0,
}: HubSyncControlProps) {
  /*
   * No hub, no pill.
   *
   * This mounted unconditionally, and every stage of the walk talks to a hub —
   * stage C reached `indexFromBytes`, which had no hub to send to and failed
   * on a null dereference. There is nothing for this control to do on a device
   * that syncs with nothing, so it is not offered.
   *
   * Read as state, not once: a reader who sets a hub in Settings should get
   * the pill without reopening the tab.
   */
  const [hub, setHub] = useState(() => loadPadHub());
  useEffect(() => {
    const onHub = () => setHub(loadPadHub());
    window.addEventListener(PAD_HUB_EVENT, onHub);
    return () => window.removeEventListener(PAD_HUB_EVENT, onHub);
  }, []);
  /** Wired for the real walk. Without both, this is the label-only stub. */
  const wired = Boolean(client && host);

  const [stage, setStage] = useState<HubSyncStage>("idle");
  const [walkError, setWalkError] = useState<string | null>(null);
  const walkingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const walkAbortRef = useRef<AbortController | null>(null);
  /**
   * The stage the walk is on, readable from the progress callbacks.
   *
   * `setStage` is a React update; the extract and embed callbacks fire between
   * renders and need to name the stage they belong to.
   */
  const walkStageRef = useRef<HubSyncStage>("idle");
  const hostRef = useRef(host);
  hostRef.current = host;

  /** Move the pill, and tell the tab what it is now doing. */
  const goStage = (next: HubSyncStage) => {
    if (walkAbortRef.current?.signal.aborted) throw new WalkAborted();
    walkStageRef.current = next;
    setStage(next);
    // Idle (pad-less after Links) clears the tab. Synced is a landing, not a
    // clear — the tab finishes on that word the same way the pill does.
    hostRef.current?.onWalkProgress(
      next === "idle" ? null : { stage: next, progress: null },
    );
  };

  /** Report one job's progress under whatever stage is running. `job: null` clears. */
  const goWork = (job: "extract" | "embed" | null, progress: DocWorkProgress | null) => {
    if (walkAbortRef.current?.signal.aborted) throw new WalkAborted();
    hostRef.current?.onIndexProgress(progress);
    hostRef.current?.onWalkProgress({
      stage: walkStageRef.current,
      job,
      progress,
    });
  };

  /** The edit count "Synced" was true at. Zero is "as this pad opened". */
  const syncedAtSeqRef = useRef(0);
  const editSeqRef = useRef(editSeq);
  editSeqRef.current = editSeq;

  // Clearing on unmount keeps the stub walk from writing state into a dead
  // tree; the real walk aborts so it cannot PUT or raise a conflict after the
  // workspace is gone.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      walkAbortRef.current?.abort();
      // Mid-walk unmount: stop claiming work. A landed Synced stays on the tab.
      const at = walkStageRef.current;
      if (at !== "idle" && at !== "synced") {
        hostRef.current?.onWalkProgress(null);
      }
    };
  }, []);

  useEffect(() => {
    if (walkStageRef.current !== "synced") return;
    if (editSeq === syncedAtSeqRef.current) return;
    walkStageRef.current = "idle";
    hostRef.current?.onWalkProgress(null);
  }, [editSeq]);

  const onTap = () => {
    /*
     * Mid-walk taps do nothing; the walk owns itself until it lands. A parked
     * failure is the exception — that tap is the retry.
     */
    if (busy && !walkError) return;
    // Where to resume. A failure parks on its own stage and retries from it;
    // everything else — idle, and a finished walk — starts at the top.
    const from: HubSyncStage = walkError ? stage : "index";
    setWalkError(null);
    if (client && host) {
      void runWalk(from);
      return;
    }
    // No client wired (tests, or a bare mount): the label walk alone.
    // One tap, including from Synced: a pill that only resets on the first
    // tap and runs on the second is two taps for one thing.
    setStage(WALK[0]);
  };

  /*
   * The real walk. Stages A–D are live: hub check, byte upload when missing,
   * index (hub-side extract from bytes), embed budgets. E–H are still stubs
   * until their steps land; a failure anywhere parks the pill on that stage's
   * label with the error, and the next tap retries from there.
   */
  const runWalk = async (from: HubSyncStage) => {
    if (walkingRef.current) return;
    walkingRef.current = true;
    const abort = new AbortController();
    walkAbortRef.current = abort;
    const throwIfAborted = () => {
      if (abort.signal.aborted) throw new WalkAborted();
    };
    host?.onIndexError(null);
    /*
     * Resume where it stopped.
     *
     * `from` was accepted and ignored: retrying a failure at Pad, Ink or Links
     * re-ran the whole index from the top, which on a book is minutes of work
     * to get back to the stage that actually failed. Stage A is always run —
     * it is both the "is the hub up?" check and the snapshot every later stage
     * compares against, so it is not a stage to skip past.
     */
    const startAt = Math.max(0, WALK.indexOf(from === "idle" ? "index" : from));
    const runs = (stageId: HubSyncStage) => WALK.indexOf(stageId) >= startAt;
    try {
      // — A: is there a hub, and is it up? Both end the walk before any write,
      // and the first has to be answered here — every stage below assumes one,
      // and stage C used to find out the hard way inside `indexFromBytes`.
      goStage("index");
      if (!loadPadHub()) {
        throw new Error("no hub is set — add one in Settings");
      }
      const doc = host?.doc() ?? null;
      /*
       * One ping for the whole walk.
       *
       * This answers "is the hub up?" *and* is the snapshot stages E to H
       * compare against — the same full listing was being fetched twice per
       * tap, once here and once inside `snapshotHub`. One ping is also the
       * more correct of the two: every stage of a walk should be looking at
       * the same world.
       */
      const ping = await client!.pingPadSync(0);
      throwIfAborted();

      if (!runs("index")) {
        // Already done on the attempt that got as far as the failing stage.
        goWork(null, null);
      } else if (!doc || doc.docType === "web") {
        // Whiteboard/home have no document to index; web pads deliberately
        // skip indexing and byte upload for now.
        // TODO(web-index): web pads neither upload bytes nor index yet.
        goWork(null, null);
      } else {
        /*
         * — B: bytes on the hub? If not and we hold them, PUT once.
         *
         * Asked of the hub, every tap. This used to key off the *index* status
         * and an open-time hint, and neither answers the question: a hub that
         * replied `{ indexed: false }` — which is not null — with no hint yet
         * skipped the upload entirely, and then C asked it to extract from
         * bytes it had never been sent. HEAD is a status line, so asking
         * outright is cheaper than the guess was wrong.
         */
        const status = await client!.getDocIndex(doc.hash).catch(() => null);
        let bytesOnHub = await client!.docBytesOnHub(doc.hash);
        if (!bytesOnHub && doc.bytes) {
          await pushBytesOnce(client!, doc.hash, doc.bytes);
          bytesOnHub = true;
        }

        // — C: index. Skip when the hub already has pages.
        //
        // A PDF the hub already holds is extracted *there*, from that copy.
        // Shipping the tablet's page JSON back over the LAN was the textbook
        // that sat on 100% and then died — the file was already on the hub from
        // stage B. EPUB is the leftover: the hub cannot read it from bytes.
        const neededIndex = !(status?.indexed && (status.page_count ?? 0) > 0);
        if (neededIndex) {
          const hubCanExtract =
            doc.docType === "markdown" ||
            doc.docType === "code" ||
            (bytesOnHub && doc.docType === "pdf");
          const extractHere =
            Boolean(doc.bytes) &&
            (doc.docType === "epub" || (doc.docType === "pdf" && !bytesOnHub));
          if (hubCanExtract) {
            goWork("extract", null);
            const result = await client!.indexFromBytes(doc.hash, {
              name: doc.name,
              doc_type: doc.docType,
              source_text: doc.docType === "pdf" ? undefined : doc.text,
            });
            if (!result.indexed) {
              throw new Error("the hub did not keep the index");
            }
          } else if (extractHere) {
            const { extractDocumentPages } = await import("../util/docExtract");
            goWork("extract", { done: 0, total: 0 });
            const pages = await extractDocumentPages({
              docType: doc.docType as "epub" | "pdf" | "markdown" | "code",
              name: doc.name,
              text: doc.text,
              bytes: doc.bytes,
              hash: doc.hash,
              onProgress: (done, total) => goWork("extract", { done, total }),
            });
            goWork("extract", null);
            if (pages.length === 0) {
              throw new Error("no text could be read from this file");
            }
            await client!.putDocIndex(doc.hash, {
              name: doc.name,
              doc_type: doc.docType,
              pages: pages.map((p) => ({ page: p.page, text: p.text, heading: p.heading })),
            });
          } else if (doc.docType === "pdf" && !bytesOnHub) {
            throw new Error(
              "the hub does not have this file yet, and this device no longer holds it — reopen it here, then sync",
            );
          }
        }

        // — D: embed to full, one budget at a time. A missing model, a
        // refused endpoint, or a timeout is a skip — the text index is
        // already on the hub, and parking the whole walk on Index made a
        // textbook look unindexed after the pages were in. Ask stays word-only.
        const fresh = await client!.getDocIndex(doc.hash).catch(() => null);
        if (neededIndex && !(fresh?.indexed && (fresh.page_count ?? 0) > 0)) {
          throw new Error("the hub did not keep the index");
        }
        const embedState = (fresh as (typeof fresh & { embed_state?: string }) | null)
          ?.embed_state;
        if (embedState !== "full" && fresh?.indexed) {
          goWork("embed", { done: fresh.chunks_embedded ?? 0, total: fresh.chunks_total ?? 0 });
          /*
           * TODO(embed-budget): a book can be up to 500 sequential requests.
           *
           * The budget-at-a-time shape is deliberate — it is what lets the
           * reader close the app in the middle of embedding — but the *size*
           * of a budget is the hub's, and one round trip per budget is a lot
           * of them. Fixing it means the hub returning larger budgets or a
           * streaming route, which is a protocol change and not this pass.
           */
          try {
            for (let guard = 0; guard < 500; guard++) {
              const budget = await client!.embedDoc(doc.hash);
              goWork("embed", { done: budget.done, total: budget.total });
              if (budget.reason) break;
              if (budget.total > 0 && budget.done >= budget.total) break;
              if (budget.total === 0) break;
            }
          } catch {
            /* vectors can wait */
          }
          goWork(null, null);
        }
      }
      goWork(null, null);
      if (runs("index") && doc && doc.docType !== "web") host?.onIndexDone();

      /*
       * — E through H, same tap. E and F can stop everything on a conflict:
       * the pill parks until the reader resolves, then the walk resumes
       * where the plan says (F after a pad resolve, G after an ink one).
       */
      const padInfo = client && host ? await host.pad() : null;
      throwIfAborted();
      const snapshot = snapshotFromPing(ping);
      if (padInfo) {
        const walkPad = {
          kind: padInfo.kind,
          id: padInfo.id,
          hubAckUpdatedAt: () => padInfo.hubAckUpdatedAt(),
          buildBody: () => padInfo.buildBody(),
          markHubAck: (updatedAt: number) => padInfo.markHubAck(updatedAt),
        } as const;

        /** The stashed hub row: fetched once at stop time, never re-read. */
        const fetchHubBody = async (): Promise<AnnotatePadDto | WhiteboardPadDto | null> => {
          /*
           * One pad. This used to list the whole annotate or whiteboard
           * library to find the row already named by `padInfo.id`, which on a
           * conflict is the worst possible moment to download everything.
           */
          const got =
            padInfo.kind === "annotate"
              ? await client!.getAnnotatePad(padInfo.id).catch(() => null)
              : await client!.getWhiteboardPad(padInfo.id).catch(() => null);
          return got;
        };

        /**
         * Every page id the hub holds for this pad, from the ping digest.
         *
         * Free — the walk already made that ping — and the honest answer to
         * "what is on the hub" for a resolve that only has to name pages.
         */
        const hubInkPageIds = snapshot.inkDigests
          .filter((row) => row.kind === padInfo.kind && row.key === padInfo.id)
          .map((row) => row.page_id);

        /**
         * Both copies as they stood when the walk stopped.
         *
         * `previewPages` scopes this device's gzip to the pages the split will
         * actually show. An ink stop is about one page, and gzipping a whole
         * read-through textbook to preview it was the most expensive thing the
         * pill did — at the moment it is already parked in front of someone.
         * A pad stop names no page, so it still freezes the lot.
         *
         * The hub GET stays whole: Keep Server and Merge write those bytes,
         * and there is no per-page route to fetch a subset from.
         * TODO(hub): `GET /pads/ink/:kind/:key/:page_id`, then fetch the set
         * the chosen resolution needs instead of the pad.
         */
        const freezeCopies = async (previewPages?: readonly number[]) => {
          const [server, localInk, serverInk, local] = await Promise.all([
            fetchHubBody(),
            localInkAsDtos(padInfo.kind, padInfo.id, previewPages).catch(() => []),
            (async () => {
              try {
                return await client!.getInkPages(padInfo.kind, padInfo.id);
              } catch {
                // Failed download, not an empty pad — see HubPadConflict.serverInk.
                return null;
              }
            })(),
            Promise.resolve(padInfo.buildBody()),
          ]);
          return { server, localInk, serverInk, local, hubInkPageIds };
        };

        /* Park on the split; resolve when the reader has chosen and the
         * choice is written into this device's stores. */
        const raiseConflict = (
          conflict: HubPadConflict,
        ): Promise<HubConflictResolution> => {
          if (abort.signal.aborted) return Promise.reject(new WalkAborted());
          stashHubConflict(conflict);
          hostRef.current?.onWalkProgress({
            stage: walkStageRef.current,
            progress: null,
            waiting: "conflict",
          });
          return new Promise<HubConflictResolution>((resolve, reject) => {
            const onAbort = () => reject(new WalkAborted());
            abort.signal.addEventListener("abort", onAbort, { once: true });
            host!
              .onConflict(conflict)
              .then((resolution) => {
                abort.signal.removeEventListener("abort", onAbort);
                if (abort.signal.aborted) {
                  reject(new WalkAborted());
                  return;
                }
                resolve(resolution ?? { pick: "local" });
              }, (cause) => {
                abort.signal.removeEventListener("abort", onAbort);
                reject(cause);
              });
          }).finally(() => {
            clearHubConflict();
            if (abort.signal.aborted) return;
            hostRef.current?.onWalkProgress({
              stage: walkStageRef.current,
              progress: null,
            });
          });
        };

        // — E: push this pad's JSON (CAS). Conflict → stop before any apply.
        let inkSettled = false;
        if (runs("pad")) {
          goStage("pad");
          const pushed = await walkPushPad(client!, walkPad, snapshot);
          throwIfAborted();
          if (pushed.outcome === "conflict") {
            const copies = await freezeCopies();
            throwIfAborted();
            const resolution = await raiseConflict({
              kind: padInfo.kind,
              id: padInfo.id,
              stage: "pad",
              detail: pushed.detail,
              local: copies.local,
              server: copies.server,
              localInk: copies.localInk,
              serverInk: copies.serverInk,
              hubInkPageIds: copies.hubInkPageIds,
            });
            // Workspace already wrote pad JSON + the chosen ink.
            inkSettled = true;
            if (resolution.pick !== "server") {
              // Local / merged: this device's copy won, so the hub gets it.
              // The ack now names the row the hub actually holds, so CAS passes.
              goStage("pad");
              const fresh = await host!.pad();
              if (!fresh) throw new Error("this pad closed while resolving the conflict");
              // Deliberately a fresh read: the hub moved, that is why we are here.
              const freshSnapshot = await snapshotHub(client!);
              const repush = await walkPushPad(
                client!,
                {
                  ...walkPad,
                  hubAckUpdatedAt: () => fresh.hubAckUpdatedAt(),
                  buildBody: fresh.buildBody,
                  markHubAck: (updatedAt: number) => fresh.markHubAck(updatedAt),
                },
                freshSnapshot,
              );
              if (repush.outcome === "conflict") {
                throw new WalkConflict("pad", repush.detail);
              }
            }
          }
        }

        // — F: handwriting for this pad only. Skipped when the pad split
        // already settled ink — newest-wins here would throw away Keep Local.
        if (runs("ink") && !inkSettled) {
          goStage("ink");
          const ink = await walkSyncInk(client!, walkPad, snapshot, host!.inkSince());
          if (ink.outcome === "conflict") {
            // The walk already named the page both sides drew on.
            const copies = await freezeCopies([ink.pageId]);
            await raiseConflict({
              kind: padInfo.kind,
              id: padInfo.id,
              stage: "ink",
              detail: `page ${ink.pageId} has new strokes here and on the hub`,
              local: copies.local,
              server: copies.server,
              localInk: copies.localInk,
              serverInk: copies.serverInk,
              hubInkPageIds: copies.hubInkPageIds,
              inkPageId: ink.pageId,
            });
          }
        }
      }

      /*
       * — G: links union cleanly; snapshots only fill gaps.
       *
       * Outside the pad block on purpose. E, F and H are about one row — this
       * pad's JSON, this pad's ink pages, this pad's reload — but note links
       * are the device's: `syncEdges` walks every edge here and every edge the
       * hub reported, whichever document happens to be open. A reader who has
       * not saved this one still has links worth exchanging.
       */
      if (runs("links")) {
        goStage("links");
        await walkSyncLinks(client!, snapshot);
      }

      /*
       * No library row, so nothing pad-related happened.
       *
       * A document opened to read does not mint a pad — the row appears on the
       * first save — so E, F and H had nothing to send and were skipped. Index
       * and Links really did run, and `onIndexDone` has already said so. But
       * "Synced" is a claim about a pad row on the hub, and there is no row, so
       * the pill goes back to plain Sync rather than saying something true of
       * nothing.
       */
      if (!padInfo) {
        goStage("idle");
        walkingRef.current = false;
        return;
      }

      goStage("pull");
      // Always. Pull used to fire only when the pad *row* was newer than the
      // ack, which skipped the common case: the tablet sent ink, the walk
      // wrote those pages into IDB, and the open PDF kept showing yesterday's
      // strokes until someone closed and reopened the file.
      try {
        await host?.emitReload();
      } catch {
        // The stores already hold the walk. A failed remount must not park
        // the pill on Pull after a sync that actually landed.
      }
      syncedAtSeqRef.current = editSeqRef.current;
      goStage("synced");
      walkingRef.current = false;
    } catch (cause) {
      walkingRef.current = false;
      if (cause instanceof WalkAborted) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setWalkError(message);
      // Stay parked on the failing stage; the next tap retries from it. The
      // tab says the real reason, beside the document it happened to.
      hostRef.current?.onIndexError(message);
      hostRef.current?.onWalkProgress({
        stage: walkStageRef.current,
        progress: null,
        error: message,
      });
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

  if (wired && !hub) return null;

  const busy = stage !== "idle" && stage !== "synced";
  /*
   * Synced, until the reader writes something.
   *
   * Both kinds of Synced go stale the same way — the one a finished walk left
   * behind, and the one the open-time hint reads at rest — and neither noticed.
   * The pill sat on "Synced" over a pad with unsynced marks on it.
   */
  const editedSinceSynced = editSeq !== syncedAtSeqRef.current;

  // Idle label per the open policy: Synced needs pad + index on the hub and
  // no newer local ink than the hub knows about at open time.
  const syncedAtRest =
    stage === "idle" &&
    !editedSinceSynced &&
    hubHint != null &&
    hubHint.padUpdatedAt != null &&
    hubHint.padUpToDate !== false &&
    hubHint.indexedOnHub;
  const restStage: HubSyncStage = syncedAtRest ? "synced" : "idle";
  const settled = stage === "synced" && !editedSinceSynced ? "synced" : restStage;
  const activeStage = busy ? stage : settled;

  return (
    <span className="lc-hub-sync-dock">
      <button
        type="button"
        className="lc-hub-sync lc-tip-target"
        onClick={onTap}
        aria-label={busy ? `Hub sync: ${LABEL[stage]}` : "Hub sync"}
        data-stage={busy ? stage : activeStage}
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
