/** Which edge the drawing overlay uses, given UI vs ink hands. */

export type ChromeHand = "left" | "right";

/** Agent sits on the UI hand, so the drawing parks on the other edge. */
export function drawingDockSide(uiHand: ChromeHand): ChromeHand {
  return uiHand === "left" ? "right" : "left";
}

/**
 * Annotate chrome sits on the edge *away* from the writing palm — left for a
 * right-handed writer (`data-handedness` unset), right when ink is left.
 */
export function inkChromeSide(inkHand: ChromeHand): ChromeHand {
  return inkHand === "left" ? "right" : "left";
}

/**
 * Matching hands put the overlay on the same edge as the annotate chrome.
 * Mixed hands put the checkers on one edge and the drawing on the other.
 */
export function drawingStacksWithInk(uiHand: ChromeHand, inkHand: ChromeHand): boolean {
  return drawingDockSide(uiHand) === inkChromeSide(inkHand);
}

/** Slide away from the page, toward the docked edge. */
export function drawingSlideOffX(dock: ChromeHand): string {
  return dock === "right" ? "110%" : "-110%";
}
