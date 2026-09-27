/** Freeze visible canvas pixels without touching any renderer's ink history. */
export function snapshotSashCanvases(board: HTMLElement): () => void {
  const bounds = board.getBoundingClientRect();
  const restores: Array<() => void> = [];
  // Read every layout/style before inserting snapshots. Alternating a DOM
  // write and getBoundingClientRect forced a layout for each PDF/ink layer.
  const layers: Array<{source: HTMLCanvasElement; css: Record<string, string>; width: number; height: number}> = [];
  for (const source of board.querySelectorAll<HTMLCanvasElement>("canvas:not(.lc-sash-snapshot)")) {
    const rect = source.getBoundingClientRect();
    const style = getComputedStyle(source);
    if (!source.width || !source.height || !rect.width || !rect.height ||
        style.visibility === "hidden" || style.display === "none" ||
        rect.right <= bounds.left || rect.left >= bounds.right ||
        rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;

    const css: Record<string, string> = {};
    // Keep each bitmap in its source's stacking/clip context (PDF text and
    // ink are in separate layers). Computed dimensions freeze percentage CSS.
    for (const key of [
      "position", "top", "right", "bottom", "left", "width", "height",
      "margin-top", "margin-right", "margin-bottom", "margin-left",
      "transform", "transform-origin", "z-index", "opacity", "box-sizing",
      "border-radius", "clip-path", "mix-blend-mode",
    ]) css[key] = style.getPropertyValue(key);
    if (style.position === "static" || style.position === "relative") {
      Object.assign(css, {position:"absolute",left:`${source.offsetLeft}px`,top:`${source.offsetTop}px`,
        margin:"0",right:"auto",bottom:"auto"});
    }
    // This is a temporary moving preview, not a second full-resolution PDF.
    // Bound copies by displayed pixels and by 2 MP even on a dense 4K screen.
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const scale = Math.min(1, rect.width * dpr / source.width, rect.height * dpr / source.height,
      Math.sqrt(2_000_000 / (source.width * source.height)));
    layers.push({source,css,width:Math.max(1,Math.floor(source.width*scale)),height:Math.max(1,Math.floor(source.height*scale))});
  }
  for (const {source,css,width,height} of layers) {
    const bitmap = document.createElement("canvas");
    bitmap.className = "lc-sash-snapshot";
    bitmap.setAttribute("aria-hidden", "true");
    bitmap.width = width;
    bitmap.height = height;
    try {
      const ctx = bitmap.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(source, 0, 0, width, height);
    } catch { continue; }
    for (const [key,value] of Object.entries(css)) bitmap.style.setProperty(key,value);
    bitmap.style.pointerEvents = "none";
    source.after(bitmap);
    const visibility = source.style.getPropertyValue("visibility");
    const priority = source.style.getPropertyPriority("visibility");
    source.style.setProperty("visibility", "hidden", "important");
    restores.push(() => {
      bitmap.remove();
      bitmap.width = bitmap.height = 0;
      if (visibility) source.style.setProperty("visibility", visibility, priority);
      else source.style.removeProperty("visibility");
    });
  }
  return () => { for (const restore of restores) restore(); };
}
