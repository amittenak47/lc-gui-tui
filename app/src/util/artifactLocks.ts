/**
 * Local padlock on a catalog row — visual only, never synced.
 *
 * Same job as the library lock: hide trash so a mistap cannot delete. It is
 * not an ownership or hub field; a locked attachment still syncs and restores.
 */

import type { ArtifactParent } from "./padArtifacts";

const KEY = "lc-artifact-locks";

let memory: Record<string, true> = {};
let hydrated = false;

function lockId(parent: ArtifactParent, artifactId: string): string {
  return JSON.stringify([parent.kind, parent.id, artifactId]);
}

function store(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function hydrate(): Record<string, true> {
  if (hydrated) return memory;
  hydrated = true;
  try {
    const raw = store()?.getItem(KEY);
    if (!raw) return memory;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return memory;
    const next: Record<string, true> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === true) next[key] = true;
    }
    memory = next;
  } catch {
    /* keep the in-memory map */
  }
  return memory;
}

function write(next: Record<string, true>): void {
  memory = next;
  hydrated = true;
  const disk = store();
  if (!disk) return;
  try {
    const keys = Object.keys(next);
    if (!keys.length) disk.removeItem(KEY);
    else disk.setItem(KEY, JSON.stringify(next));
  } catch {
    /* visual lock still lives in memory for this session */
  }
}

export function isArtifactLocked(parent: ArtifactParent, artifactId: string): boolean {
  return Boolean(hydrate()[lockId(parent, artifactId)]);
}

export function setArtifactLocked(parent: ArtifactParent, artifactId: string, locked: boolean): void {
  const next = { ...hydrate() };
  const id = lockId(parent, artifactId);
  if (locked) next[id] = true;
  else delete next[id];
  write(next);
}

/** Vitest only. */
export function resetArtifactLocksForTests(): void {
  memory = {};
  hydrated = true;
  try {
    store()?.removeItem(KEY);
  } catch {
    /* jsdom without storage */
  }
}
