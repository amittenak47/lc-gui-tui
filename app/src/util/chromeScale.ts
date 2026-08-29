/**
 * How big the pen's floating chrome draws, given how much room the pane has.
 *
 * The nib wheel and the preset editor are sized for a pane that is the whole
 * window. Split one tab against another and the canvas halves, but these do
 * not: the wheel keeps its 192px dial and the editor its 640px sheet, and on
 * a tablet that is most of the half you are drawing in.
 *
 * The answer is a scale rather than a narrower layout. Everything in both
 * surfaces is proportioned against everything else — wedge angles, the hub,
 * the spec card's columns, the editor's sliders — and reflowing them at a
 * smaller width would be a second design to keep working. Scaled, it is the
 * same picture, smaller, and it still reads because that is what a scale
 * preserves.
 *
 * Published as a custom property on the document element rather than passed
 * down: both surfaces portal to `document.body`, so there is no React parent
 * to inherit from and no ancestor a CSS selector could reach.
 */

/** The property both surfaces read. Absent means 1 — see the `var()` defaults. */
export const CHROME_SCALE_VAR = "--lc-chrome-scale";

/**
 * Pen chrome in a split pane, as a fraction of its full-pane size.
 *
 * A quarter off is the most that keeps the spec card's two columns and the
 * editor's slider labels at a size worth reading; the dial's wedges have more
 * room than that and would take more.
 */
export const SPLIT_CHROME_SCALE = 0.75;

export function inkChromeScale(inSplit: boolean): number {
  return inSplit ? SPLIT_CHROME_SCALE : 1;
}

/**
 * Publish the scale for this layout, or take it away.
 *
 * Removed rather than set to 1 when there is no split: the `var()` fallback is
 * already 1, and a property that is only there when it does something is one
 * fewer thing to explain in a devtools inspector.
 */
export function applyInkChromeScale(root: HTMLElement | null, inSplit: boolean): void {
  if (!root) return;
  if (!inSplit) {
    root.style.removeProperty(CHROME_SCALE_VAR);
    return;
  }
  root.style.setProperty(CHROME_SCALE_VAR, String(inkChromeScale(true)));
}
