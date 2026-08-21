/**
 * Pages two devices both drew on, said out loud.
 *
 * Newest-wins is the right default and the wrong thing to do quietly. Every
 * other rule in pad sync resolves a difference that only one person made; this
 * one can resolve away a page somebody wrote on, on a device they are still
 * holding. The losing copy is recoverable from the snapshot tiers, but only if
 * the reader knows there was something to recover.
 *
 * A store rather than a prop, because the pane that can show a banner is not
 * the pane the conflict happened on — sync runs for the whole library.
 */

import type { InkConflict } from "./inkSync";

const seen = new Map<string, InkConflict>();
const listeners = new Set<() => void>();

function keyOf(row: InkConflict): string {
  return `${row.kind}:${row.key}#${row.pageId}`;
}

export function noteInkConflicts(rows: readonly InkConflict[]): void {
  let changed = false;
  for (const row of rows) {
    const id = keyOf(row);
    if (seen.has(id)) continue;
    seen.set(id, row);
    changed = true;
  }
  if (changed) for (const listener of listeners) listener();
}

export function inkConflictsFor(kind: string, key: string): InkConflict[] {
  const out: InkConflict[] = [];
  for (const row of seen.values()) {
    if (row.kind === kind && row.key === key) out.push(row);
  }
  return out.sort((a, b) => a.pageId - b.pageId);
}

export function clearInkConflicts(kind: string, key: string): void {
  let changed = false;
  for (const [id, row] of seen) {
    if (row.kind !== kind || row.key !== key) continue;
    seen.delete(id);
    changed = true;
  }
  if (changed) for (const listener of listeners) listener();
}

export function subscribeInkConflicts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What the banner says.
 *
 * Names the pages, because "a page" is not something the reader can go and
 * look at. Names the snapshot too — the recovery is real and nobody would
 * guess it exists.
 */
export function inkConflictMessage(rows: readonly InkConflict[]): string | null {
  if (rows.length === 0) return null;
  const pages = rows.map((row) => row.pageId).sort((a, b) => a - b);
  const list =
    pages.length === 1
      ? `page ${pages[0]}`
      : `pages ${pages.slice(0, -1).join(", ")} and ${pages[pages.length - 1]}`;
  return `Another device had also drawn on ${list} since this one last synced — the newer copy is showing. The older one is in this pad's snapshots.`;
}

export function resetInkConflictsForTests(): void {
  seen.clear();
  listeners.clear();
}
