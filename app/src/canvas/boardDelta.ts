/**
 * Board structure deltas for Phase 3 — diff captured elements against a
 * server-acknowledged baseline and emit add/update/delete ops.
 */

import type { CapturedElement } from "./capture";

export type BoardOp =
  | { op: "add"; element: CapturedElement }
  | { op: "update"; id: string; version: number; element: CapturedElement }
  | { op: "delete"; id: string };

export interface StructureBaseline {
  /** Truncated capture id → element + source version. */
  elements: Map<string, CapturedElement & { version: number }>;
}

/** Build a baseline map from a full captured structure array. */
export function baselineFromStructure(
  structure: readonly CapturedElement[],
  versions: ReadonlyMap<string, number>,
): StructureBaseline {
  const elements = new Map<string, CapturedElement & { version: number }>();
  for (const element of structure) {
    elements.set(element.id, {
      ...element,
      version: versions.get(element.id) ?? 0,
    });
  }
  return { elements };
}

function elementChanged(a: CapturedElement, b: CapturedElement): boolean {
  return (
    a.type !== b.type ||
    a.x !== b.x ||
    a.y !== b.y ||
    a.w !== b.w ||
    a.h !== b.h ||
    a.text !== b.text ||
    a.region !== b.region
  );
}

/**
 * Diff the current structure against a baseline. Returns ops only — the server
 * reconstructs the full layout.
 */
export function diffStructure(
  current: readonly CapturedElement[],
  baseline: StructureBaseline,
  versions: ReadonlyMap<string, number>,
): BoardOp[] {
  const ops: BoardOp[] = [];
  const seen = new Set<string>();

  for (const element of current) {
    seen.add(element.id);
    const prev = baseline.elements.get(element.id);
    const version = versions.get(element.id) ?? 0;
    if (!prev) {
      ops.push({ op: "add", element });
      continue;
    }
    if (elementChanged(prev, element) || prev.version !== version) {
      ops.push({ op: "update", id: element.id, version, element });
    }
  }

  for (const id of baseline.elements.keys()) {
    if (!seen.has(id)) {
      ops.push({ op: "delete", id });
    }
  }

  return ops;
}

/** Whether a delta is smaller than re-sending the full structure. */
export function preferDelta(ops: readonly BoardOp[], structure: readonly CapturedElement[]): boolean {
  if (structure.length === 0) return false;
  if (ops.length === 0) return true;
  const fullBytes = JSON.stringify(structure).length;
  const deltaBytes = JSON.stringify(ops).length;
  return deltaBytes < fullBytes;
}
