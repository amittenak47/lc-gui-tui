/**
 * Grow a textarea to its content and shrink it when lines go away.
 *
 * Set height to 0 first so `scrollHeight` is the content, not the previous
 * inline height — otherwise deleting a line leaves a tall empty box.
 * Inline `height` beats CSS `min-height`, so the result is also floored at min.
 */
export function nextTextareaHeight(
  scrollHeight: number,
  maxPx: number | null,
  minPx = 0,
): number {
  const height = Math.max(Math.max(0, minPx), Math.max(0, scrollHeight));
  if (maxPx == null || !Number.isFinite(maxPx)) return height;
  return Math.min(height, Math.max(minPx, maxPx));
}

export function parseCssPx(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none") return null;
  if (!trimmed.endsWith("px")) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function fitTextareaHeight(node: HTMLTextAreaElement): number {
  const styles = getComputedStyle(node);
  const minPx = parseCssPx(styles.minHeight) ?? 0;
  const maxPx = parseCssPx(styles.maxHeight);
  node.style.height = "0px";
  const content = node.scrollHeight;
  const next = nextTextareaHeight(content, maxPx, minPx);
  node.style.height = `${next}px`;
  node.style.overflowY = maxPx != null && content > maxPx + 1 ? "auto" : "hidden";
  return next;
}
