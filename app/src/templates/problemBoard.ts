/**
 * The layout the board pre-seeds when a problem is picked.
 *
 * The statement is reference material you read for twenty minutes while
 * sketching, so it is set like the problems page: a normal sans for prose, a
 * monospace face for anything with brackets or subscripts, and no hand-drawn
 * font anywhere. Region scaffolding is locked and tagged with `lcRegion` so the
 * coach can tell "nothing written under Complexity" from "there is no
 * Complexity section".
 *
 * **The scaffolding is not drawn.** Region frames used to be dashed boxes with
 * a label and a hint inside them, and every one of them was a lie about what
 * the surface is: you cannot see a page's own edge from inside the page, the
 * neighbouring boxes leaked in around the fitted one, and re-inking them on a
 * theme change un-hid the boxes paging had just hidden. The frames still exist —
 * they are what the camera fits, what the pan clamp bounds, what the ink is
 * clipped to, and what the agent's capture boxes are measured inside — but they
 * have no stroke, and the label/hint text they carried is gone with them.
 */

import { REGIONS, type RegionId } from "./regions";
import {
  readingColumnWidth,
  regionTextInset,
  regionTextWidth,
  STATEMENT_CODE_BASE,
  STATEMENT_PROSE_BASE,
} from "./readingColumn";
import { FONT_CODE, FONT_UI, templatePalette, type Skeleton } from "./skeleton";

export interface ProblemTemplateInput {
  taskId: string;
  title: string;
  difficulty?: string | null;
  tags?: string[];
  /** From `problem_description`. */
  description?: string | null;
  caseCount?: number;
  /** Dark board themes need light statement ink. */
  dark?: boolean;
  /**
   * Board content width in CSS pixels, for sizing the statement's reading
   * column. Falls back to the column ceiling when the caller has no viewport
   * yet (tests, server-side).
   */
  viewportWidth?: number;
  /**
   * Optional AI (or caller) overrides for empty-region prompts.
   *
   * Retained so the scaffold round-trip keeps working, but nothing is drawn
   * from it any more: region hints were template-box text, and template boxes
   * are not displayed.
   */
  scaffolding?: {
    approach?: string;
    complexity?: string;
    walkthrough?: string;
  };
}

/** One block of statement text, and how it should be set. */
export interface StatementBlock {
  text: string;
  /** Monospace for anything with array literals, indices, or comparisons. */
  code: boolean;
}

/**
 * What counts as a code-ish line (outside markdown fences).
 *
 * Structural markers only — brackets, comparison operators, and the corpus's
 * `Input:`/`Output:` prefixes. Matching bare variable names like `nums` or
 * `mat` was too eager: "Given an m x n binary matrix mat, return…" is prose
 * that happens to name a variable, and setting it in monospace made the
 * statement *less* readable, not more.
 */
const CODE_LINE = /^(Input|Output|Explanation):|[[\]]|<=|>=|==|!=|\w+\[\w*\]/;

/** Opening or closing markdown fence: ``` or ```python */
const FENCE_LINE = /^\s*```[\w+-]*\s*$/;

/**
 * Split a statement into prose and code-ish blocks.
 *
 * The corpus stores statements as plain text where examples and constraints are
 * already visually distinct — `Input: mat = [[0,0,0],...]`, `1 <= m, n <= 104`.
 * Setting those in a proportional font is what made the first pass hard to read,
 * so they get the monospace face while the surrounding prose does not.
 *
 * Markdown fences (` ``` ` / ` ```python `) are recognized too: fence markers are
 * dropped and the enclosed lines are always monospace (KodCode doctest examples
 * arrive this way).
 */
export function parseStatement(
  description: string | null | undefined,
  maxLines = 40,
): StatementBlock[] {
  if (!description || description.trim().length === 0) {
    return [{ text: "(no description in the corpus)", code: false }];
  }

  const lines = description
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line, index, all) => line.trim().length > 0 || all[index - 1]?.trim().length > 0);

  const blocks: StatementBlock[] = [];
  let inFence = false;
  let emitted = 0;

  for (const line of lines) {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (emitted >= maxLines) break;

    const isCode =
      inFence || CODE_LINE.test(line) || /^\s*>>> /.test(line) || /^\s*\.\.\. /.test(line);
    // Soft-strip a leading markdown heading marker so `# Title` reads as Title.
    const display = !isCode ? line.replace(/^\s{0,3}#{1,6}\s+/, "") : line;

    const last = blocks[blocks.length - 1];
    if (last && last.code === isCode) {
      last.text += `\n${display}`;
    } else {
      blocks.push({ text: display, code: isCode });
    }
    emitted += 1;
  }

  if (blocks.length === 0) {
    return [{ text: "(no description in the corpus)", code: false }];
  }
  return blocks.map((block) => ({ ...block, text: block.text.trim() }));
}

/** Scene units of blank page above the statement's first line. */
const STATEMENT_TOP_PAD = 28;

export function buildProblemTemplate(input: ProblemTemplateInput): Skeleton[] {
  const skeletons: Skeleton[] = [];
  const ink = templatePalette(Boolean(input.dark));

  /*
   * The statement is set in its own column, not in the student column.
   *
   * Everything else on the board is a wide desk you write on; this one page is
   * a document you read. Sizing it to the viewport is what makes the width-only
   * fit land near zoom 1, which is what makes an 18-unit body come out as
   * 18-ish CSS pixels instead of the 3.6 it came out as when the page was four
   * screens wide.
   */
  const columnWidth = readingColumnWidth(
    typeof input.viewportWidth === "number" ? input.viewportWidth : Number.NaN,
  );
  const columnInset = regionTextInset(columnWidth);
  const columnText = regionTextWidth(columnWidth);

  const at = (region: { id: RegionId; x: number; y: number }, x: number, y: number, extra: Record<string, unknown> = {}) => ({
    lcRegion: region.id,
    lcRegionOx: x - region.x,
    lcRegionOy: y - region.y,
    ...extra,
  });

  for (const region of Object.values(REGIONS)) {
    const isStatement = region.id === "constraints";
    skeletons.push({
      id: `lcregion-${region.id}-frame`,
      type: "rectangle",
      x: region.x,
      y: region.y,
      width: isStatement ? columnWidth : region.w,
      height: region.h,
      /*
       * Invisible, and locked so it cannot be selected.
       *
       * A dashed border around the page you are writing on is a box the page
       * is inside of, and the page is the whole screen — so the border was
       * never a boundary the writer could learn anything from, only chrome
       * that leaked in from the neighbouring pages. Locking it additionally
       * keeps Excalidraw from painting marching ants around a document-tall
       * rectangle on every scroll frame.
       */
      strokeColor: "transparent",
      backgroundColor: "transparent",
      strokeStyle: "solid",
      strokeWidth: 0,
      roughness: 0,
      opacity: 0,
      locked: true,
      angle: 0,
      customData: {
        lcRegion: region.id,
        lcRegionFrame: true,
        /*
         * The statement reads like a document, so it is fitted like one.
         *
         * Constraints is a wall of prose and examples that only ever gets read
         * top to bottom. Fitting it on both axes shrinks the whole wall to the
         * screen and makes it a picture of text rather than text; fitting the
         * width lands it at the size the reading control names and leaves the
         * rest to the scroll — the same treatment the markdown page gets, for
         * the same reason.
         */
        ...(isStatement ? { lcDocumentPage: true, lcReadingColumn: true } : {}),
      },
    });
  }

  const constraints = REGIONS.constraints;
  const textLeft = constraints.x + columnInset;

  const titleFont = Math.round(STATEMENT_PROSE_BASE * 1.75);
  const titleY = constraints.y + STATEMENT_TOP_PAD;
  skeletons.push({
    id: "lcregion-constraints-title",
    type: "text",
    x: textLeft,
    y: titleY,
    width: columnText,
    text: input.title,
    fontSize: titleFont,
    fontFamily: FONT_UI,
    strokeColor: ink.primary,
    locked: true,
    customData: {
      ...at(constraints, textLeft, titleY),
      lcFontBase: titleFont,
      lcFixedSize: true,
    },
  });

  const metaParts = [
    input.difficulty?.trim() || null,
    ...(input.tags ?? []).slice(0, 5).map((tag) => tag.trim()).filter(Boolean),
    typeof input.caseCount === "number" && input.caseCount > 0
      ? `${input.caseCount} sample cases`
      : null,
  ].filter((part): part is string => Boolean(part && part.length > 0));

  let bodyY = titleY + Math.round(titleFont * 1.6);
  if (metaParts.length > 0) {
    const metaFont = Math.round(STATEMENT_PROSE_BASE * 0.78);
    const padX = 8;
    const padY = 5;
    const gap = 8;
    const boxH = metaFont + padY * 2 + 4;
    let chipX = textLeft;
    let chipY = titleY + Math.round(titleFont * 1.55);
    const rowLeft = textLeft;
    const rowRight = rowLeft + columnText;

    metaParts.forEach((part, index) => {
      const textW = Math.max(48, Math.ceil(part.length * metaFont * 0.56));
      const boxW = textW + padX * 2;
      if (index > 0 && chipX + boxW > rowRight) {
        chipX = rowLeft;
        chipY += boxH + gap;
      }
      const textX = chipX + padX;
      const textY = chipY + padY;

      skeletons.push({
        id: `lcregion-constraints-meta-box-${index}`,
        type: "rectangle",
        x: chipX,
        y: chipY,
        width: boxW,
        height: boxH,
        strokeColor: ink.border,
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeStyle: "solid",
        strokeWidth: 1.5,
        roughness: 0,
        roundness: { type: 3 },
        locked: true,
        customData: { ...at(constraints, chipX, chipY), lcFixedSize: true },
      });

      skeletons.push({
        id: `lcregion-constraints-meta-${index}`,
        type: "text",
        x: textX,
        y: textY,
        width: textW,
        text: part,
        fontSize: metaFont,
        fontFamily: FONT_UI,
        strokeColor: ink.hint,
        locked: true,
        customData: {
          ...at(constraints, textX, textY),
          lcFixedSize: true,
          lcFontBase: metaFont,
        },
      });

      chipX += boxW + gap;
    });

    const chipsBottom = chipY + boxH;
    const ruleY = chipsBottom + 14;
    const ruleX = rowLeft;
    skeletons.push({
      id: "lcregion-constraints-meta-rule",
      type: "line",
      x: ruleX,
      y: ruleY,
      width: columnText,
      height: 0,
      points: [
        [0, 0],
        [columnText, 0],
      ],
      strokeColor: ink.border,
      strokeWidth: 1.5,
      strokeStyle: "solid",
      roughness: 0,
      locked: true,
      customData: { ...at(constraints, ruleX, ruleY), lcFixedSize: true },
    });
    bodyY = ruleY + 20;
  }

  // Statement body, block by block, so examples keep the monospace face.
  let y = bodyY;
  parseStatement(input.description, 48).forEach((block, index) => {
    const fontSize = block.code ? STATEMENT_CODE_BASE : STATEMENT_PROSE_BASE;
    const lineHeight = Math.round(fontSize * (block.code ? 1.42 : 1.43) * 10) / 10;
    const x = textLeft;
    skeletons.push({
      id: `lcregion-constraints-body-${index}`,
      type: "text",
      x,
      y,
      width: columnText,
      text: block.text,
      fontSize,
      fontFamily: block.code ? FONT_CODE : FONT_UI,
      lineHeight: lineHeight / fontSize,
      strokeColor: block.code ? ink.primary : ink.body,
      locked: true,
      customData: {
        ...at(constraints, x, y),
        lcFontBase: fontSize,
        lcLineHeightBase: lineHeight / fontSize,
        lcRegionOyBase: y - constraints.y,
      },
    });
    y += block.text.split("\n").length * lineHeight + 14;
  });

  return skeletons;
}

/** Ids the template owns, kept for tests and debugging. */
export function isTemplateElementId(id: string): boolean {
  return id.startsWith("lcregion-");
}

/**
 * Recolor scaffold text/frames for the current board brightness without wiping
 * student strokes. Theme switches call this so light boards never keep dark-mode
 * ink (and vice versa).
 *
 * Prefer stable `lcregion-*` ids for role (title / hint / body). Also accept
 * `customData.lcRegion` so boards that lost those ids during conversion still
 * flip to readable dark-mode ink.
 */
export function recolorTemplateElements<
  T extends {
    id: string;
    type: string;
    strokeColor?: string;
    strokeWidth?: number;
    fontFamily?: number;
    fontSize?: number;
    opacity?: number;
    customData?: {
      lcRegion?: string;
      lcRegionFrame?: boolean;
      lcVizId?: string;
    } | null;
  },
>(elements: readonly T[], dark: boolean): T[] | null {
  const ink = templatePalette(dark);
  let changed = false;
  const next = elements.map((element) => {
    if (element.customData?.lcVizId) return element;
    const meta = element.customData;
    const isFrame = meta?.lcRegionFrame === true || element.id.endsWith("-frame");
    const isTemplate =
      isTemplateElementId(element.id) || Boolean(meta?.lcRegion) || isFrame;
    if (!isTemplate) return element;

    /*
     * Frames are never given a stroke — they are taken away from.
     *
     * This is where the dashed boxes came back from. Paging hides an off-page
     * frame by parking its opacity at 0; recolouring set every frame's opacity
     * back to 100 and its stroke to the theme border — so changing Appearance
     * un-hid every page's box at once, and turning the page and back was the
     * only way to put them away.
     *
     * Running it the other way round does double duty: the bug cannot happen,
     * and a board saved when frames *were* dashed loses its boxes the first
     * time it is opened, since `applyThemeInk` runs on every restore.
     */
    if (isFrame) {
      if (element.strokeWidth === 0 && element.strokeColor === "transparent") {
        return element;
      }
      changed = true;
      return { ...element, strokeColor: "transparent", strokeWidth: 0 };
    }

    let strokeColor = ink.body;
    let strokeWidth = element.strokeWidth;
    if (element.id.includes("-meta-box") || element.id.includes("-meta-rule")) {
      strokeColor = ink.border;
      if (element.id.includes("-meta-box")) strokeWidth = 1.5;
    } else if (element.id.includes("-title") || (element.fontSize ?? 0) >= 40) {
      // The id is the reliable witness; the size is the fallback for boards
      // whose ids were rewritten by conversion. 40 is above any body size the
      // template has ever authored and below every title.
      strokeColor = ink.primary;
    } else if (
      element.id.includes("-label") ||
      element.id.includes("-hint") ||
      element.id.includes("-meta") ||
      element.opacity === 90
    ) {
      strokeColor = ink.hint;
    } else if (element.id.includes("-body-") || element.type === "text") {
      strokeColor = element.fontFamily === FONT_CODE ? ink.primary : ink.body;
    }

    const opacity = element.opacity;
    if (
      element.strokeColor === strokeColor &&
      element.opacity === opacity &&
      element.strokeWidth === strokeWidth
    ) {
      return element;
    }
    changed = true;
    return {
      ...element,
      strokeColor,
      ...(opacity !== undefined ? { opacity } : {}),
      ...(strokeWidth !== undefined ? { strokeWidth } : {}),
    };
  });

  return changed ? next : null;
}

