/**
 * Hit-test board chrome by box, not `event.target`.
 *
 * The annotate toggle lives in a `pointer-events: none` overlay over `.lc-main`.
 * A reading pan promotes the page slot with `will-change: transform`, and
 * Chromium then hit-tests that compositor layer ahead of the overlay's
 * children. The finger is on the button; the event is on the page. Bounding
 * rects still see the control, so the scroll gatekeeper can refuse the pan and
 * fire the tap.
 */

/** Controls that should take a tap instead of a page pan. */
export const CHROME_CONTROL_SELECTOR =
  "button, [role='button'], a[href], input, select, textarea, .lc-hold-reveal, .lc-tool, .lc-color-dot, .lc-toolbar-grip";

const MIN_HIT_PX = 8;
/** Map chrome sits on the bottom edge. Skip the rect walk for a mid-page pan. */
const CHROME_BAND_PX = 200;

function inChromeBand(clientX: number, clientY: number): boolean {
  if (typeof window === "undefined") return true;
  const height = window.innerHeight;
  const width = window.innerWidth;
  if (!height || !width) return true;
  return clientY >= height - CHROME_BAND_PX || clientX <= 72 || clientX >= width - 72;
}

export function pointInDomRect(
  x: number,
  y: number,
  r: Pick<DOMRectReadOnly, "left" | "right" | "top" | "bottom" | "width" | "height">,
): boolean {
  return (
    r.width >= MIN_HIT_PX &&
    r.height >= MIN_HIT_PX &&
    x >= r.left &&
    x <= r.right &&
    y >= r.top &&
    y <= r.bottom
  );
}

function styleAllowsHit(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (style.pointerEvents === "none") return false;
  const opacity = style.opacity;
  if (opacity !== "" && Number(opacity) === 0) return false;
  return true;
}

function chromeRoots(scope: ParentNode): HTMLElement[] {
  const slot = scope.querySelector(".lc-board-chrome-slot");
  if (slot instanceof HTMLElement) {
    const controls = slot.querySelector(".lc-map-controls");
    if (controls instanceof HTMLElement) return [controls];
    if (slot.childElementCount > 0) return [slot];
  }
  return Array.from(scope.querySelectorAll(".lc-map-controls")).filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  );
}

export type ChromePointHit = {
  /** Smallest visible control containing the point. */
  control: HTMLElement | null;
  /** True when the point sits on a map-controls cluster, including padding. */
  surface: boolean;
};

/** One layout pass: which chrome, if any, is under this point. */
export function chromeHitAtPoint(
  clientX: number,
  clientY: number,
  scope: ParentNode = document,
): ChromePointHit {
  if (!inChromeBand(clientX, clientY)) return { control: null, surface: false };
  let control: HTMLElement | null = null;
  let area = Infinity;
  let surface = false;
  for (const root of chromeRoots(scope)) {
    for (const child of Array.from(root.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const cluster = child.getBoundingClientRect();
      if (!pointInDomRect(clientX, clientY, cluster)) continue;
      if (!styleAllowsHit(child)) continue;
      surface = true;
      for (const node of child.querySelectorAll(CHROME_CONTROL_SELECTOR)) {
        if (!(node instanceof HTMLElement)) continue;
        const box = node.getBoundingClientRect();
        if (!pointInDomRect(clientX, clientY, box)) continue;
        if (!styleAllowsHit(node)) continue;
        const nextArea = box.width * box.height;
        if (nextArea < area) {
          control = node;
          area = nextArea;
        }
      }
      if (!control && child.matches(CHROME_CONTROL_SELECTOR) && styleAllowsHit(child)) {
        control = child;
      }
    }
  }
  return { control, surface };
}

/** Smallest visible chrome control whose box contains the point, or null. */
export function chromeControlAtPoint(
  clientX: number,
  clientY: number,
  scope: ParentNode = document,
): HTMLElement | null {
  return chromeHitAtPoint(clientX, clientY, scope).control;
}

/**
 * True when the point sits on a map-controls cluster (left / dock / right),
 * including padding that is not itself a button.
 */
export function chromeSurfaceAtPoint(
  clientX: number,
  clientY: number,
  scope: ParentNode = document,
): boolean {
  return chromeHitAtPoint(clientX, clientY, scope).surface;
}

function dispatchPointerDown(el: HTMLElement): void {
  if (typeof PointerEvent === "function") {
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        buttons: 1,
      }),
    );
    return;
  }
  const event = new Event("pointerdown", { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
  });
  el.dispatchEvent(event);
}

/**
 * Fire the control the compositor failed to deliver the pointer to.
 *
 * Wake dots listen on `pointerdown` and swallow `click`. Ordinary toggles
 * (annotate / scroll) listen on `click`.
 */
export function activateChromeControl(el: HTMLElement): void {
  if (el.closest(".lc-chrome-wake")) {
    dispatchPointerDown(el);
    return;
  }
  el.click();
}
