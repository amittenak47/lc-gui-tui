/**
 * Dashed overlay around student elements — coach points without mutating ink.
 *
 * Exception to "coach ink stays in the agent lane": the outline must sit over
 * the student's element to mean anything. Safe because every piece is tagged
 * `lcVizId` and mutates nothing.
 */

import { COACH_ACCENT, COACH_INK, type Skeleton } from "../../templates/skeleton";
import type { Highlight } from "../../api/types";
import type { SceneElementLike } from "../../canvas/capture";
import { resolveCaptureIds } from "../../canvas/capture";

const TONE_STROKE: Record<string, string> = {
  question: COACH_INK,
  warning: COACH_ACCENT,
  confirm: "#166534",
};

const PAD = 10;

export function renderHighlight(
  highlight: Highlight,
  elements: readonly SceneElementLike[],
  index: number,
): Skeleton[] {
  const targets = resolveCaptureIds(elements, highlight.ids);
  if (targets.length === 0) return [];

  const stroke = TONE_STROKE[highlight.tone] ?? COACH_ACCENT;
  const vizId = `highlight:${index}`;
  const out: Skeleton[] = [];

  for (const [i, target] of targets.entries()) {
    out.push({
      id: `${vizId}:box:${i}`,
      type: "rectangle",
      x: target.x - PAD,
      y: target.y - PAD,
      width: Math.max(target.width, 24) + PAD * 2,
      height: Math.max(target.height, 24) + PAD * 2,
      backgroundColor: "transparent",
      strokeColor: stroke,
      strokeWidth: 2,
      strokeStyle: "dashed",
      fillStyle: "solid",
      roughness: 0,
      customData: { lcVizId: vizId },
    });
  }

  const anchor = targets[0];
  const noteX = anchor.x + Math.max(anchor.width, 24) + PAD * 2 + 8;
  const noteY = anchor.y - PAD;
  out.push({
    id: `${vizId}:caret`,
    type: "arrow",
    x: noteX - 24,
    y: noteY + 12,
    width: 20,
    height: 0,
    strokeColor: stroke,
    strokeWidth: 1.5,
    points: [
      [0, 0],
      [20, 0],
    ],
    customData: { lcVizId: vizId },
  });
  out.push({
    id: `${vizId}:note`,
    type: "text",
    x: noteX,
    y: noteY,
    width: 280,
    height: 80,
    text: highlight.note,
    fontSize: 16,
    strokeColor: stroke,
    textAlign: "left",
    customData: { lcVizId: vizId },
  });

  return out;
}
