/** Freeze visible canvas pixels without touching any renderer's ink history. */
export function snapshotSashCanvases(board: HTMLElement): () => void {
  const bounds = board.getBoundingClientRect();
  const restores: Array<() => void> = [];
  for (const source of board.querySelectorAll<HTMLCanvasElement>("canvas:not(.lc-sash-snapshot)")) {
    const rect = source.getBoundingClientRect();
    const style = getComputedStyle(source);
    if (!source.width || !source.height || !rect.width || !rect.height ||
        style.visibility === "hidden" || style.display === "none" ||
        rect.right <= bounds.left || rect.left >= bounds.right ||
        rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;

    const bitmap = document.createElement("canvas");
    bitmap.className = "lc-sash-snapshot";
    bitmap.setAttribute("aria-hidden", "true");
    bitmap.width = source.width;
    bitmap.height = source.height;
    try {
      const ctx = bitmap.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(source, 0, 0);
    } catch {
      // Keep the original visible if a platform cannot copy this canvas.
      continue;
    }

    // Keep each bitmap in its source's stacking/clip context (PDF text and
    // ink are in separate layers). Computed dimensions freeze percentage CSS.
    for (const key of [
      "position", "top", "right", "bottom", "left", "width", "height",
      "margin-top", "margin-right", "margin-bottom", "margin-left",
      "transform", "transform-origin", "z-index", "opacity", "box-sizing",
      "border-radius", "clip-path", "mix-blend-mode",
    ]) bitmap.style.setProperty(key, style.getPropertyValue(key));
    if (style.position === "static" || style.position === "relative") {
      bitmap.style.position = "absolute";
      bitmap.style.left = `${source.offsetLeft}px`;
      bitmap.style.top = `${source.offsetTop}px`;
      bitmap.style.margin = "0";
      bitmap.style.right = "auto";
      bitmap.style.bottom = "auto";
    }
    bitmap.style.pointerEvents = "none";
    source.after(bitmap);
    const visibility = source.style.getPropertyValue("visibility");
    const priority = source.style.getPropertyPriority("visibility");
    source.style.setProperty("visibility", "hidden", "important");
    restores.push(() => {
      bitmap.remove();
      if (visibility) source.style.setProperty("visibility", visibility, priority);
      else source.style.removeProperty("visibility");
    });
  }
  return () => { for (const restore of restores) restore(); };
}
