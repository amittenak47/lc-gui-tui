/**
 * Turning the live board into a {@link BoardSnapshot} for the daemon.
 *
 * This is where the two extractors and the ink recognizer meet. Note what the
 * PNG costs: it is only attached when the caller says the selected model can
 * read images, which on the tablet it usually can't and doesn't need to —
 * that's what ML Kit is for.
 */

import type { BoardSnapshot } from "../api/types";
import type { BoardHandle } from "./BoardHandle";
import {
  baselineFromStructure,
  diffStructure,
  preferDelta,
  type StructureBaseline,
} from "./boardDelta";
import {
  captureStructure,
  captureTypedText,
  captureVersions,
  elementIds,
  sceneHash,
  truncateCaptureId,
} from "./capture";
import { mergeRecognized, type InkRecognizer } from "./ink";
import { sha256Hex } from "../util/codeHash";

export interface Snapshot {
  board: BoardSnapshot;
  sceneHash: number;
  /** Element ids at capture time, for the next tick's stroke delta. */
  ids: Set<string>;
  /**
   * Whether the student wrote anything by hand, regardless of whether the
   * recognizer could read it. Empty `recognized_text` means "unreadable here",
   * not "blank board" — off Android there is no recognizer at all, and the
   * handwriting rides along in the PNG instead.
   */
  hasHandwriting: boolean;
}

export interface SnapshotOptions {
  /** Attach a PNG. Only worth it for a vision-capable model. */
  includePng?: boolean;
  /** Send the stripped scene layout alongside the text. */
  includeStructure?: boolean;
  /** Contents of the pseudocode editor, if the student typed any. */
  pseudocode?: string;
  /** Element ids from the last successful review — for `new_since_last`. */
  previousIds?: ReadonlySet<string>;
  /** How many successful reviews this session (0 = first look). */
  turnIndex?: number;
  /** Server-acknowledged structure baseline — enables `board_ops` on the wire. */
  structureBaseline?: StructureBaseline | null;
  /** SHA-256 hex of the skeleton as it stands now (imports + signature). */
  skeletonHash?: string;
  /** Skeleton hash the server acknowledged — a delta is anchored to this. */
  lastSkeletonHash?: string;
  /** Hash of the pseudocode last sent successfully. */
  lastPseudocodeHash?: string;
}

export async function buildSnapshot(
  board: BoardHandle,
  recognizer: InkRecognizer,
  options: SnapshotOptions = {},
): Promise<Snapshot> {
  const elements = board.getElements();
  const typed = captureTypedText(elements);

  // Both stroke sources, or a pen-only board reads as blank: the pen draws on
  // the raster layer and never produces a `freedraw` element.
  const strokes = [...board.getStrokes(), ...board.getInkStrokes()];

  let handwriting = "";
  try {
    handwriting = await recognizer.recognize(strokes);
  } catch {
    // A recognizer failure must not block a submit; typed text still goes.
    handwriting = "";
  }

  const ids = elementIds(elements);
  const structure = captureStructure(elements);
  const versions = captureVersions(elements);
  const inkOpsLen = board.getInkOpCount();
  const hash = sceneFingerprint(elements, inkOpsLen);

  const snapshot: BoardSnapshot = {
    recognized_text: mergeRecognized(handwriting, typed),
    scene_hash: hash,
    ink_ops_len: inkOpsLen,
  };

  if (options.includeStructure !== false) {
    if (options.structureBaseline) {
      const ops = diffStructure(structure, options.structureBaseline, versions);
      if (preferDelta(ops, structure)) {
        snapshot.board_ops = ops;
      } else {
        snapshot.scene_structure = structure;
      }
    } else {
      snapshot.scene_structure = structure;
    }
  }

  if (options.pseudocode !== undefined) {
    const trimmed = options.pseudocode.trim();
    if (trimmed.length > 0) {
      const hash = await sha256Hex(trimmed);
      // A delta is anchored to the skeleton the server last acknowledged. Edit
      // an import or the signature and that anchor is gone, so the file has to
      // go in full — the server refuses an unanchored delta rather than
      // reviewing the code it still holds.
      const anchored =
        options.lastSkeletonHash === undefined ||
        options.lastSkeletonHash === options.skeletonHash;
      if (options.lastPseudocodeHash && options.lastPseudocodeHash === hash) {
        snapshot.code_mode = "unchanged";
        if (options.skeletonHash) snapshot.skeleton_hash = options.skeletonHash;
      } else if (options.skeletonHash && options.structureBaseline && anchored) {
        snapshot.code_mode = "delta";
        snapshot.pseudocode_delta = trimmed;
        snapshot.skeleton_hash = options.skeletonHash;
      } else {
        snapshot.code_mode = "full";
        snapshot.pseudocode = trimmed;
        if (options.skeletonHash) snapshot.skeleton_hash = options.skeletonHash;
      }
    }
  }
  if (options.includePng) {
    const png = await board.exportPng();
    if (png) snapshot.png = png;
  }
  if (typeof options.turnIndex === "number") {
    snapshot.turn_index = options.turnIndex;
  }
  if (options.previousIds && options.previousIds.size > 0) {
    const added = [...ids].filter((id) => !options.previousIds!.has(id));
    if (added.length > 0) {
      snapshot.new_since_last = added.map(truncateCaptureId);
    }
  }

  return {
    board: snapshot,
    sceneHash: hash,
    ids,
    hasHandwriting: strokes.length > 0,
  };
}

/** Mix element and raster-ink changes into one fingerprint. */
export function sceneFingerprint(
  elements: Parameters<typeof sceneHash>[0],
  inkOpsLen: number,
): number {
  const base = sceneHash(elements);
  if (inkOpsLen === 0) return base;
  return (base ^ (inkOpsLen * 0x9e3779b1)) >>> 0;
}

/** Baseline to store after a successful review ack. */
export function structureBaselineFromBoard(
  elements: Parameters<typeof captureStructure>[0],
): StructureBaseline {
  return baselineFromStructure(captureStructure(elements), captureVersions(elements));
}
