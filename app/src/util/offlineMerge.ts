/**
 * Device-local Personalise prefs (not config.toml).
 */

const MERGE_KEY = "lc.offlineMerge.v1";

export type OfflineMergePolicy = "ask" | "prefer-local" | "prefer-server";

export function loadOfflineMergePolicy(): OfflineMergePolicy {
  try {
    const raw = localStorage.getItem(MERGE_KEY);
    if (raw === "ask" || raw === "prefer-local" || raw === "prefer-server") return raw;
  } catch {
    /* ignore */
  }
  return "ask";
}

export function saveOfflineMergePolicy(policy: OfflineMergePolicy): void {
  try {
    localStorage.setItem(MERGE_KEY, policy);
  } catch {
    /* ignore */
  }
}
