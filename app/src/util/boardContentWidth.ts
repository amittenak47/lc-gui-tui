/**
 * CSS width of the board content area — not `window.innerWidth`.
 *
 * The coach panel, handedness margin, and browser chrome all shrink the board
 * without shrinking the window. Reading columns and document fits must measure
 * against the box the page actually lands in.
 */
export function boardContentCssWidth(root?: ParentNode | null): number {
  if (typeof document === "undefined") return 0;
  const scope = root ?? document;
  const board = scope.querySelector(".lc-board");
  const boardBox = board?.getBoundingClientRect();
  if (boardBox && boardBox.width > 8) return Math.round(boardBox.width);
  const wrap = scope.querySelector(".lc-canvas-wrap");
  const wrapBox = wrap?.getBoundingClientRect();
  if (wrapBox && wrapBox.width > 8) return Math.round(wrapBox.width);
  if (typeof window !== "undefined") return Math.round(window.innerWidth);
  return 0;
}
