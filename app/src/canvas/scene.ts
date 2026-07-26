/**
 * Making element metadata survive `convertToExcalidrawElements`.
 *
 * The skeleton API honours an explicit `id` on containers and text, but a
 * *bound label* (`label: { text }` on a rectangle) becomes a second element with
 * a generated id — and nothing guarantees it inherits the container's
 * `customData`. That broke two things:
 *
 * - **Clear** decided what to keep by matching id prefixes, so every bound label
 *   in the template looked like student work and got wiped along with it. That
 *   is why clearing the board erased the problem statement.
 * - **Viz replacement** filters on `customData.lcVizId`, so unlabelled label
 *   elements would have been left behind as orphans when a frame changed.
 *
 * Rather than trusting the conversion, stamp the metadata on afterwards and let
 * bound labels inherit from whatever container they belong to.
 */

import type { SkeletonMeta } from "../templates/skeleton";

interface ConvertedElement {
  id: string;
  containerId?: string | null;
  customData?: SkeletonMeta | null;
  [key: string]: unknown;
}

/**
 * Give every converted element the metadata its skeleton asked for, and give
 * bound labels their container's.
 *
 * `sources` are the skeletons that went in; order is not relied upon, only ids.
 */
export function applyMetadata<T extends ConvertedElement>(
  converted: readonly T[],
  sources: ReadonlyArray<{ id?: string; customData?: SkeletonMeta | null }>,
  fallback?: SkeletonMeta,
): T[] {
  const wanted = new Map<string, SkeletonMeta>();
  for (const source of sources) {
    if (source.id && source.customData) wanted.set(source.id, source.customData);
  }

  return converted.map((element) => {
    const own = wanted.get(element.id);
    const inherited = element.containerId ? wanted.get(element.containerId) : undefined;
    const merged: SkeletonMeta = {
      ...fallback,
      ...(element.customData ?? undefined),
      ...inherited,
      ...own,
    };
    return Object.keys(merged).length > 0 ? { ...element, customData: merged } : element;
  });
}

/** Elements belonging to the pre-seeded problem template. */
export function isTemplateElement(element: { customData?: SkeletonMeta | null }): boolean {
  return Boolean(element.customData?.lcRegion);
}

/** Elements the coach injected. */
export function isCoachElement(element: { customData?: SkeletonMeta | null }): boolean {
  return Boolean(element.customData?.lcVizId);
}

/**
 * What **Clear** keeps: the template and the coach's diagrams. Only the
 * student's own strokes go.
 */
export function keepOnClear(element: { customData?: SkeletonMeta | null }): boolean {
  return isTemplateElement(element) || isCoachElement(element);
}
