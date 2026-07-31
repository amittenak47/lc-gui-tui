/**
 * Blank practice sheet — same region geography as a problem board, without a
 * corpus statement or code dock expectations.
 */

import { REGIONS, type RegionId } from "./regions";
import { FONT_UI, templatePalette, type Skeleton } from "./skeleton";

export const SCRATCHPAD_TASK_ID = "__scratchpad__";
export const SCRATCHPAD_DATASET = "scratchpad";

const HINTS: Partial<Record<RegionId, string>> = {
  approach: "Free sketch — notes, diagrams, whatever you need.",
  complexity: "Optional: time / space thoughts.",
  walkthrough: "Optional: walk an example by hand.",
  scratch: "More room to think.",
  agent: "Coach diagrams land here when you use Coach.",
};

export function buildScratchpadTemplate(dark = false): Skeleton[] {
  const skeletons: Skeleton[] = [];
  const ink = templatePalette(dark);
  const textWidth = REGIONS.constraints.w - 72;

  const at = (
    region: { id: RegionId; x: number; y: number },
    x: number,
    y: number,
    extra: Record<string, unknown> = {},
  ) => ({
    lcRegion: region.id,
    lcRegionOx: x - region.x,
    lcRegionOy: y - region.y,
    ...extra,
  });

  for (const region of Object.values(REGIONS)) {
    if (region.id === "code") continue;

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
      angle: 0,
      customData: { lcRegion: region.id, lcRegionFrame: true },
    });

    const labelX = region.x + 36;
    const labelY = region.y + 24;
    const label =
      region.id === "constraints" ? "SCRATCHPAD" : region.label.toUpperCase();
    skeletons.push({
      id: `lcregion-${region.id}-label`,
      type: "text",
      x: labelX,
      y: labelY,
      width: textWidth,
      text: label,
      fontSize: region.id === "constraints" ? 24 : 20,
      fontFamily: FONT_UI,
      strokeColor: ink.hint,
      opacity: 100,
      locked: true,
      customData: {
        ...at(region, labelX, labelY),
        lcFontBase: region.id === "constraints" ? 24 : 20,
        lcFixedSize: true,
      },
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
    text: "Scratchpad",
    fontSize: 56,
    fontFamily: FONT_UI,
    strokeColor: ink.primary,
    locked: true,
    customData: {
      ...at(constraints, constraints.x + 36, constraints.y + 64),
      lcFontBase: 56,
      lcFixedSize: true,
    },
  });

  skeletons.push({
    id: "lcregion-constraints-body-0",
    type: "text",
    x: constraints.x + 36,
    y: constraints.y + 160,
    width: textWidth,
    text: "No problem set — draw freely. Coach still works when the server is online.",
    fontSize: 26,
    fontFamily: FONT_UI,
    strokeColor: ink.hint,
    locked: true,
    customData: {
      ...at(constraints, constraints.x + 36, constraints.y + 160),
      lcFontBase: 26,
    },
  });

  return skeletons;
}
