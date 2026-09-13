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
 * **Host-bound ink.** Marks drawn inside a scrollable box are stored in page
 * coordinates but painted with a scroll offset so they stay on the tokens they
 * were written against. Each host gets a stable `hostKey` — horizontal hosts
 * first (document order, same as before), then overflow-y-only hosts appended
 * so old files keep their keys.
 */

import type { SceneBounds, ViewportTransform } from "./rasterInk";
import { scenePointFromCanvasPixel } from "./rasterInk";

/** Fractional overflow is a rounding artefact, not somewhere to scroll to. */
const OVERFLOW_SLACK_PX = 1;

/** Roots that contain horizontally scrollable content inside a document page. */
export const DOC_PAGE_SELECTOR = ".lc-md-ink-doc, .lc-code-doc, .lc-epub-doc, .lc-web-doc";

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

export function isVerticalScrollHost(node: HTMLElement): boolean {
  if (node.scrollHeight - node.clientHeight <= OVERFLOW_SLACK_PX) return false;
  const overflowY = getComputedStyle(node).overflowY;
  return overflowY === "auto" || overflowY === "scroll";
}

export function isNestedScrollHost(node: HTMLElement): boolean {
  return isHorizontalScrollHost(node) || isVerticalScrollHost(node);
}

/** Pointer is on the ink pad, not the document. Board pan must not claim it. */
export function isInkPadTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return (
    el.closest(".lc-ink-lab-canvas, .lc-board-ink-lab-host, .lc-raster-ink") != null
  );
}

/** Put a nested scroller back if something moved it (pen pan, focus, remount). */
export function pinHostScroll(
  el: HTMLElement | null | undefined,
  left: number,
  top: number,
): void {
  if (!el) return;
  if (el.scrollLeft !== left) el.scrollLeft = left;
  if (el.scrollTop !== top) el.scrollTop = top;
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
 * Nearest nested scroller (horizontal or vertical) at or above `target`.
 */
export function nestedScrollHost(target: EventTarget | null): HTMLElement | null {
  const start = target instanceof Element ? target : null;
  const doc = start?.closest(DOC_PAGE_SELECTOR);
  if (!start || !doc) return null;
  const stop = doc.parentElement;
  for (let node: Element | null = start; node && node !== stop; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    if (isNestedScrollHost(node)) return node;
  }
  return null;
}

export type NestedScrollHost = {
  el: HTMLElement;
  doc: number;
  key: number;
};

/** Client box captured with the host list so later hit-tests skip layout. */
export type NestedScrollHostBox = NestedScrollHost & {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type BoardHostCache = {
  listed: NestedScrollHost[];
  boxes: NestedScrollHostBox[] | null;
};

const BOARD_HOSTS = new WeakMap<ParentNode, BoardHostCache>();

/**
 * Geometry hit-test against a cached host list. Callers that already scanned
 * the document (pen-down) must not walk KaTeX/`pre` again.
 */
export function hitScrollHostAtPoint(
  clientX: number,
  clientY: number,
  hosts: readonly HTMLElement[],
): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestArea = Infinity;
  for (const host of hosts) {
    if (!host.isConnected) continue;
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
    if (area < bestArea) {
      bestArea = area;
      best = host;
    }
  }
  return best;
}

/**
 * Hit-test stored client boxes. No `getBoundingClientRect` — print letters
 * after the first must not force a KaTeX layout.
 */
export function hitScrollHostAtBoxes(
  clientX: number,
  clientY: number,
  hosts: readonly NestedScrollHostBox[],
): NestedScrollHostBox | null {
  let best: NestedScrollHostBox | null = null;
  let bestArea = Infinity;
  for (const host of hosts) {
    if (!host.el.isConnected) continue;
    if (
      clientX < host.left ||
      clientX > host.right ||
      clientY < host.top ||
      clientY > host.bottom
    ) {
      continue;
    }
    const area = Math.max(0, host.right - host.left) * Math.max(0, host.bottom - host.top);
    if (area < bestArea) {
      bestArea = area;
      best = host;
    }
  }
  return best;
}

export function boxScrollHosts(hosts: readonly NestedScrollHost[]): NestedScrollHostBox[] {
  const out: NestedScrollHostBox[] = [];
  for (const host of hosts) {
    if (!host.el.isConnected) continue;
    const box = host.el.getBoundingClientRect();
    out.push({
      el: host.el,
      doc: host.doc,
      key: host.key,
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
    });
  }
  return out;
}

export function rememberBoardScrollHosts(
  board: ParentNode,
  listed: NestedScrollHost[],
): void {
  BOARD_HOSTS.set(board, { listed, boxes: null });
}

/** Rects moved (pan). Keep the element list — do not re-run getComputedStyle. */
export function invalidateBoardScrollHostLayout(board: ParentNode): void {
  const cached = BOARD_HOSTS.get(board);
  if (cached) cached.boxes = null;
}

export function boxedScrollHostsInBoard(board: ParentNode): NestedScrollHostBox[] {
  let cached = BOARD_HOSTS.get(board);
  if (!cached) {
    cached = { listed: listScrollHostsInBoard(board), boxes: null };
    BOARD_HOSTS.set(board, cached);
  }
  if (!cached.boxes) {
    cached.listed = cached.listed.filter((host) => host.el.isConnected);
    if (cached.listed.length === 0) cached.listed = listScrollHostsInBoard(board);
    cached.boxes = boxScrollHosts(cached.listed);
  }
  return cached.boxes;
}

export function hitBoardScrollHostAtPoint(
  clientX: number,
  clientY: number,
  board: ParentNode | null | undefined,
): HTMLElement | null {
  if (!board) return null;
  return hitScrollHostAtBoxes(clientX, clientY, boxedScrollHostsInBoard(board))?.el ?? null;
}

/**
 * Nested hosts in a board, keyed like {@link snapshotHostScrollIn}.
 * Fill once per mutation/resize; pen-down only hit-tests this list.
 */
export function listScrollHostsInBoard(
  root: ParentNode | null | undefined,
): NestedScrollHost[] {
  if (!root) return [];
  const out: NestedScrollHost[] = [];
  root.querySelectorAll(DOC_PAGE_SELECTOR).forEach((doc, docIndex) => {
    scrollHostsIn(doc).forEach((el, key) => {
      out.push({ el, doc: docIndex, key });
    });
  });
  return out;
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

  const docs = document.querySelectorAll(DOC_PAGE_SELECTOR);
  if (docs.length === 0) return null;

  let best: HTMLElement | null = null;
  let bestArea = Infinity;
  for (const doc of docs) {
    for (const host of scrollHostsIn(doc)) {
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
    if (el.classList.contains("lc-ink-lab-canvas")) continue;
    if (el.tagName === "CANVAS") continue;
    if (el.closest?.(".lc-page-marks-slot")) continue;
    const host = nestedScrollHost(el);
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
 * Used by the board gesture gatekeeper (sideways drag). Ink keys use
 * {@link scrollHostsIn}, which keeps this list first so old files stay valid.
 */
export function horizontalScrollHostsIn(doc: Element): HTMLElement[] {
  return hostsIn(doc, isHorizontalScrollHost);
}

/**
 * Nested scroll hosts for ink: horizontal first (stable keys), then
 * overflow-y-only hosts appended.
 */
export function scrollHostsIn(doc: Element): HTMLElement[] {
  const horizontal: HTMLElement[] = [];
  const verticalOnly: HTMLElement[] = [];
  for (const node of hostCandidates(doc)) {
    if (isHorizontalScrollHost(node)) horizontal.push(node);
    else if (isVerticalScrollHost(node)) verticalOnly.push(node);
  }
  return horizontal.length === 0 ? verticalOnly : [...horizontal, ...verticalOnly];
}

function hostCandidates(doc: Element): HTMLElement[] {
  // Markdown's scroll containers are code/math blocks and explicit source
  // styles. Walking every word/glyph reads layout thousands of times on each
  // pen-down and mode switch. Web/EPUB documents can have arbitrary CSS, so
  // keep their general discovery path.
  const selector = doc.matches(".lc-md-ink-doc, .lc-code-doc")
    ? 'pre, .katex-display, [style*="overflow" i]'
    : "*";
  return Array.from(doc.querySelectorAll(selector)).filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  );
}

function hostsIn(doc: Element, match: (node: HTMLElement) => boolean): HTMLElement[] {
  return hostCandidates(doc).filter(match);
}

/** Document-order index of `host` among scroll hosts in `doc`, or null. */
export function hostKeyInDoc(host: HTMLElement, doc: Element): number | null {
  const hosts = scrollHostsIn(doc);
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
export function hostSceneBoundsFromClientBox(
  hostBox: { left: number; top: number; right: number; bottom: number },
  canvasRect: { left: number; top: number },
  viewport: Pick<ViewportTransform, "zoom" | "scrollX" | "scrollY">,
): SceneBounds {
  const topLeft = scenePointFromCanvasPixel(
    hostBox.left - canvasRect.left,
    hostBox.top - canvasRect.top,
    viewport,
  );
  const bottomRight = scenePointFromCanvasPixel(
    hostBox.right - canvasRect.left,
    hostBox.bottom - canvasRect.top,
    viewport,
  );
  return {
    minX: topLeft.x,
    minY: topLeft.y,
    maxX: bottomRight.x,
    maxY: bottomRight.y,
  };
}

export function hostSceneBounds(
  host: HTMLElement,
  canvasRect: DOMRect,
  viewport: Pick<ViewportTransform, "zoom" | "scrollX" | "scrollY">,
): SceneBounds {
  return hostSceneBoundsFromClientBox(host.getBoundingClientRect(), canvasRect, viewport);
}

/** Live scroll state for one host at paint time. */
export interface ScrollHostPaintState {
  key: number;
  scrollLeft: number;
  scrollTop: number;
  bounds: SceneBounds;
}

/** Nested `scrollLeft` / `scrollTop` keyed by document-order host, not node identity. */
export interface HostScrollSnapshot {
  doc: number;
  key: number;
  left: number;
  top: number;
}

/**
 * Snapshot nested host scroll so annotate/scroll toggles can restore it.
 *
 * React may replace the `<pre>` on that class flip; element-identity maps then
 * skip restore and the box jumps to 0. Keys survive remount.
 */
export function snapshotHostScrollIn(root: ParentNode | null | undefined): HostScrollSnapshot[] {
  if (!root) return [];
  const out: HostScrollSnapshot[] = [];
  root.querySelectorAll(DOC_PAGE_SELECTOR).forEach((doc, docIndex) => {
    scrollHostsIn(doc).forEach((el, key) => {
      out.push({ doc: docIndex, key, left: el.scrollLeft, top: el.scrollTop });
    });
  });
  return out;
}

export function restoreHostScrollIn(
  root: ParentNode | null | undefined,
  saved: readonly HostScrollSnapshot[],
): void {
  if (!root || saved.length === 0) return;
  const docs = root.querySelectorAll(DOC_PAGE_SELECTOR);
  const indexed = new Map<number, HTMLElement[]>();
  for (const pos of saved) {
    const doc = docs[pos.doc];
    if (!doc) continue;
    // One discovery per document, not one full discovery per saved fence.
    let hosts = indexed.get(pos.doc);
    if (!hosts) { hosts = scrollHostsIn(doc); indexed.set(pos.doc, hosts); }
    const host = hosts[pos.key];
    if (!host) continue;
    if (host.scrollLeft !== pos.left) host.scrollLeft = pos.left;
    if (host.scrollTop !== pos.top) host.scrollTop = pos.top;
  }
}

/** Collapse this far toward the origin in one shot is a remount/native snap, not a drag. */
const HOST_SCROLL_DROP_PX = 1;

/** Live nested-scroll snapshot for `host` inside `root`, or null if it is not a host. */
export function hostScrollSnapshotOf(
  host: HTMLElement,
  root: ParentNode | null | undefined,
): HostScrollSnapshot | null {
  if (!root) return null;
  const docs = root.querySelectorAll(DOC_PAGE_SELECTOR);
  for (let i = 0; i < docs.length; i++) {
    const node = docs[i];
    if (node !== host && !node.contains(host)) continue;
    const key = hostKeyInDoc(host, node);
    if (key == null) continue;
    return { doc: i, key, left: host.scrollLeft, top: host.scrollTop };
  }
  return null;
}

/**
 * Prefer the last settled nested scroll when the live host has jumped toward 0.
 *
 * Pointerdown can already see `scrollLeft === 0` after a remount or Direct
 * Manipulation snap; pinning that value then writes the jump in.
 */
export function pickSettledHostScroll(
  live: HostScrollSnapshot,
  remembered: HostScrollSnapshot | undefined,
): HostScrollSnapshot {
  if (!remembered || remembered.doc !== live.doc || remembered.key !== live.key) {
    return live;
  }
  return {
    ...live,
    left:
      remembered.left - live.left > HOST_SCROLL_DROP_PX ? remembered.left : live.left,
    top: remembered.top - live.top > HOST_SCROLL_DROP_PX ? remembered.top : live.top,
  };
}

export function upsertHostScrollSnapshot(
  list: readonly HostScrollSnapshot[],
  next: HostScrollSnapshot,
): HostScrollSnapshot[] {
  const out = list.filter((s) => s.doc !== next.doc || s.key !== next.key);
  out.push(next);
  return out;
}

/** For each host, keep the remembered place if live has collapsed toward 0. */
export function mergeHostScrollSnapshots(
  remembered: readonly HostScrollSnapshot[],
  live: readonly HostScrollSnapshot[],
): HostScrollSnapshot[] {
  const map = new Map<string, HostScrollSnapshot>();
  for (const s of live) map.set(`${s.doc}:${s.key}`, s);
  for (const s of remembered) {
    const k = `${s.doc}:${s.key}`;
    const now = map.get(k);
    map.set(k, now ? pickSettledHostScroll(now, s) : s);
  }
  return [...map.values()];
}

export function restoreDroppedHostScroll(
  root: ParentNode | null | undefined,
  remembered: readonly HostScrollSnapshot[],
): void {
  if (!root || remembered.length === 0) return;
  const live = snapshotHostScrollIn(root);
  const liveOf = new Map(live.map((s) => [`${s.doc}:${s.key}`, s] as const));
  const pins = remembered.filter((r) => {
    const now = liveOf.get(`${r.doc}:${r.key}`);
    if (!now) return true;
    return (
      r.left - now.left > HOST_SCROLL_DROP_PX || r.top - now.top > HOST_SCROLL_DROP_PX
    );
  });
  restoreHostScrollIn(root, pins);
}

/** Input hot path: the observer already indexed these elements. Do not
 * rediscover every fence (and read computed styles) for each letter/sample. */
export function restoreListedHostScroll(
  hosts: readonly NestedScrollHost[],
  remembered: readonly HostScrollSnapshot[],
  pin: HostScrollSnapshot | null,
  freeze = false,
): HTMLElement | null {
  const saved = new Map(remembered.map(pos => [`${pos.doc}:${pos.key}`, pos]));
  let pinned: HTMLElement | null = null;
  for (const host of hosts) {
    if (!host.el.isConnected) continue;
    const isPin = pin?.doc === host.doc && pin.key === host.key;
    const pos = isPin ? pin : saved.get(`${host.doc}:${host.key}`);
    if (!pos) continue;
    if (isPin) pinned = host.el;
    if (isPin || freeze ? host.el.scrollLeft !== pos.left : pos.left - host.el.scrollLeft > HOST_SCROLL_DROP_PX) host.el.scrollLeft = pos.left;
    if (isPin || freeze ? host.el.scrollTop !== pos.top : pos.top - host.el.scrollTop > HOST_SCROLL_DROP_PX) host.el.scrollTop = pos.top;
  }
  return pinned;
}

export function snapshotListedHostScroll(hosts: readonly NestedScrollHost[]): HostScrollSnapshot[] {
  return hosts.filter(host => host.el.isConnected).map(({ el, doc, key }) =>
    ({ doc, key, left: el.scrollLeft, top: el.scrollTop }));
}

/** Toolbar/HUD mutations must not invalidate the document host index. */
export function mutationAffectsScrollHosts(records: readonly MutationRecord[]): boolean {
  const inDocument = (node: Node): boolean => {
    const el = node.nodeType === 1 ? node as Element : node.parentElement;
    return Boolean(el?.closest(DOC_PAGE_SELECTOR));
  };
  const containsDocument = (node: Node): boolean => node.nodeType === 1 &&
    Boolean((node as Element).matches(DOC_PAGE_SELECTOR) || (node as Element).querySelector(DOC_PAGE_SELECTOR));
  return records.some(record => inDocument(record.target) ||
    [...record.addedNodes, ...record.removedNodes].some(containsDocument));
}

/** Write `pin` onto the current host for that key (survives React replacing the node). */
export function pinHostScrollSnapshot(
  root: ParentNode | null | undefined,
  pin: HostScrollSnapshot | null | undefined,
): HTMLElement | null {
  if (!root || !pin) return null;
  restoreHostScrollIn(root, [pin]);
  const doc = root.querySelectorAll(DOC_PAGE_SELECTOR)[pin.doc];
  if (!doc) return null;
  return scrollHostsIn(doc)[pin.key] ?? null;
}

/**
 * Scene-space host lookup for export / offscreen paint.
 *
 * Maps each host's visible CSS box into {@link pageBounds} using the content
 * slot's on-screen size (CSS pixels per scene unit ≈ camera zoom).
 */
export function scrollHostLookupFromSlot(
  slot: HTMLElement | null | undefined,
  pageBounds: SceneBounds | null | undefined,
): Map<number, { bounds: SceneBounds; scrollLeft: number; scrollTop: number }> | null {
  if (!slot || !pageBounds) return null;
  const pageW = pageBounds.maxX - pageBounds.minX;
  const pageH = pageBounds.maxY - pageBounds.minY;
  if (pageW <= 0 || pageH <= 0) return null;
  const slotRect = slot.getBoundingClientRect();
  if (slotRect.width < 1 || slotRect.height < 1) return null;
  const sx = slotRect.width / pageW;
  const sy = slotRect.height / pageH;
  const map = new Map<number, { bounds: SceneBounds; scrollLeft: number; scrollTop: number }>();
  for (const doc of slot.querySelectorAll(DOC_PAGE_SELECTOR)) {
    scrollHostsIn(doc).forEach((el, key) => {
      const r = el.getBoundingClientRect();
      map.set(key, {
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
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
