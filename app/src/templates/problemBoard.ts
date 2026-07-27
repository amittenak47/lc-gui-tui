/**
 * The layout the board pre-seeds when a problem is picked.
 *
 * The statement is reference material you read for twenty minutes while
 * sketching, so it is set like the problems page: a normal sans for prose, a
 * monospace face for anything with brackets or subscripts, and no hand-drawn
 * font anywhere. Region scaffolding is light, locked, and tagged with
 * `lcRegion` so the coach can tell "nothing written under Complexity" from
 * "there is no Complexity section".
 */

import { REGIONS, type RegionId } from "./regions";
import {
  FONT_CODE,
  FONT_UI,
  templatePalette,
  type Skeleton,
} from "./skeleton";

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
}

/** Prompts, so an empty region still says what belongs there. */
const HINTS: Record<RegionId, string> = {
  constraints: "",
  code: "",
  approach: "What are you scanning, and what invariant holds at each step?",
  complexity: "time / space — and why",
  walkthrough: "Trace one example by hand.",
  agent: "Coach diagrams land here.",
};

/** One block of statement text, and how it should be set. */
export interface StatementBlock {
  text: string;
  /** Monospace for anything with array literals, indices, or comparisons. */
  code: boolean;
}

/**
 * What counts as a code-ish line.
 *
 * Structural markers only — brackets, comparison operators, and the corpus's
 * `Input:`/`Output:` prefixes. Matching bare variable names like `nums` or
 * `mat` was too eager: "Given an m x n binary matrix mat, return…" is prose
 * that happens to name a variable, and setting it in monospace made the
 * statement *less* readable, not more.
 */
const CODE_LINE = /^(Input|Output|Explanation):|[[\]]|<=|>=|==|!=|\w+\[\w*\]/;

/**
 * Split a statement into prose and code-ish blocks.
 *
 * The corpus stores statements as plain text where examples and constraints are
 * already visually distinct — `Input: mat = [[0,0,0],...]`, `1 <= m, n <= 104`.
 * Setting those in a proportional font is what made the first pass hard to read,
 * so they get the monospace face while the surrounding prose does not.
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
    .filter((line, index, all) => line.trim().length > 0 || all[index - 1]?.trim().length > 0)
    .slice(0, maxLines);

  const blocks: StatementBlock[] = [];
  for (const line of lines) {
    const isCode = CODE_LINE.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.code === isCode) {
      last.text += `\n${line}`;
    } else {
      blocks.push({ text: line, code: isCode });
    }
  }
  return blocks.map((block) => ({ ...block, text: block.text.trim() }));
}

export function buildProblemTemplate(input: ProblemTemplateInput): Skeleton[] {
  const skeletons: Skeleton[] = [];
  const ink = templatePalette(Boolean(input.dark));
  const textWidth = REGIONS.constraints.w - 72;

  const at = (region: { id: RegionId; x: number; y: number }, x: number, y: number, extra: Record<string, unknown> = {}) => ({
    lcRegion: region.id,
    lcRegionOx: x - region.x,
    lcRegionOy: y - region.y,
    ...extra,
  });

  for (const region of Object.values(REGIONS)) {
    skeletons.push({
      id: `lcregion-${region.id}-frame`,
      type: "rectangle",
      x: region.x,
      y: region.y,
      width: region.w,
      height: region.h,
      strokeColor: ink.border,
      backgroundColor: "transparent",
      strokeStyle: "dashed",
      strokeWidth: 1.5,
      roughness: 0,
      opacity: 80,
      locked: false,
      customData: { lcRegion: region.id, lcRegionFrame: true },
    });

    // Monaco owns the solution-code UI — only the dashed frame is scaffolding.
    if (region.id === "code") continue;

    const labelX = region.x + 36;
    const labelY = region.y + 24;
    skeletons.push({
      id: `lcregion-${region.id}-label`,
      type: "text",
      x: labelX,
      y: labelY,
      width: textWidth,
      text: region.label.toUpperCase(),
      fontSize: region.id === "constraints" ? 24 : 20,
      fontFamily: FONT_UI,
      strokeColor: ink.hint,
      opacity: 100,
      locked: true,
      customData: at(region, labelX, labelY),
    });

    const hint = HINTS[region.id];
    if (hint) {
      const hintX = region.x + 36;
      const hintY = region.y + 64;
      skeletons.push({
        id: `lcregion-${region.id}-hint`,
        type: "text",
        x: hintX,
        y: hintY,
        width: textWidth,
        text: hint,
        fontSize: 22,
        fontFamily: FONT_UI,
        strokeColor: ink.hint,
        opacity: 90,
        locked: true,
        customData: at(region, hintX, hintY),
      });
    }
  }

  const constraints = REGIONS.constraints;

  skeletons.push({
    id: "lcregion-constraints-title",
    type: "text",
    x: constraints.x + 36,
    y: constraints.y + 64,
    width: textWidth,
    text: input.title,
    fontSize: 56,
    fontFamily: FONT_UI,
    strokeColor: ink.primary,
    locked: true,
    customData: at(constraints, constraints.x + 36, constraints.y + 64),
  });

  const meta = [
    input.difficulty,
    (input.tags ?? []).slice(0, 5).join(" · "),
    typeof input.caseCount === "number" && input.caseCount > 0
      ? `${input.caseCount} sample cases`
      : null,
  ]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join("   ·   ");

  if (meta) {
    skeletons.push({
      id: "lcregion-constraints-meta",
      type: "text",
      x: constraints.x + 36,
      y: constraints.y + 140,
      width: textWidth,
      text: meta,
      fontSize: 26,
      fontFamily: FONT_UI,
      strokeColor: ink.hint,
      locked: true,
      customData: at(constraints, constraints.x + 36, constraints.y + 140),
    });
  }

  // Statement body, block by block, so examples keep the monospace face.
  let y = constraints.y + 200;
  parseStatement(input.description, 48).forEach((block, index) => {
    const fontSize = block.code ? 24 : 28;
    const lineHeight = block.code ? 34 : 40;
    const x = constraints.x + 36;
    skeletons.push({
      id: `lcregion-constraints-body-${index}`,
      type: "text",
      x,
      y,
      width: textWidth,
      text: block.text,
      fontSize,
      fontFamily: block.code ? FONT_CODE : FONT_UI,
      strokeColor: block.code ? ink.primary : ink.body,
      locked: true,
      customData: at(constraints, x, y),
    });
    y += block.text.split("\n").length * lineHeight + 22;
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
 */
export function recolorTemplateElements<
  T extends {
    id: string;
    type: string;
    strokeColor?: string;
    fontFamily?: number;
    opacity?: number;
    customData?: { lcRegionFrame?: boolean; lcVizId?: string } | null;
  },
>(elements: readonly T[], dark: boolean): T[] | null {
  const ink = templatePalette(dark);
  let changed = false;
  const next = elements.map((element) => {
    if (element.customData?.lcVizId) return element;
    if (!isTemplateElementId(element.id) && !element.customData?.lcRegionFrame) {
      return element;
    }

    const isFrame =
      element.customData?.lcRegionFrame === true || element.id.endsWith("-frame");
    let strokeColor = ink.body;
    if (isFrame) strokeColor = ink.border;
    else if (element.id.includes("-title")) strokeColor = ink.primary;
    else if (
      element.id.includes("-label") ||
      element.id.includes("-hint") ||
      element.id.includes("-meta")
    ) {
      strokeColor = ink.hint;
    } else if (element.id.includes("-body-")) {
      strokeColor = element.fontFamily === FONT_CODE ? ink.primary : ink.body;
    }

    const opacity = isFrame ? 100 : element.opacity;
    if (element.strokeColor === strokeColor && element.opacity === opacity) {
      return element;
    }
    changed = true;
    return { ...element, strokeColor, ...(opacity !== undefined ? { opacity } : {}) };
  });

  return changed ? next : null;
}

