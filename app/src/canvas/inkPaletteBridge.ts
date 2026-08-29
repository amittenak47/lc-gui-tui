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
 *
 * One process-global slot meant two Boards stole each other's wheel: unmount
 * of either reset the only history. Each surface is keyed (the tab / filmScope).
 */

import { seedInkPaletteHistory, type InkPaletteHistory } from "../util/inkPaletteHistory";

/**
 * A stable object to hand out before a board has published anything.
 *
 * Stable because `useSyncExternalStore` compares snapshots by identity and
 * would loop forever on a fresh seed each read.
 */
const UNSET: InkPaletteHistory = seedInkPaletteHistory("light");

const DEFAULT_SCOPE = "";

type PaletteSlot = {
  history: InkPaletteHistory;
  advance: (() => void) | null;
  retreat: (() => void) | null;
  listeners: Set<() => void>;
};

const slots = new Map<string, PaletteSlot>();

function slotOf(scope: string): PaletteSlot {
  const key = scope || DEFAULT_SCOPE;
  let slot = slots.get(key);
  if (!slot) {
    slot = {
      history: UNSET,
      advance: null,
      retreat: null,
      listeners: new Set(),
    };
    slots.set(key, slot);
  }
  return slot;
}

function notify(slot: PaletteSlot): void {
  for (const listener of slot.listeners) listener();
}

/** Board, whenever its wheel changes. */
export function publishInkPalette(next: InkPaletteHistory, scope = DEFAULT_SCOPE): void {
  const slot = slotOf(scope);
  if (next === slot.history) return;
  slot.history = next;
  notify(slot);
}

/** The wheel as it stands. Never null — the seed stands in until a board says. */
export function inkPaletteNow(scope = DEFAULT_SCOPE): InkPaletteHistory {
  return slotOf(scope).history;
}

/** Subscribe; returns the unsubscribe `useSyncExternalStore` expects. */
export function onInkPaletteChange(
  listener: () => void,
  scope = DEFAULT_SCOPE,
): () => void {
  const slot = slotOf(scope);
  slot.listeners.add(listener);
  return () => {
    slot.listeners.delete(listener);
  };
}

/**
 * Board registers the *same* forward cycle its wheel taps run.
 *
 * Not a second fetch path: "another palette" from the card has to mean what it
 * means at the pen, including the in-flight guard and the history append, or
 * the two drift apart the first time someone taps both.
 */
export function provideInkPaletteAdvance(
  handler: (() => void) | null,
  scope = DEFAULT_SCOPE,
): void {
  slotOf(scope).advance = handler;
}

/** Ask for the next palette. A no-op when no board is mounted. */
export function advanceInkPalette(scope = DEFAULT_SCOPE): void {
  slotOf(scope).advance?.();
}

/** Board registers the backward cycle (hub tap on the open wheel). */
export function provideInkPaletteRetreat(
  handler: (() => void) | null,
  scope = DEFAULT_SCOPE,
): void {
  slotOf(scope).retreat = handler;
}

/** Ask for the previous palette in history. */
export function retreatInkPalette(scope = DEFAULT_SCOPE): void {
  slotOf(scope).retreat?.();
}

/**
 * Board on unmount, so a stale wheel is not left on offer.
 *
 * Named `scope` only: unmount of one pane must not wipe the other's wheel.
 * Tests that omit a scope still wipe every slot.
 */
export function resetInkPaletteBridge(scope?: string): void {
  if (scope == null) {
    for (const slot of slots.values()) {
      slot.history = UNSET;
      slot.advance = null;
      slot.retreat = null;
      notify(slot);
    }
    slots.clear();
    return;
  }
  const slot = slots.get(scope);
  if (!slot) return;
  slot.history = UNSET;
  slot.advance = null;
  slot.retreat = null;
  notify(slot);
  slots.delete(scope);
}
