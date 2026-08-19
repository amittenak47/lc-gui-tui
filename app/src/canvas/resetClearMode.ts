/**
 * What a locked Reset tap cycles through before the hold-to-unlock + tap wipe.
 *
 * `all` — raster ink and student annotations (drawings + document marks).
 * `ink` — handwriting only.
 * `annotations` — drawings / footnote marks; ink stays.
 */
export type ResetClearMode = "all" | "ink" | "annotations";

export const RESET_CLEAR_MODES: readonly ResetClearMode[] = [
  "all",
  "ink",
  "annotations",
];

export function cycleResetClearMode(mode: ResetClearMode): ResetClearMode {
  const index = RESET_CLEAR_MODES.indexOf(mode);
  return RESET_CLEAR_MODES[(index + 1) % RESET_CLEAR_MODES.length]!;
}

export function resetClearModeLabel(mode: ResetClearMode): string {
  if (mode === "ink") return "ink";
  if (mode === "annotations") return "annotations";
  return "ink and annotations";
}
