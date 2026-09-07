/**
 * Capsule depth. Later hops sit on top at a self-cross. Adjacent hops still
 * union by signed distance so a joint does not flash the butt of the new cone.
 *
 * Smaller is closer ({@code LEQUAL}). Slot count is fixed so live {@code append}
 * stays consistent as the stroke grows.
 */

export const SDF_DEPTH_SLOTS = 4096;
/** Band overlap. 1 < joint < 2: neighbours compete; skip-one does not. */
export const SDF_DEPTH_JOINT = 2.5;

export function capsuleFragDepth(index: number, d: number, radius: number): number {
  const slots = SDF_DEPTH_SLOTS;
  const step = 1 / slots;
  const i = Math.max(0, Math.min(slots - 1, index));
  const rad = Math.max(radius, 1);
  const sdfz = Math.min(1, Math.max(0, 0.5 + 0.5 * (d / rad)));
  const base = (slots - 1 - i) * step;
  return Math.min(1, Math.max(0, base + sdfz * step * SDF_DEPTH_JOINT));
}
