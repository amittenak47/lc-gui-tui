/**
 * Group captured board elements by template region for coach prompts and chat
 * thumbnails.
 */

import { REGIONS, STUDENT_REGION_ORDER, type RegionId } from "../templates/regions";
import type { CapturedElement, SceneElementLike } from "./capture";
import { captureStructure, studentAuthoredElements, studentElements } from "./capture";

export interface RegionLayoutBucket {
  region: RegionId;
  label: string;
  /** Elements tagged to this region (frames, labels, student work). */
  elements: CapturedElement[];
  /** True when the student put something of their own here. */
  hasStudentWork: boolean;
}

/** Structure grouped by dashed template box — what Review board should emphasize. */
export function captureStructureByRegion(
  elements: readonly SceneElementLike[],
): RegionLayoutBucket[] {
  const structure = captureStructure(elements);
  const authoredIds = new Set(
    studentAuthoredElements(elements).map((el) => el.id.slice(0, 8)),
  );

  const byRegion = new Map<string, CapturedElement[]>();
  const unscoped: CapturedElement[] = [];

  for (const el of structure) {
    if (el.region && el.region in REGIONS) {
      const list = byRegion.get(el.region) ?? [];
      list.push(el);
      byRegion.set(el.region, list);
    } else {
      unscoped.push(el);
    }
  }

  // Free student strokes often lack lcRegion — assign by bounding-box overlap
  // with the region frames still in the scene.
  const frames = new Map<RegionId, SceneElementLike>();
  for (const el of studentElements(elements)) {
    if (el.type === "rectangle" && el.customData?.lcRegionFrame && el.customData.lcRegion) {
      frames.set(el.customData.lcRegion as RegionId, el);
    }
  }

  for (const el of unscoped) {
    const full = elements.find(
      (live) => live.id.startsWith(el.id) || el.id === live.id.slice(0, 8),
    );
    if (!full) continue;
    let home: RegionId | null = null;
    for (const region of STUDENT_REGION_ORDER) {
      const frame = frames.get(region);
      if (!frame) continue;
      const cx = full.x + full.width / 2;
      const cy = full.y + full.height / 2;
      if (
        cx >= frame.x &&
        cy >= frame.y &&
        cx <= frame.x + frame.width &&
        cy <= frame.y + frame.height
      ) {
        home = region;
        break;
      }
    }
    if (home) {
      const tagged = { ...el, region: home };
      const list = byRegion.get(home) ?? [];
      list.push(tagged);
      byRegion.set(home, list);
    }
  }

  const order: RegionId[] = [...STUDENT_REGION_ORDER, "agent"];
  return order
    .filter((region) => byRegion.has(region))
    .map((region) => {
      const elems = byRegion.get(region)!;
      return {
        region,
        label: REGIONS[region].label,
        elements: elems,
        hasStudentWork: elems.some(
          (el) => authoredIds.has(el.id) || (el.text && el.text.trim().length > 0 && el.type === "text"),
        ),
      };
    });
}

/** Wire shape: { regions: { approach: [...], ... } } for the coach prompt. */
export function structureGroupedForWire(
  elements: readonly SceneElementLike[],
): Record<string, CapturedElement[]> {
  const buckets = captureStructureByRegion(elements);
  const out: Record<string, CapturedElement[]> = {};
  for (const bucket of buckets) {
    // Skip empty chrome-only regions in the wire payload when possible —
    // always include regions that have student work; always include approach
    // scaffolding tags so the model knows the box exists.
    if (bucket.elements.length === 0) continue;
    out[bucket.region] = bucket.elements;
  }
  return out;
}
