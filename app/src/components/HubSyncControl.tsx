/**
 * The one-tap hub Sync pill, parked in the board chrome slot.
 *
 * Step-2 stub: tapping walks the stage labels (Index → Pad → Ink → Links →
 * Pull → Synced) so the depth morph and the chrome placement can be judged,
 * but every stage is a no-op — no hub traffic yet. Later steps replace the
 * timer walk with the real Index→Pad→Ink→Links→Pull pipeline.
 */

import { useEffect, useRef, useState } from "react";

import { MorphBar } from "./MorphBar";
import type { DocHubHint } from "../util/hubHint";

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

export interface HubSyncControlProps {
  /**
   * What the hub already had when this document was opened — read-only hint
   * only. When the hub row exists, is not older than local-at-open, and the
   * index is done, idle reads Synced; anything else reads Sync.
   */
  hubHint?: (DocHubHint & { padUpToDate?: boolean }) | null;
}

export function HubSyncControl({ hubHint = null }: HubSyncControlProps) {
  const [stage, setStage] = useState<HubSyncStage>("idle");
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
      setStage(WALK[0]);
      return;
    }
    // Mid-walk taps do nothing; the walk owns itself until it lands.
    if (stage !== "synced") return;
    // A finished walk resets to idle so the next tap runs it again.
    setStage("idle");
  };

  useEffect(() => {
    const at = WALK.indexOf(stage);
    if (at === -1 || at === WALK.length - 1) return;
    timerRef.current = window.setTimeout(() => {
      setStage(WALK[at + 1]);
    }, STAGE_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [stage]);

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
