import type { InkPalette } from "./inkPaletteHistory";

export const MIX_MIN_DELTA_E = 12;
export const MIX_MIN_CONTRAST = 2;

function rgb(hex: string): number[] {
  const raw = hex.replace(/^#/, "");
  const full = raw.length === 3 ? [...raw].map(c => c + c).join("") : raw;
  if (!/^[a-f\d]{6}$/i.test(full)) throw new Error(`Invalid colour: ${hex}`);
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255);
}

function linear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map(linear);
  return .2126 * r! + .7152 * g! + .0722 * b!;
}

export function paletteContrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

/** sRGB, D65 reference white, CIE76 distance. */
function lab(hex: string): number[] {
  const [r, g, b] = rgb(hex).map(linear);
  const d = 6 / 29;
  const f = (t: number) => t > d ** 3 ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
  const x = f((.4124564 * r! + .3575761 * g! + .1804375 * b!) / .95047);
  const y = f(.2126729 * r! + .7151522 * g! + .072175 * b!);
  const z = f((.0193339 * r! + .119192 * g! + .9503041 * b!) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function paletteDeltaE(a: string, b: string): number {
  const x = lab(a), y = lab(b);
  return Math.hypot(...x.map((v, i) => v - y[i]!));
}

/** Seeded shuffle keeps a colour mix reproducible without any network dependency. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    let n = state += 0x6d2b79f5;
    n = Math.imul(n ^ n >>> 15, n | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function vivid(hex: string): boolean {
  const channels = rgb(hex);
  return Math.max(...channels) >= .72 && Math.max(...channels) - Math.min(...channels) >= .5;
}

export function mixInkPalette(
  palettes: readonly InkPalette[],
  paper: string,
  seed: number,
  options: { preferVivid?: boolean; seen?: ReadonlySet<string> } = {},
): InkPalette | null {
  const colours = shuffled([...new Set(palettes.flat().map(c => c.toLowerCase()))], seed)
    .filter(c => paletteContrast(c, paper) >= MIX_MIN_CONTRAST)
    .map(hex => ({ hex, lab: lab(hex), vivid: vivid(hex) }));
  if (colours.length < 4) return null;
  // Bound search even for a large pool. Put a vivid first colour in the mix
  // when All is breaking a muted run, as the unmodified feed picker does.
  const mustBeVivid = options.preferVivid && colours.some(c => c.vivid);
  const selected: typeof colours = [];
  let attempts = 0;
  const pick = (start: number): InkPalette | null => {
    if (++attempts > 20_000) return null;
    if (selected.length === 4) {
      const palette = selected.map(c => c.hex);
      return options.seen?.has(palette.join(",")) ? null : palette;
    }
    for (let i = start; i < colours.length; i++) {
      const candidate = colours[i]!;
      if (mustBeVivid && selected.length === 0 && !candidate.vivid) continue;
      if (selected.some(c => Math.hypot(...c.lab.map((v, j) => v - candidate.lab[j]!)) < MIX_MIN_DELTA_E)) continue;
      selected.push(candidate);
      const result = pick(i + 1);
      if (result) return result;
      selected.pop();
    }
    return null;
  };
  // Vivid colours must have access to every other candidate in the pool.
  if (mustBeVivid) colours.sort((a, b) => Number(b.vivid) - Number(a.vivid));
  return pick(0);
}
