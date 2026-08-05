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
import { readingColumnWidth } from "../templates/readingColumn";
import {
  isReadingColumnFrame,
  syncRegionLayout,
  type LayoutElement,
} from "../templates/regionLayout";

export interface HealBoardLayoutOptions {
  readingSize: BoardReadingSize;
  codeContentHeight?: number;
  /** Board content width in CSS px — sizes the statement's reading column. */
  viewportWidth?: number;
}

export function healBoardLayout<T extends ReadingElement>(
  elements: readonly T[],
  options: HealBoardLayoutOptions,
): T[] {
  /*
   * The column is re-measured *before* the type is set, not after.
   *
   * The reading size is derived from the column's width, so a board saved when
   * the statement was four screens wide would otherwise have its font computed
   * against the old geometry, be re-widthed a moment later by the first camera
   * fit, and land at the wrong size until something forced a reflow.
   */
  const column =
    options.viewportWidth && options.viewportWidth > 0
      ? readingColumnWidth(options.viewportWidth)
      : null;
  const widened =
    column == null
      ? elements
      : (elements.map((element) =>
          isReadingColumnFrame(element as unknown as LayoutElement) &&
          element.width !== column
            ? { ...element, width: column }
            : element,
        ) as readonly T[]);

  const sized = applyBoardReadingSize(widened, options.readingSize, {
    captureFrom: "M",
    viewportWidth: options.viewportWidth,
  }) as T[];
  const synced = syncRegionLayout(sized as LayoutElement[], {
    codeContentHeight: options.codeContentHeight,
    readingColumnWidth: column ?? undefined,
  });
  return (synced ?? sized) as T[];
}
