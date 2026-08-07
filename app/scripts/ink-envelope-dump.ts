/**
 * Throwaway envelope dump: print inkStrokeRuns alphas head→tail.
 * Run: npx tsx scripts/ink-envelope-dump.ts
 */
import {
  inkStrokeRuns,
  NO_PRESSURE,
  type InkDrawOp,
  type ScenePoint,
} from "../src/canvas/rasterInk";

function line(n: number, spacing = 4): ScenePoint[] {
  return Array.from({ length: n }, (_, i) => ({
    x: i * spacing,
    y: 0,
    pressure: NO_PRESSURE,
  }));
}

function dump(label: string, op: InkDrawOp) {
  const runs = inkStrokeRuns(op);
  const alphas = runs.map((r) => r.alpha.toFixed(3)).join(" ");
  console.log(`${label}: ${runs.length} runs | ${alphas}`);
}

const long = line(800); // ~1400 nib-widths at tip 2 — past dial-0.5 lead (540)

dump(
  "pressure off dial 0.5",
  {
    kind: "draw",
    color: "#000",
    baseWidth: 2,
    maxFullness: 0.5,
    pressureClip: 1,
    pressureSensitive: false,
    points: long,
  },
);

dump(
  "pressure off dial 1 (opaque)",
  {
    kind: "draw",
    color: "#000",
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: long,
  },
);

// After attack-window backfill, capture would write flat peak pressure from sample 0.
const flatPress: ScenePoint[] = Array.from({ length: 120 }, (_, i) => ({
  x: i * 3,
  y: 0,
  pressure: 0.8,
}));

dump(
  "pressure on flat 0.8 (post-attack) dial 0.5",
  {
    kind: "draw",
    color: "#000",
    baseWidth: 2,
    maxFullness: 0.5,
    pressureClip: 1,
    pressureSensitive: true,
    points: flatPress,
  },
);
