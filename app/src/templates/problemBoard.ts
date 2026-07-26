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
  STUDENT_HINT,
  TEXT_BODY,
  TEXT_PRIMARY,
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
}

/** Prompts, so an empty region still says what belongs there. */
const HINTS: Record<RegionId, string> = {
  constraints: "",
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

  for (const region of Object.values(REGIONS)) {
    skeletons.push({
      id: `lcregion-${region.id}-frame`,
      type: "rectangle",
      x: region.x,
      y: region.y,
      width: region.w,
      height: region.h,
      strokeColor: STUDENT_HINT,
      backgroundColor: "transparent",
      strokeStyle: "dashed",
      strokeWidth: 1,
      roughness: 0,
      opacity: 35,
      locked: true,
      customData: { lcRegion: region.id },
    });

    skeletons.push({
      id: `lcregion-${region.id}-label`,
      type: "text",
      x: region.x + 28,
      y: region.y + 20,
      text: region.label.toUpperCase(),
      fontSize: 22,
      fontFamily: FONT_UI,
      strokeColor: STUDENT_HINT,
      opacity: 80,
      locked: true,
      customData: { lcRegion: region.id },
    });

    const hint = HINTS[region.id];
    if (hint) {
      skeletons.push({
        id: `lcregion-${region.id}-hint`,
        type: "text",
        x: region.x + 28,
        y: region.y + 56,
        text: hint,
        fontSize: 18,
        fontFamily: FONT_UI,
        strokeColor: STUDENT_HINT,
        opacity: 55,
        locked: true,
        customData: { lcRegion: region.id },
      });
    }
  }

  const constraints = REGIONS.constraints;

  skeletons.push({
    id: "lcregion-constraints-title",
    type: "text",
    x: constraints.x + 28,
    y: constraints.y + 62,
    text: input.title,
    fontSize: 40,
    fontFamily: FONT_UI,
    strokeColor: TEXT_PRIMARY,
    locked: true,
    customData: { lcRegion: "constraints" },
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
      x: constraints.x + 28,
      y: constraints.y + 116,
      text: meta,
      fontSize: 18,
      fontFamily: FONT_UI,
      strokeColor: STUDENT_HINT,
      locked: true,
      customData: { lcRegion: "constraints" },
    });
  }

  // Statement body, block by block, so examples keep the monospace face.
  let y = constraints.y + 164;
  parseStatement(input.description).forEach((block, index) => {
    skeletons.push({
      id: `lcregion-constraints-body-${index}`,
      type: "text",
      x: constraints.x + 28,
      y,
      text: block.text,
      fontSize: block.code ? 17 : 19,
      fontFamily: block.code ? FONT_CODE : FONT_UI,
      strokeColor: block.code ? TEXT_PRIMARY : TEXT_BODY,
      locked: true,
      customData: { lcRegion: "constraints" },
    });
    // Excalidraw lays text out from the top-left; advance by the line count.
    const lineHeight = block.code ? 24 : 27;
    y += block.text.split("\n").length * lineHeight + 16;
  });

  return skeletons;
}

/** Ids the template owns, kept for tests and debugging. */
export function isTemplateElementId(id: string): boolean {
  return id.startsWith("lcregion-");
}
