/**
 * Capsule depth. Later hops sit on top. Signed distance is not in the depth,
 * so a joint or self-cross does not Voronoi-partition two colours.
 *
 * Smaller is closer ({@code LEQUAL}). Slot count is fixed so live {@code append}
 * stays consistent as the stroke grows.
 */

export const SDF_DEPTH_SLOTS = 4096;

export function capsuleFragDepth(index: number): number {
  const slots = SDF_DEPTH_SLOTS;
  const step = 1 / slots;
  const i = Math.max(0, Math.min(slots - 1, index));
  return (slots - 1 - i) * step;
}
