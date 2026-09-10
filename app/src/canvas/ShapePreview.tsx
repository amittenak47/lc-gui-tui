import { useEffect, useRef } from "react";
import { DEFAULT_SHAPE_PALETTE, type ShapeStamp, type ShapeModValue } from "../templates/shapes";
import { convertToExcalidrawElements } from "./convertSkeletons";
import { paintSceneElements, type PaintSceneElement } from "./paintScene";
import { getCommonBounds } from "./boardScene";

/** Preview the actual stamp, including edits, with the same painter as the pad. */
export function ShapePreview({ shape, mods = shape.defaults, large = false }: {
  shape: ShapeStamp;
  mods?: Record<string, ShapeModValue>;
  large?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const elements = convertToExcalidrawElements(shape.build(0, 0, mods, DEFAULT_SHAPE_PALETTE)) as PaintSceneElement[];
    const [minX, minY, maxX, maxY] = getCommonBounds(elements);
    const width = large ? 264 : 112;
    const height = large ? 124 : 62;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    const scale = Math.min((width - 20) / Math.max(1, maxX - minX), (height - 20) / Math.max(1, maxY - minY), large ? 1 : 0.7);
    ctx.translate((width - (maxX - minX) * scale) / 2, (height - (maxY - minY) * scale) / 2);
    ctx.scale(scale, scale);
    ctx.translate(-minX, -minY);
    paintSceneElements(ctx, elements, { all: true });
  }, [shape, mods, large]);
  return <canvas ref={ref} className={`lc-shape-preview${large ? " is-large" : ""}`} aria-hidden="true" />;
}
