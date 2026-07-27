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
  code: "Type your solution here — this is what tests and the coach read.",
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
      strokeWidth: 2,
      roughness: 0,
      opacity: 100,
      locked: false,
      customData: { lcRegion: region.id, lcRegionFrame: true },
    });

    // Code keeps the same label/hint chrome as Approach; Monaco docks under it.
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

    // Statement body is filled below; Monaco owns the code region interior.
    if (region.id === "code") continue;
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

  const metaParts = [
    input.difficulty?.trim() || null,
    ...(input.tags ?? []).slice(0, 5).map((tag) => tag.trim()).filter(Boolean),
    typeof input.caseCount === "number" && input.caseCount > 0
      ? `${input.caseCount} sample cases`
      : null,
  ].filter((part): part is string => Boolean(part && part.length > 0));

  let bodyY = constraints.y + 200;
  if (metaParts.length > 0) {
    const metaFont = 26;
    const padX = 16;
    const padY = 10;
    const gap = 14;
    const boxH = metaFont + padY * 2 + 6;
    let chipX = constraints.x + 36;
    let chipY = constraints.y + 140;
    const rowLeft = constraints.x + 36;
    const rowRight = rowLeft + textWidth;

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
        customData: { ...at(constraints, textX, textY), lcFixedSize: true },
      });

      chipX += boxW + gap;
    });

    const chipsBottom = chipY + boxH;
    const ruleY = chipsBottom + 22;
    const ruleX = rowLeft;
    skeletons.push({
      id: "lcregion-constraints-meta-rule",
      type: "line",
      x: ruleX,
      y: ruleY,
      width: textWidth,
      height: 0,
      points: [
        [0, 0],
        [textWidth, 0],
      ],
      strokeColor: ink.border,
      strokeWidth: 1.5,
      strokeStyle: "solid",
      roughness: 0,
      locked: true,
      customData: { ...at(constraints, ruleX, ruleY), lcFixedSize: true },
    });
    bodyY = ruleY + 28;
  }

  // Statement body, block by block, so examples keep the monospace face.
  let y = bodyY;
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

    let strokeColor = ink.body;
    let strokeWidth = element.strokeWidth;
    if (isFrame) {
      strokeColor = ink.border;
      strokeWidth = 2;
    } else if (element.id.includes("-meta-box") || element.id.includes("-meta-rule")) {
      strokeColor = ink.border;
      if (element.id.includes("-meta-box")) strokeWidth = 1.5;
    } else if (element.id.includes("-title") || (element.fontSize ?? 0) >= 48) {
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

    const opacity = isFrame ? 100 : element.opacity;
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

