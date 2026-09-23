type Camera = { scrollX: number; scrollY: number; zoom: number };
const LAYERS = ".lc-page-content-slot, .lc-page-marks-slot, .lc-board-lined-overlay, .lc-page-title-slot, .lc-scene-overlay, .lc-scene-select, canvas.excalidraw__canvas, canvas.lc-ink-lab-canvas";

/** Transform existing pixels/text during panel motion; remesh only on settle. */
export class PanelResizeMotion {
  private layers = new Map<HTMLElement, { base: DOMMatrix; animation: Animation }>();
  private left: number | null = null;

  start(board: HTMLElement, from: Camera, to: Camera, previousLeft: number, duration: number): void {
    if (!duration || typeof board.animate !== "function") return;
    const left = board.getBoundingClientRect().left;
    const dx = (this.left ?? previousLeft) - left;
    const scale = to.zoom / from.zoom;
    const tx = (to.scrollX - from.scrollX) * to.zoom;
    const ty = (to.scrollY - from.scrollY) * to.zoom;
    for (const node of board.querySelectorAll<HTMLElement>(LAYERS)) {
      const previous = this.layers.get(node);
      const style = getComputedStyle(node);
      const origin = style.transformOrigin.split(" ").map(Number.parseFloat);
      const current = new DOMMatrix().translate(origin[0] || 0, origin[1] || 0)
        .multiply(new DOMMatrix(style.transform === "none" ? undefined : style.transform))
        .translate(-(origin[0] || 0), -(origin[1] || 0));
      const base = previous?.base ?? current;
      // The layer's layout origin is outside its transform coordinate system.
      let x = 0, y = 0, parent: HTMLElement | null = node;
      while (parent && parent !== board) { x += parent.offsetLeft; y += parent.offsetTop; parent = parent.offsetParent as HTMLElement | null; }
      const end = new DOMMatrix().translate(tx + (scale - 1) * x, ty + (scale - 1) * y).scale(scale).multiply(base);
      previous?.animation.cancel();
      const animation = node.animate([
        { transform: new DOMMatrix().translate(dx, 0).multiply(current).toString(), transformOrigin: "0 0" },
        { transform: end.toString(), transformOrigin: "0 0" },
      ], { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
      this.layers.set(node, { base, animation });
    }
    this.left = left;
  }

  finish(): void {
    for (const { animation } of this.layers.values()) animation.cancel();
    this.layers.clear();
    this.left = null;
  }
}
