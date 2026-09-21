/** Scale a scene into a view so the drawing fills the canvas. */
export function drawingFitScale(
  viewWidth: number,
  viewHeight: number,
  sceneWidth: number,
  sceneHeight: number,
  padding = 24,
): number {
  const usableW = Math.max(1, viewWidth - padding);
  const usableH = Math.max(1, viewHeight - padding);
  const width = Math.max(1, sceneWidth);
  const height = Math.max(1, sceneHeight);
  return Math.min(usableW / width, usableH / height);
}
