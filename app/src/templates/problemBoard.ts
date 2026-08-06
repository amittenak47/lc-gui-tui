/**
 * The layout the board pre-seeds when a problem is picked.
 *
 * Region frames still exist (camera fit, pan clamp, ink clip) but are invisible.
 * Statement prose is HTML under the canvas — {@link StatementDocument} — same
 * markdown paper path as md-ink, so wrap and continuous scroll come free.
 */

import { REGIONS } from "./regions";
import { readingColumnWidth } from "./readingColumn";
import { FONT_CODE, templatePalette, type Skeleton } from "./skeleton";

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

export function buildProblemTemplate(input: ProblemTemplateInput): Skeleton[] {
  const skeletons: Skeleton[] = [];

  /*
   * The statement is set in its own column, not in the student column.
   *
   * Prose is HTML under the canvas ({@link StatementDocument} / md-ink path).
   * Frames still size the camera, pan clamp, and ink clip.
   */
  const columnWidth = readingColumnWidth(
    typeof input.viewportWidth === "number" ? input.viewportWidth : Number.NaN,
  );

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
        ...(isStatement ? { lcDocumentPage: true, lcReadingColumn: true } : {}),
      },
    });
  }

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

