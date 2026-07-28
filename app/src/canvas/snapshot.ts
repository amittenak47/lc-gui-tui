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
  captureStructure,
  captureTypedText,
  elementIds,
  sceneHash,
  truncateCaptureId,
} from "./capture";
import { mergeRecognized, type InkRecognizer } from "./ink";

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
    sceneHash: sceneHash(elements),
    ids,
    hasHandwriting: strokes.length > 0,
  };
}
