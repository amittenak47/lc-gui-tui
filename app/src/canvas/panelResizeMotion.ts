type Camera = { scrollX: number; scrollY: number; zoom: number };
const LAYERS = ".lc-page-content-slot, .lc-page-marks-slot, .lc-board-lined-overlay, .lc-page-title-slot, .lc-scene-overlay, .lc-scene-select, canvas.excalidraw__canvas, canvas.lc-ink-lab-canvas";

/**
 * Play the current pixels forward to the destination camera while the hole's
 * margin eases. A web animation, not an inline transform: the canvas rewrites
 * its own transform every frame and would otherwise hide the preview until settle.
 */
export class PanelResizeMotion {
  private layers = new Map<HTMLElement, Animation>();

  start(board: HTMLElement, from: Camera, to: Camera, previousLeft: number, duration: number): void {
    this.finish();
    if (!duration || typeof board.animate !== "function") return;
    const left = board.getBoundingClientRect().left;
    const dx = previousLeft - left;
    const scale = from.zoom > 0 ? to.zoom / from.zoom : 1;
    const tx = (to.scrollX - from.scrollX) * to.zoom;
    const ty = (to.scrollY - from.scrollY) * to.zoom;
    for (const node of board.querySelectorAll<HTMLElement>(LAYERS)) {
      const style = getComputedStyle(node);
      const origin = style.transformOrigin.split(" ").map(Number.parseFloat);
      const current = new DOMMatrix()
        .translate(origin[0] || 0, origin[1] || 0)
        .multiply(new DOMMatrix(style.transform === "none" ? undefined : style.transform))
        .translate(-(origin[0] || 0), -(origin[1] || 0));
      let x = 0, y = 0, parent: HTMLElement | null = node;
      while (parent && parent !== board) {
        x += parent.offsetLeft;
        y += parent.offsetTop;
        parent = parent.offsetParent as HTMLElement | null;
      }
      const end = new DOMMatrix()
        .translate(dx + tx + (scale - 1) * x, ty + (scale - 1) * y)
        .scale(scale)
        .multiply(current);
      const animation = node.animate(
        [
          { transform: new DOMMatrix().translate(dx, 0).multiply(current).toString(), transformOrigin: "0 0" },
          { transform: end.toString(), transformOrigin: "0 0" },
        ],
        { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
      );
      this.layers.set(node, animation);
    }
  }

  finish(): void {
    for (const animation of this.layers.values()) animation.cancel();
    this.layers.clear();
  }
}
