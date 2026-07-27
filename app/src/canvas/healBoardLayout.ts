/**
 * Reconcile a saved board with the current template layout rules.
 *
 * Saved boards can carry stale frame widths and body fonts from older builds.
 * Healing re-applies S/M/L to statement bodies, restores fixed chrome, and
 * syncs region frames to today's column width and stacking — without touching
 * student ink that lacks template `lcRegion` tags.
 */

import { applyBoardReadingSize, type ReadingElement } from "../modes/applyBoardReadingSize";
import type { BoardReadingSize } from "../modes/codeFontSize";
import { syncRegionLayout, type LayoutElement } from "../templates/regionLayout";

export interface HealBoardLayoutOptions {
  readingSize: BoardReadingSize;
  codeContentHeight?: number;
}

export function healBoardLayout<T extends ReadingElement>(
  elements: readonly T[],
  options: HealBoardLayoutOptions,
): T[] {
  const sized = applyBoardReadingSize(elements, options.readingSize, {
    captureFrom: "M",
  }) as T[];
  const synced = syncRegionLayout(sized as LayoutElement[], {
    codeContentHeight: options.codeContentHeight,
  });
  return (synced ?? sized) as T[];
}
