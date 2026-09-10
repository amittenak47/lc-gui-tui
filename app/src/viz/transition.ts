import type { PaintSceneElement } from "../canvas/paintScene";

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function mixColor(a: string | undefined, b: string | undefined, t: number): string | undefined {
  if (!a || !b || !/^#[\da-f]{6}$/i.test(a) || !/^#[\da-f]{6}$/i.test(b)) return b;
  const channels = [1, 3, 5].map((i) => Math.round(mix(parseInt(a.slice(i, i + 2), 16), parseInt(b.slice(i, i + 2), 16), t)));
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Presentation only: the scene and exports always contain the exact target frame. */
export function transitionViz(
  from: readonly PaintSceneElement[],
  to: readonly PaintSceneElement[],
  progress: number,
): PaintSceneElement[] {
  if (progress >= 1) return [...to];
  const t = 1 - Math.pow(1 - Math.max(0, progress), 3);
  const previous = new Map(from.filter((el) => el.id).map((el) => [el.id, el]));
  return to.map((next) => {
    const old = previous.get(next.id);
    if (!old || old.type !== next.type) return { ...next, opacity: (next.opacity ?? 100) * t };
    return {
      ...next,
      x: mix(old.x, next.x, t),
      y: mix(old.y, next.y, t),
      width: mix(old.width ?? 0, next.width ?? 0, t),
      height: mix(old.height ?? 0, next.height ?? 0, t),
      opacity: mix(old.opacity ?? 100, next.opacity ?? 100, t),
      strokeWidth: mix(old.strokeWidth ?? 1, next.strokeWidth ?? 1, t),
      strokeColor: mixColor(old.strokeColor, next.strokeColor, t),
      backgroundColor: mixColor(old.backgroundColor, next.backgroundColor, t),
      points: old.points && next.points && old.points.length === next.points.length
        ? next.points.map((pt, i) => [mix(old.points![i]![0], pt[0], t), mix(old.points![i]![1], pt[1], t)])
        : next.points,
    };
  });
}
