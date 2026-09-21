import { useEffect, useMemo, useRef } from "react";
import { convertToExcalidrawElements } from "../canvas/convertSkeletons";
import { getCommonBounds } from "../canvas/boardScene";
import { paintSceneToExport } from "../canvas/paintScene";
import { drawingFitScale } from "./drawingFit";
import { renderViz } from "./render";
import type { VizProgram } from "./schema";

/** Raster of one viz frame, scaled to fill its box. */
export function DrawingPreview({
  program,
  frameIndex = 0,
  title,
  className,
}: {
  program: VizProgram;
  frameIndex?: number;
  title?: string;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useMemo(
    () =>
      convertToExcalidrawElements(renderViz(program, frameIndex, { x: 0, y: 0 }, { bare: true }), {
        regenerateIds: false,
      }),
    [program, frameIndex],
  );

  useEffect(() => {
    const node = canvas.current;
    if (!node || !scene.length) return;
    const paint = () => {
      const ctx = node.getContext("2d");
      if (!ctx) return;
      const width = node.clientWidth;
      const height = node.clientHeight;
      if (width < 2 || height < 2) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      node.width = Math.round(width * dpr);
      node.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const [x, y, right, bottom] = getCommonBounds(scene);
      const scale = drawingFitScale(width, height, right - x, bottom - y);
      ctx.translate((width - (right - x) * scale) / 2, (height - (bottom - y) * scale) / 2);
      ctx.scale(scale, scale);
      ctx.translate(-x, -y);
      paintSceneToExport(ctx, scene, { minX: 0, minY: 0, padding: 0, exportScale: 1 });
    };
    paint();
    const resize = new ResizeObserver(paint);
    resize.observe(node);
    return () => resize.disconnect();
  }, [scene]);

  return (
    <canvas
      ref={canvas}
      className={className}
      role="img"
      aria-label={title || program.title || "Agent drawing"}
    />
  );
}
