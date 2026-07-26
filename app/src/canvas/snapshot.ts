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
import { captureStructure, captureTypedText, elementIds, sceneHash } from "./capture";
import { mergeRecognized, type InkRecognizer } from "./ink";

export interface Snapshot {
  board: BoardSnapshot;
  sceneHash: number;
  /** Element ids at capture time, for the next tick's stroke delta. */
  ids: Set<string>;
}

export interface SnapshotOptions {
  /** Attach a PNG. Only worth it for a vision-capable model. */
  includePng?: boolean;
  /** Send the stripped scene layout alongside the text. */
  includeStructure?: boolean;
  /** Contents of the pseudocode editor, if the student typed any. */
  pseudocode?: string;
}

export async function buildSnapshot(
  board: BoardHandle,
  recognizer: InkRecognizer,
  options: SnapshotOptions = {},
): Promise<Snapshot> {
  const elements = board.getElements();
  const typed = captureTypedText(elements);

  let handwriting = "";
  try {
    handwriting = await recognizer.recognize(board.getStrokes());
  } catch {
    // A recognizer failure must not block a submit; typed text still goes.
    handwriting = "";
  }

  const snapshot: BoardSnapshot = {
    recognized_text: mergeRecognized(handwriting, typed),
  };
  if (options.includeStructure !== false) {
    snapshot.scene_structure = captureStructure(elements);
  }
  if (options.pseudocode && options.pseudocode.trim().length > 0) {
    snapshot.pseudocode = options.pseudocode;
  }
  if (options.includePng) {
    const png = await board.exportPng();
    if (png) snapshot.png = png;
  }

  return {
    board: snapshot,
    sceneHash: sceneHash(elements),
    ids: elementIds(elements),
  };
}
