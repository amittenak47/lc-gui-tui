/**
 * Click-off a modal only when the press *started* on the dimmed backdrop.
 *
 * A click event can target the backdrop when pointer-down was on an input or
 * the panel and pointer-up is outside it (text selection, a drag that misses).
 * HTML then fires `click` on the common ancestor — the backdrop — and a naive
 * `target === currentTarget` dismiss treats that as "clicked off".
 */

export function shouldDismissBackdrop(
  downOnBackdrop: boolean,
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  return downOnBackdrop && target === currentTarget;
}
