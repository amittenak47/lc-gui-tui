/**
 * `dataset/task_id` — the key the daemon uses for per-problem state.
 *
 * Session progress, the session queue, and the reveal counter are all keyed
 * this way, because the same slug exists in several problem sets: `two-sum` is
 * in three of them, and a `failed` badge earned in one must not appear on the
 * others.
 */

import { DEFAULT_DATASET } from "../api/types";

export function problemKey(dataset: string, taskId: string): string {
  return `${dataset || DEFAULT_DATASET}/${taskId}`;
}

/**
 * Split a key back apart.
 *
 * A key with no slash is a pre-datasets record, which could only have come
 * from the original corpus. Task ids may themselves contain slashes, so only
 * the first one separates.
 */
export function splitProblemKey(key: string): [dataset: string, taskId: string] {
  const slash = key.indexOf("/");
  if (slash <= 0) return [DEFAULT_DATASET, key];
  return [key.slice(0, slash), key.slice(slash + 1)];
}
