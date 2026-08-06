/**
 * Reconcile a saved board with the current template layout rules.
 *
 * Saved boards can carry stale frame widths and old Excalidraw statement text
 * from older builds. Healing restores today's column width, strips retired
 * statement scaffold text (prose now lives in HTML under the canvas), and
 * syncs region frames — without touching student ink that lacks template
 * `lcRegion` tags.
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

/**
 * Retired Excalidraw statement scaffold — replaced by StatementDocument HTML.
 *
 * Must strip chip *boxes* and the divider rule too, not only the text labels.
 * Older heals left `lcregion-constraints-meta-box-*` rectangles on the canvas:
 * empty outlines stuck over the HTML title while the labels lived in HTML below.
 */
function isRetiredStatementScaffold(element: {
  id?: string;
  customData?: { lcRegionFrame?: boolean } | null;
}): boolean {
  if (element.customData?.lcRegionFrame) return false;
  const id = typeof element.id === "string" ? element.id : "";
  if (id === "lcregion-constraints-frame" || id.endsWith("-frame")) return false;
  return (
    id === "lcregion-constraints-title" ||
    id === "lcregion-constraints-meta-rule" ||
    id.startsWith("lcregion-constraints-meta-") ||
    id.startsWith("lcregion-constraints-body-") ||
    id.startsWith("lcregion-constraints-hint")
  );
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
  const withoutScaffold = elements.filter((element) => !isRetiredStatementScaffold(element));
  const widened =
    column == null
      ? withoutScaffold
      : (withoutScaffold.map((element) =>
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
