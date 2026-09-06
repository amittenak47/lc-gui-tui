import type { InkLabSample } from "./engine";

/** Deterministic pointer tapes. Same files for every engine. */

export type NamedTape = {
  name: "flick" | "letter" | "scribble" | "hold";
  samples: InkLabSample[];
};

function sample(
  x: number,
  y: number,
  p: number,
  t: number,
): InkLabSample {
  return { x, y, p, t };
}

/** Fast swipe. About 30 points. */
export function makeFlickTape(): InkLabSample[] {
  const n = 32;
  const out: InkLabSample[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    out.push(
      sample(
        80 + u * 420,
        210 + Math.sin(u * Math.PI) * 14,
        0.42 + 0.22 * (1 - Math.abs(u - 0.5) * 2),
        i * 6,
      ),
    );
  }
  return out;
}

/** One letter-like "m". About 120 points. */
export function makeLetterTape(): InkLabSample[] {
  const n = 120;
  const out: InkLabSample[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const hump = Math.abs(Math.sin(u * Math.PI * 2));
    const x = 140 + u * 280 + Math.sin(u * Math.PI * 4) * 6;
    const y = 320 - hump * 160 - (u < 0.08 || u > 0.92 ? (0.08 - Math.min(u, 1 - u)) * 80 : 0);
    out.push(sample(x, y, 0.5 + 0.15 * hump, i * 8));
  }
  return out;
}

/** Long scribble. About 500 points. */
export function makeScribbleTape(): InkLabSample[] {
  const n = 512;
  const out: InkLabSample[] = [];
  for (let i = 0; i < n; i++) {
    const x = 400 + 180 * Math.sin(i * 0.11) + 42 * Math.sin(i * 0.47);
    const y = 300 + 140 * Math.cos(i * 0.09) + 36 * Math.cos(i * 0.31);
    const p = 0.4 + 0.25 * (0.5 + 0.5 * Math.sin(i * 0.07));
    out.push(sample(x, y, p, i * 7));
  }
  return out;
}

/** Two-second hold at ~120 Hz. Same scene point, tiny jitter. */
export function makeHoldTape(): InkLabSample[] {
  const n = 240;
  const out: InkLabSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      sample(
        240 + Math.sin(i * 1.7) * 0.25,
        180 + Math.cos(i * 1.3) * 0.25,
        0.62,
        i * (1000 / 120),
      ),
    );
  }
  return out;
}

export function allBaselineTapes(): NamedTape[] {
  return [
    { name: "flick", samples: makeFlickTape() },
    { name: "letter", samples: makeLetterTape() },
    { name: "scribble", samples: makeScribbleTape() },
    { name: "hold", samples: makeHoldTape() },
  ];
}
