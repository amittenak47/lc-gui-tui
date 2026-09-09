import { bakeSpine } from "./bake";
import { capillaryRelax } from "./style";
import type { InkLabBakeOptions } from "./engine";
import type { SpineDot } from "./instance";

export type InkBakeRequest = {
  id: number;
  points: SpineDot[];
  options: InkLabBakeOptions;
};

export type InkBakeResponse = {
  id: number;
  points: SpineDot[];
  bake: "catmull" | "clothoid";
  bakeMs: number;
};

self.onmessage = (event: MessageEvent<InkBakeRequest>) => {
  const started = performance.now();
  const { id, points, options } = event.data;
  const baked = bakeSpine(points, {
    smoothing: options.smoothing,
    clothoid: options.clothoid,
  });
  const result = options.capillary ? capillaryRelax(baked.points) : baked.points;
  (self as unknown as Worker).postMessage({
    id,
    points: result,
    bake: baked.bake,
    bakeMs: performance.now() - started,
  } satisfies InkBakeResponse);
};
