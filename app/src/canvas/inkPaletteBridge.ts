/**
 * The colour wheel, shared with whatever else wants to pick from it.
 *
 * There is one palette on a board — the one on the toolbar's pen wheel, kept in
 * Board's state and saved on the board blob. The footnote card seeded a second
 * history of its own, which meant two wheels: shuffling on the card showed the
 * reader colours the pen had never heard of, and a palette pulled at the pen
 * was not on offer when they came to colour a mark. Same board, same colours.
 *
 * A module seam rather than a context for the same reason `docSelectionGesture`
 * is one: Board owns the state and the fetch, the card only reads and asks, and
 * threading a provider through the portal the card renders into would be more
 * plumbing than the one value is worth.
 */

import { seedInkPaletteHistory, type InkPaletteHistory } from "../util/inkPaletteHistory";

/**
 * A stable object to hand out before a board has published anything.
 *
 * Stable because `useSyncExternalStore` compares snapshots by identity and
 * would loop forever on a fresh seed each read.
 */
const UNSET: InkPaletteHistory = seedInkPaletteHistory("light");

let history: InkPaletteHistory = UNSET;
let advance: (() => void) | null = null;
let retreat: (() => void) | null = null;
const listeners = new Set<() => void>();

/** Board, whenever its wheel changes. */
export function publishInkPalette(next: InkPaletteHistory): void {
  if (next === history) return;
  history = next;
  for (const listener of listeners) listener();
}

/** The wheel as it stands. Never null — the seed stands in until a board says. */
export function inkPaletteNow(): InkPaletteHistory {
  return history;
}

/** Subscribe; returns the unsubscribe `useSyncExternalStore` expects. */
export function onInkPaletteChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Board registers the *same* forward cycle its wheel taps run.
 *
 * Not a second fetch path: "another palette" from the card has to mean what it
 * means at the pen, including the in-flight guard and the history append, or
 * the two drift apart the first time someone taps both.
 */
export function provideInkPaletteAdvance(handler: (() => void) | null): void {
  advance = handler;
}

/** Ask for the next palette. A no-op when no board is mounted. */
export function advanceInkPalette(): void {
  advance?.();
}

/** Board registers the backward cycle (hub tap on the open wheel). */
export function provideInkPaletteRetreat(handler: (() => void) | null): void {
  retreat = handler;
}

/** Ask for the previous palette in history. */
export function retreatInkPalette(): void {
  retreat?.();
}

/** Board on unmount, so a stale wheel is not left on offer. */
export function resetInkPaletteBridge(): void {
  history = UNSET;
  advance = null;
  retreat = null;
  for (const listener of listeners) listener();
}
