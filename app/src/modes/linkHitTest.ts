/**
 * What a link-tool loop landed on: a mark, an image, a drawing, or the loop
 * itself as a page snippet.
 *
 * Prefer the smallest thing the loop actually covers. A page-sized wrapper
 * must not win over a figure inside it — that is how the old tool washed the
 * whole paper.
 */

import type { StrokeBox, StrokePoint } from "./linkStroke";
import { CHIP_HIT_RADIUS, boxCenter } from "./linkStroke";
import { isPageCoverRect } from "../util/docMarquee";

export type LinkHitKind = "mark" | "image" | "drawing" | "snippet";

export interface LinkHit {
  id: string;
  label: string;
  kind: LinkHitKind;
  left: number;
  top: number;
  width: number;
  height: number;
}

const KIND_RANK: Record<LinkHitKind, number> = {
  mark: 0,
  image: 1,
  drawing: 2,
  snippet: 3,
};

export function boxesOverlap(
  a: StrokeBox,
  b: { left: number; top: number; width: number; height: number },
): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

export function intersectionArea(
  a: StrokeBox,
  b: { left: number; top: number; width: number; height: number },
): number {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * Smallest overlapping target, marks beating images beating drawings.
 *
 * Coverage under 12% of the hit is a graze, not a pick — circling next to a
 * chip must not steal it. Snippet (the loop box) is last resort when nothing
 * else fits.
 */
export function pickBestHit(hits: readonly LinkHit[], loop: StrokeBox): LinkHit | null {
  const loopArea = Math.max(1, loop.width * loop.height);
  let best: LinkHit | null = null;
  let bestRank = 99;
  let bestArea = Infinity;
  for (const hit of hits) {
    if (hit.kind === "snippet") continue;
    const inter = intersectionArea(loop, hit);
    if (inter <= 0) continue;
    const hitArea = Math.max(1, hit.width * hit.height);
    if (inter / hitArea < 0.12 && inter / loopArea < 0.12) continue;
    const rank = KIND_RANK[hit.kind];
    if (rank > bestRank) continue;
    if (rank === bestRank && hitArea >= bestArea) continue;
    best = hit;
    bestRank = rank;
    bestArea = hitArea;
  }
  if (best) return best;
  return (
    hits.find((hit) => hit.kind === "snippet") ?? {
      id: `snippet:${Math.round(loop.left)}:${Math.round(loop.top)}`,
      label: "selection",
      kind: "snippet",
      ...loop,
    }
  );
}

/** True when the hit's center is inside the loop, or most of its area is. */
export function hitMostlyInside(
  hit: LinkHit,
  loop: StrokeBox,
  fraction = 0.5,
): boolean {
  const inter = intersectionArea(loop, hit);
  if (inter <= 0) return false;
  const hitArea = Math.max(1, hit.width * hit.height);
  const center = boxCenter(hit);
  const centerIn =
    center.x >= loop.left &&
    center.x <= loop.left + loop.width &&
    center.y >= loop.top &&
    center.y <= loop.top + loop.height;
  return centerIn || inter / hitArea >= fraction;
}

/**
 * Union of every `kind` hit that sits inside the loop — not nearest-only.
 *
 * Circling two drawings must make one snippet. Neighbours outside the box
 * stay out.
 */
export function groupHitsOfKind(
  hits: readonly LinkHit[],
  loop: StrokeBox,
  kind: LinkHitKind,
): LinkHit | null {
  const inside = hits.filter((hit) => hit.kind === kind && hitMostlyInside(hit, loop));
  if (inside.length < 2) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const ids: string[] = [];
  for (const hit of inside) {
    ids.push(hit.id);
    left = Math.min(left, hit.left);
    top = Math.min(top, hit.top);
    right = Math.max(right, hit.left + hit.width);
    bottom = Math.max(bottom, hit.top + hit.height);
  }
  ids.sort();
  const noun = kind === "drawing" ? "drawings" : kind === "mark" ? "marks" : kind;
  return {
    id: `group:${kind}:${ids.join("+")}`,
    label: `${inside.length} ${noun}`,
    kind: "snippet",
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/**
 * What a loop/scribble should pick.
 *
 * Two-plus drawings inside the box group into one snippet — unless a mark
 * is also inside, in which case the mark wins (do not swallow a footnote).
 * Otherwise the smallest overlapping target, same as {@link pickBestHit}.
 */
export function pickLoopTarget(hits: readonly LinkHit[], loop: StrokeBox): LinkHit | null {
  const markInside = hits.some((hit) => hit.kind === "mark" && hitMostlyInside(hit, loop));
  if (!markInside) {
    const grouped = groupHitsOfKind(hits, loop, "drawing");
    if (grouped) return grouped;
  }
  return pickBestHit(hits, loop);
}

export function nearestHit(
  hits: readonly LinkHit[],
  point: StrokePoint,
  radius = CHIP_HIT_RADIUS,
): LinkHit | null {
  let best: LinkHit | null = null;
  let bestDistance = radius * radius;
  for (const hit of hits) {
    const center = boxCenter(hit);
    const distance = (center.x - point.x) ** 2 + (center.y - point.y) ** 2;
    const better = best === null ? distance <= bestDistance : distance < bestDistance;
    if (!better) continue;
    best = hit;
    bestDistance = distance;
  }
  return best;
}

export function hitToChip(hit: LinkHit): {
  id: string;
  label: string;
  kind: "mark" | "suggestion";
  x: number;
  y: number;
  hitKind: LinkHitKind;
  box: StrokeBox;
} {
  return {
    id: hit.id,
    label: hit.label,
    kind: hit.kind === "mark" ? "mark" : "suggestion",
    x: hit.left + hit.width / 2,
    y: hit.top + hit.height / 2,
    hitKind: hit.kind,
    box: { left: hit.left, top: hit.top, width: hit.width, height: hit.height },
  };
}

/** Footnotes + document images under a loop. Overlay is made PE-none while querying. */
export function collectDomLinkHits(
  loop: StrokeBox,
  overlay: HTMLElement | null,
): LinkHit[] {
  const previous = overlay?.style.pointerEvents ?? "";
  if (overlay) overlay.style.pointerEvents = "none";
  try {
    const out: LinkHit[] = [];
    for (const node of document.querySelectorAll<HTMLElement>(".lc-doc-footnote[data-lc-id]")) {
      const id = node.dataset.lcId;
      if (!id) continue;
      const box = node.getBoundingClientRect();
      let left = box.left;
      let top = box.top;
      let right = box.right;
      let bottom = box.bottom;
      const pack = node.closest(".lc-doc-footnote-pack");
      const host = node.closest(".lc-doc-selectable-body");
      if (pack) {
        for (const band of pack.querySelectorAll(".lc-doc-footnote-band")) {
          const rect = band.getBoundingClientRect();
          if (
            host instanceof HTMLElement &&
            isPageCoverRect(
              { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              host,
            )
          ) {
            continue;
          }
          left = Math.min(left, rect.left);
          top = Math.min(top, rect.top);
          right = Math.max(right, rect.right);
          bottom = Math.max(bottom, rect.bottom);
        }
      }
      if (
        host instanceof HTMLElement &&
        isPageCoverRect({ left, top, right, bottom }, host)
      ) {
        left = box.left;
        top = box.top;
        right = box.right;
        bottom = box.bottom;
      }
      const hit: LinkHit = {
        id,
        label: (node.getAttribute("aria-label") ?? "mark").replace(/\s+—.*$/, "").slice(0, 28) || "mark",
        kind: "mark",
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
      };
      if (boxesOverlap(loop, hit)) out.push(hit);
    }
    for (const node of document.querySelectorAll<HTMLElement>(
      ".lc-page-content-slot img, .lc-page-content-slot figure, .lc-md-ink-doc img, .lc-web-doc img",
    )) {
      const box = node.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) continue;
      if (!boxesOverlap(loop, box)) continue;
      const alt = node.getAttribute("alt")?.trim();
      out.push({
        id: `image:${Math.round(box.left)}:${Math.round(box.top)}`,
        label: (alt || (node.tagName === "FIGURE" ? "figure" : "image")).slice(0, 28),
        kind: "image",
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      });
    }
    return out;
  } finally {
    if (overlay) overlay.style.pointerEvents = previous;
  }
}
