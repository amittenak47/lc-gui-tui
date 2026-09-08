/**
 * Selection / footnote chrome is portalled to the body so the board's scroll
 * gatekeeper cannot steal its clicks. That also means it does not ride the
 * page slot's transform — callers re-place it from a live mark rect whenever
 * the surface moves, and dismiss it when the mark leaves the pane.
 */

import { unionViewportBoxes } from "../util/docMarquee";

const SLOT_SELECTOR = ".lc-page-content-slot, .lc-page-marks-slot";
const SURFACE_ROOT_SELECTOR = ".lc-board, .lc-hub-conflict-preview";

export function escapeAttrSelector(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** True when `a` and `b` share at least `min` CSS pixels on both axes. */
export function viewportBoxesOverlap(
  a: Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">,
  b: Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">,
  min = 1,
): boolean {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width >= min && height >= min;
}

export function hasUsableViewportBox(
  box: Pick<DOMRectReadOnly, "width" | "height"> | null | undefined,
): boolean {
  return Boolean(box && (box.width > 1 || box.height > 1));
}

/**
 * Live screen box of a footnote's quote bands.
 *
 * Several packs can share an id in the merge preview; `hint` (the rect used
 * to open the card) picks the nearest one.
 */
export function liveFootnoteAnchorRect(
  footnoteId: string,
  hint?: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height"> | null,
): DOMRect | null {
  const packs = Array.from(
    document.querySelectorAll<HTMLElement>(
      `.lc-doc-footnote-pack[data-footnote-id="${escapeAttrSelector(footnoteId)}"]`,
    ),
  ).filter((node) => node.isConnected);
  if (packs.length === 0) return null;
  let pack = packs[0]!;
  if (packs.length > 1 && hint && (hint.width > 0 || hint.height > 0)) {
    const hx = hint.left + hint.width / 2;
    const hy = hint.top + hint.height / 2;
    let best = Infinity;
    for (const candidate of packs) {
      const box = candidate.getBoundingClientRect();
      const d = Math.hypot(
        box.left + box.width / 2 - hx,
        box.top + box.height / 2 - hy,
      );
      if (d < best) {
        best = d;
        pack = candidate;
      }
    }
  }
  const bands = Array.from(pack.querySelectorAll(".lc-doc-footnote-band"))
    .map((node) => node.getBoundingClientRect())
    .filter((box) => box.width > 0.5 && box.height > 0.5);
  return unionViewportBoxes(bands) ?? pack.getBoundingClientRect();
}

/**
 * Fire `onMove` when the page slot pans, a nested host scrolls, or the
 * visual viewport shifts. Coalesced to animation frames.
 */
export function subscribePageSurfaceMove(onMove: () => void): () => void {
  let frame: number | null = null;
  const kick = () => {
    if (frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      onMove();
    });
  };
  const mo =
    typeof MutationObserver === "function" ? new MutationObserver(kick) : null;
  for (const slot of document.querySelectorAll(SLOT_SELECTOR)) {
    mo?.observe(slot, { attributes: true, attributeFilter: ["style", "class"] });
  }
  const roots = document.querySelectorAll(SURFACE_ROOT_SELECTOR);
  for (const root of roots) {
    root.addEventListener("scroll", kick, { capture: true, passive: true });
  }
  window.addEventListener("resize", kick);
  window.visualViewport?.addEventListener("scroll", kick);
  window.visualViewport?.addEventListener("resize", kick);
  return () => {
    mo?.disconnect();
    for (const root of roots) {
      root.removeEventListener("scroll", kick, true);
    }
    window.removeEventListener("resize", kick);
    window.visualViewport?.removeEventListener("scroll", kick);
    window.visualViewport?.removeEventListener("resize", kick);
    if (frame != null) cancelAnimationFrame(frame);
  };
}
