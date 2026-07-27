/**
 * Sticky note in the agent lane for `annotate_region` tool results.
 *
 * Annotations never land in the student region they name — that preserves the
 * no-collision invariant. Tone maps to stroke colour from the coach palette.
 */

import {
  AGENT_LANE,
  AGENT_PADDING,
} from "../../templates/regions";
import {
  COACH_ACCENT,
  COACH_FILL,
  COACH_INK,
  type Skeleton,
} from "../../templates/skeleton";
import type { Annotation } from "../../api/types";

const TONE_STROKE: Record<string, string> = {
  question: COACH_INK,
  warning: COACH_ACCENT,
  confirm: "#166534",
};

export function renderAnnotation(
  annotation: Annotation,
  origin: { x: number; y: number },
): Skeleton[] {
  const width = AGENT_LANE.w - AGENT_PADDING * 2;
  const stroke = TONE_STROKE[annotation.tone] ?? COACH_INK;
  const header = `re: ${annotation.region}`;
  const body = annotation.text.trim();
  const vizId = `annotation:${annotation.region}`;

  return [
    {
      id: `${vizId}:box`,
      type: "rectangle",
      x: origin.x,
      y: origin.y,
      width,
      height: 120,
      backgroundColor: COACH_FILL,
      strokeColor: stroke,
      strokeWidth: 1.5,
      fillStyle: "solid",
      roundness: { type: 3 },
      roughness: 0,
      customData: { lcVizId: vizId },
    },
    {
      id: `${vizId}:header`,
      type: "text",
      x: origin.x + 12,
      y: origin.y + 10,
      width: width - 24,
      height: 24,
      text: header,
      fontSize: 16,
      strokeColor: stroke,
      textAlign: "left",
      customData: { lcVizId: vizId },
    },
    {
      id: `${vizId}:body`,
      type: "text",
      x: origin.x + 12,
      y: origin.y + 40,
      width: width - 24,
      height: 70,
      text: body,
      fontSize: 18,
      strokeColor: COACH_INK,
      textAlign: "left",
      customData: { lcVizId: vizId },
    },
  ];
}
