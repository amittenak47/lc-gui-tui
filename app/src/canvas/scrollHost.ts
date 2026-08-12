/**
 * Nested scrollers inside a document page.
 *
 * Board scroll is camera-owned: one capture-phase gatekeeper on `.lc-board`
 * takes every pointer and turns it into a page pan, which is right for prose
 * and wrong for the one kind of element in a note that has somewhere else to
 * go. A wide fenced codeblock showed an `overflow-x` scrollbar that nothing
 * could ever reach — the document layer is `pointer-events: none` so a pen
 * lands on the ink rather than the text, and anything that got past that was
 * `preventDefault`ed into a vertical pan.
 *
 * The gatekeeper asks this before it claims a gesture.
 *
 * **Host-bound ink.** Marks drawn inside a horizontally scrollable box are
 * stored in page coordinates but painted with a scroll offset so they stay on
 * the tokens they were written against. Each host gets a stable `hostKey` —
 * its document-order index among scroll hosts in the doc scope, the same
 * vocabulary {@link scopeRootsIn} uses for offset spaces.
 */

import type { SceneBounds, ViewportTransform } from "./rasterInk";
import { scenePointFromCanvasPixel } from "./rasterInk";

/** Fractional overflow is a rounding artefact, not somewhere to scroll to. */
const OVERFLOW_SLACK_PX = 1;

/** Roots that contain horizontally scrollable content inside a document page. */
export const DOC_PAGE_SELECTOR = ".lc-md-ink-doc, .lc-code-doc, .lc-epub-doc";

/**
 * Whether `node` is a horizontally scrollable box.
 *
 * Asks the DOM rather than matching on `pre`: a table or an embed in an
 * `overflow-x` box has exactly the same claim on a sideways drag, and a
 * codeblock whose lines all fit has none.
 */
export function isHorizontalScrollHost(node: HTMLElement): boolean {
  if (node.scrollWidth - node.clientWidth <= OVERFLOW_SLACK_PX) return false;
  const overflowX = getComputedStyle(node).overflowX;
  return overflowX === "auto" || overflowX === "scroll";
}

/**
 * The nearest horizontally scrollable box at or above `target`, within the
 * document page — `null` if the pointer is on ordinary prose.
 */
export function horizontalScrollHost(target: EventTarget | null): HTMLElement | null {
  const start = target instanceof Element ? target : null;
  const doc = start?.closest(DOC_PAGE_SELECTOR);
  if (!start || !doc) return null;
  const stop = doc.parentElement;
  for (let node: Element | null = start; node && node !== stop; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    if (isHorizontalScrollHost(node)) return node;
  }
  return null;
}

/**
 * Scroll host under a client point.
 *
 * Annotate mode sets `.lc-page-content-slot` to `pointer-events: none` so the
 * pen lands on the ink canvas — that also removes the `pre` from
 * `elementsFromPoint`, which is why a hit-stack walk always missed hosts on
 * the real Board (the lab keeps the host hittable under the overlay).
 *
 * Geometry first: every live host's client box, deepest wins. Hit-stack is only
 * a fallback for callers outside a board tree.
 */
export function scrollHostAtPoint(clientX: number, clientY: number): HTMLElement | null {
  if (typeof document === "undefined") return null;

  let best: HTMLElement | null = null;
  let bestArea = Infinity;
  for (const doc of document.querySelectorAll(DOC_PAGE_SELECTOR)) {
    for (const host of horizontalScrollHostsIn(doc)) {
      const box = host.getBoundingClientRect();
      if (
        clientX < box.left ||
        clientX > box.right ||
        clientY < box.top ||
        clientY > box.bottom
      ) {
        continue;
      }
      const area = Math.max(0, box.width) * Math.max(0, box.height);
      // Smallest box = innermost host when hosts nest.
      if (area < bestArea) {
        bestArea = area;
        best = host;
      }
    }
  }
  if (best) return best;

  if (typeof document.elementsFromPoint !== "function") return null;
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.classList.contains("lc-raster-ink")) continue;
    if (el.tagName === "CANVAS") continue;
    if (el.closest?.(".lc-page-marks-slot")) continue;
    const host = horizontalScrollHost(el);
    if (!host) continue;
    const box = host.getBoundingClientRect();
    if (
      clientX < box.left ||
      clientX > box.right ||
      clientY < box.top ||
      clientY > box.bottom
    ) {
      continue;
    }
    return host;
  }
  return null;
}

/**
 * Every horizontally scrollable box inside a document page, in document order.
 *
 * The index in this list is the stable `hostKey` stored on ink ops. Order is
 * fixed for a given DOM tree, so a stroke written today resolves to the same
 * box when the page is reopened tomorrow.
 */
export function horizontalScrollHostsIn(doc: Element): HTMLElement[] {
  const hosts: HTMLElement[] = [];
  const stop = doc.parentElement;
  const walker = doc.ownerDocument?.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
  if (!walker) return hosts;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof HTMLElement)) continue;
    if (node === doc) continue;
    if (stop && !doc.contains(node)) continue;
    if (isHorizontalScrollHost(node)) hosts.push(node);
  }
  return hosts;
}

/** Document-order index of `host` among scroll hosts in `doc`, or null. */
export function hostKeyInDoc(host: HTMLElement, doc: Element): number | null {
  const hosts = horizontalScrollHostsIn(doc);
  const index = hosts.indexOf(host);
  return index >= 0 ? index : null;
}

/** The document page that owns `host`, if any. */
export function docForScrollHost(host: HTMLElement): Element | null {
  return host.closest(DOC_PAGE_SELECTOR);
}

/**
 * Scene-space axis-aligned box of a scroll host's visible viewport.
 *
 * `canvasRect` is the ink overlay's client rect; `viewport` is the Excalidraw
 * camera the overlay is painted against.
 */
export function hostSceneBounds(
  host: HTMLElement,
  canvasRect: DOMRect,
  viewport: Pick<ViewportTransform, "zoom" | "scrollX" | "scrollY">,
): SceneBounds {
  const hostRect = host.getBoundingClientRect();
  const topLeft = scenePointFromCanvasPixel(
    hostRect.left - canvasRect.left,
    hostRect.top - canvasRect.top,
    viewport,
  );
  const bottomRight = scenePointFromCanvasPixel(
    hostRect.right - canvasRect.left,
    hostRect.bottom - canvasRect.top,
    viewport,
  );
  return {
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: bottomRight.x,
    maxY: bottomRight.y,
  };
}

/** Live scroll state for one host at paint time. */
export interface ScrollHostPaintState {
  key: number;
  scrollLeft: number;
  bounds: SceneBounds;
}

/**
 * Scene-space host lookup for export / offscreen paint.
 *
 * Maps each host's visible CSS box into {@link pageBounds} using the content
 * slot's on-screen size (CSS px per scene unit ≈ camera zoom).
 */
export function scrollHostLookupFromSlot(
  slot: HTMLElement | null | undefined,
  pageBounds: SceneBounds | null | undefined,
): Map<number, { bounds: SceneBounds; scrollLeft: number }> | null {
  if (!slot || !pageBounds) return null;
  const pageW = pageBounds.maxX - pageBounds.minX;
  const pageH = pageBounds.maxY - pageBounds.minY;
  if (pageW <= 0 || pageH <= 0) return null;
  const slotRect = slot.getBoundingClientRect();
  if (slotRect.width < 1 || slotRect.height < 1) return null;
  const sx = slotRect.width / pageW;
  const sy = slotRect.height / pageH;
  const map = new Map<number, { bounds: SceneBounds; scrollLeft: number }>();
  for (const doc of slot.querySelectorAll(DOC_PAGE_SELECTOR)) {
    horizontalScrollHostsIn(doc).forEach((el, key) => {
      const r = el.getBoundingClientRect();
      map.set(key, {
        scrollLeft: el.scrollLeft,
        bounds: {
          minX: pageBounds.minX + (r.left - slotRect.left) / sx,
          minY: pageBounds.minY + (r.top - slotRect.top) / sy,
          maxX: pageBounds.minX + (r.right - slotRect.left) / sx,
          maxY: pageBounds.minY + (r.bottom - slotRect.top) / sy,
        },
      });
    });
  }
  return map.size > 0 ? map : null;
}

/** CSS pixels per scene unit on the content slot (camera zoom proxy). */
export function slotCssPerScene(
  slot: HTMLElement | null | undefined,
  pageBounds: SceneBounds | null | undefined,
): number {
  if (!slot || !pageBounds) return 1;
  const pageW = pageBounds.maxX - pageBounds.minX;
  if (pageW <= 0) return 1;
  const w = slot.getBoundingClientRect().width;
  if (w < 1) return 1;
  return w / pageW;
}

/** Whether stroke bounds overlap a host's scene box. */
export function strokeBoundsInHost(
  bounds: SceneBounds,
  hostBounds: SceneBounds,
): boolean {
  return (
    bounds.maxX >= hostBounds.minX &&
    bounds.minX <= hostBounds.maxX &&
    bounds.maxY >= hostBounds.minY &&
    bounds.minY <= hostBounds.maxY
  );
}
