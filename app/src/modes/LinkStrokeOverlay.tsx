/**
 * Drawing a link with the pen.
 *
 * A stroke from a mark to a target, which commits an edge and then vanishes.
 * Deliberately *not* ink: nothing is written to `RasterInkLayer` and no
 * Excalidraw arrow is created, because the line is a gesture rather than
 * something the reader drew on the page. Deleting the link later must not
 * leave a stray squiggle behind, and it cannot if the squiggle never existed.
 *
 * The overlay takes the pointer for the whole gesture, which is also how the
 * pen is kept from recording underneath it — the ink layer simply never sees
 * the events.
 *
 * Two kinds of target. Marks already on this page are certain: the reader can
 * see them. Retrieval chips are guesses from `docs.db`, offered because a long
 * document's other mentions of a thing are the hard ones to find. A chip is a
 * magnet, never an edge on its own — committing is always a pointer-up on it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface LinkChip {
  /** Stable within one drag — a footnote id, or `chunk:{page}:{index}`. */
  id: string;
  label: string;
  /** What the reader is told this is: a mark they made, or a suggestion. */
  kind: "mark" | "suggestion";
  /** Viewport coordinates of the chip's anchor. */
  x: number;
  y: number;
}

export interface LinkStrokeOverlayProps {
  /** Marks on the page, as possible origins and targets. */
  marks: readonly LinkChip[];
  /** Ask the harness what else in this document is about the origin. */
  onSuggest: (originId: string) => Promise<LinkChip[]>;
  /** Pointer-up landed on a target. */
  onCommit: (originId: string, target: LinkChip) => void;
  /** The gesture ended with nothing under it. */
  onCancel: () => void;
  /** Say why a press did not start a link. */
  onNotice: (message: string) => void;
}

/** Below this, the gesture was a tap that wandered — not a link. */
export const MIN_LINK_SPAN = 24;

/** How near a chip's centre a pointer-up counts as landing on it. */
export const CHIP_HIT_RADIUS = 34;

export function nearestChip(
  chips: readonly LinkChip[],
  x: number,
  y: number,
  radius = CHIP_HIT_RADIUS,
): LinkChip | null {
  let best: LinkChip | null = null;
  let bestDistance = radius * radius;
  for (const chip of chips) {
    const dx = chip.x - x;
    const dy = chip.y - y;
    const distance = dx * dx + dy * dy;
    // Strictly nearer to displace the incumbent, so a tie goes to whichever
    // was listed first. That matters: marks are passed ahead of suggestions,
    // and a mark the reader can see should beat a guess at the same distance.
    const better = best === null ? distance <= bestDistance : distance < bestDistance;
    if (!better) continue;
    best = chip;
    bestDistance = distance;
  }
  return best;
}

export function spanOf(points: ReadonlyArray<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return Math.hypot(last.x - first.x, last.y - first.y);
}

/**
 * Which mark a press landed on, by hit-testing *through* the overlay.
 *
 * `elementFromPoint` would return the overlay itself, so it is made
 * transparent to hit-testing for the length of the call.
 */
export function markUnder(x: number, y: number, overlay: HTMLElement | null): string | null {
  const previous = overlay?.style.pointerEvents ?? "";
  if (overlay) overlay.style.pointerEvents = "none";
  const node = document.elementFromPoint(x, y);
  if (overlay) overlay.style.pointerEvents = previous;
  const mark = node?.closest?.("[data-lc-id]") as HTMLElement | null;
  return mark?.dataset.lcId ?? null;
}

export function LinkStrokeOverlay({
  marks,
  onSuggest,
  onCommit,
  onCancel,
  onNotice,
}: LinkStrokeOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [points, setPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [chips, setChips] = useState<LinkChip[]>([]);

  const reset = useCallback(() => {
    setOrigin(null);
    setPoints([]);
    setChips([]);
  }, []);

  // Escape means "never mind" — the same as letting go over empty paper.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      reset();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, reset]);

  const targets = chips.filter((chip) => chip.id !== origin);

  return (
    <div
      ref={hostRef}
      className="lc-link-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const from = markUnder(event.clientX, event.clientY, hostRef.current);
        if (!from) {
          onNotice("Start a link on a mark.");
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        setOrigin(from);
        setPoints([{ x: event.clientX, y: event.clientY }]);
        // Marks are certain and instant; suggestions arrive when they arrive.
        setChips(marks.filter((mark) => mark.id !== from));
        void onSuggest(from)
          .then((extra) => {
            setChips((current) => (current.length === 0 ? current : [...current, ...extra]));
          })
          .catch(() => {});
      }}
      onPointerMove={(event) => {
        if (!origin) return;
        setPoints((current) => [...current, { x: event.clientX, y: event.clientY }]);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const from = origin;
        const path = [...points, { x: event.clientX, y: event.clientY }];
        const landed = nearestChip(targets, event.clientX, event.clientY);
        reset();
        // A short path is a tap that wandered, not a link — and a landing on
        // nothing is a link the reader started and thought better of.
        if (!from || spanOf(path) < MIN_LINK_SPAN || !landed) {
          onCancel();
          return;
        }
        onCommit(from, landed);
      }}
      onPointerCancel={() => {
        reset();
        onCancel();
      }}
    >
      {origin && points.length > 1 && (
        <svg className="lc-link-stroke" aria-hidden>
          <polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} />
        </svg>
      )}
      {origin &&
        targets.map((chip) => (
          <span
            key={chip.id}
            className={`lc-link-chip is-${chip.kind}`}
            style={{ left: chip.x, top: chip.y }}
            aria-hidden
          >
            {chip.label}
          </span>
        ))}
    </div>
  );
}
