import type { SessionSnapshot } from "../api/types";

export interface DatasetLeftover {
  loaded: number;
  passed: number;
  failed: number;
  reveals: number;
}

export function leftoverForDataset(
  session: SessionSnapshot | null | undefined,
  dataset: string,
): DatasetLeftover {
  const out: DatasetLeftover = { loaded: 0, passed: 0, failed: 0, reveals: 0 };
  if (!session) return out;
  const prefix = `${dataset}/`;
  for (const [key, progress] of Object.entries(session.problems)) {
    if (!key.startsWith(prefix)) continue;
    if (progress.state === "loaded") out.loaded += 1;
    else if (progress.state === "passed") out.passed += 1;
    else if (progress.state === "failed") out.failed += 1;
  }
  for (const [key, count] of Object.entries(session.reveals)) {
    if (key.startsWith(prefix)) out.reveals += count;
  }
  return out;
}

export function leftoverAny(left: DatasetLeftover): boolean {
  return left.loaded + left.passed + left.failed + left.reveals > 0;
}
