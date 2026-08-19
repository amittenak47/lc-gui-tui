/**
 * Drawing a link with the pen.
 *
 * Circle or scribble a mark / image / drawing (high-contrast stroke, not ink).
 * Then draw a stroke connecting two picks. The polyline vanishes on lift —
 * deleting the graph edge later must not leave a squiggle.
 *
 * The overlay takes the pointer so RasterInkLayer never records the gesture.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { hitToChip, nearestHit, pickBestHit, type LinkHit } from "./linkHitTest";
import {
  CHIP_HIT_RADIUS,
  MIN_LINK_SPAN,
  classifyStroke,
  pathBox,
  pointNearBox,
  spanOf,
  type StrokeBox,
  type StrokePoint,
} from "./linkStroke";

export type { LinkHitKind } from "./linkHitTest";

export interface LinkChip {
  /** Stable within one drag — a footnote id, or `chunk:{page}:{index}`. */
  id: string;
  label: string;
  /** What the reader is told this is: a mark they made, or a suggestion. */
  kind: "mark" | "suggestion";
  /** Viewport coordinates of the chip's anchor. */
  x: number;
  y: number;
  hitKind?: "mark" | "image" | "drawing" | "snippet";
  box?: StrokeBox;
}

export interface LinkStrokeOverlayProps {
  /** Marks on the page, as possible origins and targets. */
  marks: readonly LinkChip[];
  /** Ask the harness what else in this document is about the origin. */
  onSuggest: (originId: string) => Promise<LinkChip[]>;
  /** Resolve what a loop covers (marks, images, drawings, snippet). */
  onResolve: (box: StrokeBox, overlay: HTMLElement | null) => LinkHit[];
  /** Pointer-up landed on a target. */
  onCommit: (originId: string, target: LinkChip) => void;
  /** Escape — leave the tool. Missed strokes stay armed. */
  onCancel: () => void;
  /** Say why a press did not start a link. */
  onNotice: (message: string) => void;
}

export { CHIP_HIT_RADIUS, MIN_LINK_SPAN, spanOf };

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
    const better = best === null ? distance <= bestDistance : distance < bestDistance;
    if (!better) continue;
    best = chip;
    bestDistance = distance;
  }
  return best;
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

function chipBox(chip: LinkChip): StrokeBox {
  if (chip.box) return chip.box;
  return { left: chip.x - 20, top: chip.y - 20, width: 40, height: 40 };
}

export function LinkStrokeOverlay({
  marks,
  onSuggest,
  onResolve,
  onCommit,
  onCancel,
  onNotice,
}: LinkStrokeOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [picks, setPicks] = useState<LinkChip[]>([]);
  const [points, setPoints] = useState<StrokePoint[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [chips, setChips] = useState<LinkChip[]>([]);

  const resetStroke = useCallback(() => {
    setPoints([]);
    setDrawing(false);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPicks([]);
      setChips([]);
      resetStroke();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, resetStroke]);

  const hostOrigin = (): StrokePoint => {
    const box = hostRef.current?.getBoundingClientRect();
    return { x: box?.left ?? 0, y: box?.top ?? 0 };
  };

  const commitPair = (from: LinkChip, to: LinkChip) => {
    if (from.id === to.id) {
      onNotice("Circle a second target, then stroke between them.");
      return;
    }
    onCommit(from.id, to);
    setPicks([]);
    setChips([]);
  };

  const addPick = (chip: LinkChip) => {
    setPicks((current) => {
      if (current.some((entry) => entry.id === chip.id)) return current;
      const next = [...current, chip].slice(-2);
      if (next.length === 1) {
        setChips(marks.filter((mark) => mark.id !== chip.id));
        void onSuggest(chip.id)
          .then((extra) => {
            setChips((live) => [...live, ...extra]);
          })
          .catch(() => {});
      }
      return next;
    });
  };

  return (
    <div
      ref={hostRef}
      className="lc-link-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrawing(true);
        setPoints([{ x: event.clientX, y: event.clientY }]);
      }}
      onPointerMove={(event) => {
        if (!drawing) return;
        setPoints((current) => [...current, { x: event.clientX, y: event.clientY }]);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const path = [...points, { x: event.clientX, y: event.clientY }];
        resetStroke();
        const kind = classifyStroke(path);
        const start = path[0]!;
        const end = path[path.length - 1]!;

        if (kind === "loop" || kind === "scribble") {
          const box = pathBox(path);
          if (!box) return;
          const hit = pickBestHit(onResolve(box, hostRef.current), box);
          if (!hit) {
            onNotice("Circle a mark, image, or drawing.");
            return;
          }
          addPick(hitToChip(hit));
          return;
        }

        if (kind === "tap") {
          const fromMark = markUnder(end.x, end.y, hostRef.current);
          if (fromMark) {
            const chip =
              marks.find((entry) => entry.id === fromMark) ??
              ({
                id: fromMark,
                label: "mark",
                kind: "mark" as const,
                x: end.x,
                y: end.y,
                hitKind: "mark" as const,
              } satisfies LinkChip);
            addPick(chip);
            return;
          }
          if (picks.length === 0) {
            onNotice("Circle a mark, image, or drawing — then stroke to connect.");
          }
          return;
        }

        // Connector.
        const suggestionHits: LinkHit[] = chips.map((chip) => ({
          id: chip.id,
          label: chip.label,
          kind: chip.hitKind ?? (chip.kind === "mark" ? "mark" : "snippet"),
          left: chipBox(chip).left,
          top: chipBox(chip).top,
          width: chipBox(chip).width,
          height: chipBox(chip).height,
        }));
        const pickHits: LinkHit[] = picks.map((chip) => ({
          id: chip.id,
          label: chip.label,
          kind: chip.hitKind ?? "mark",
          ...chipBox(chip),
        }));

        if (picks.length >= 2) {
          const a = picks[0]!;
          const b = picks[1]!;
          const startOnA = pointNearBox(start, chipBox(a));
          const startOnB = pointNearBox(start, chipBox(b));
          const endOnA = pointNearBox(end, chipBox(a));
          const endOnB = pointNearBox(end, chipBox(b));
          if ((startOnA && endOnB) || (startOnB && endOnA)) {
            commitPair(a, b);
            return;
          }
        }

        if (picks.length === 1) {
          const origin = picks[0]!;
          if (!pointNearBox(start, chipBox(origin), 52)) {
            onNotice("Start the connecting stroke on the circled target.");
            return;
          }
          const landed =
            nearestChip(chips, end.x, end.y) ??
            (() => {
              const hit = nearestHit([...pickHits, ...suggestionHits], end);
              return hit ? hitToChip(hit) : null;
            })();
          const resolved =
            landed ??
            (() => {
              const box = { left: end.x - 24, top: end.y - 24, width: 48, height: 48 };
              const hit = pickBestHit(onResolve(box, hostRef.current), box);
              return hit && hit.id !== origin.id ? hitToChip(hit) : null;
            })();
          if (!resolved) {
            onNotice("Land on a second circled target, mark, or suggestion.");
            return;
          }
          commitPair(origin, resolved);
          return;
        }

        const startHit = nearestHit(onResolve({ left: start.x - 20, top: start.y - 20, width: 40, height: 40 }, hostRef.current), start);
        const endHit = nearestHit(onResolve({ left: end.x - 20, top: end.y - 20, width: 40, height: 40 }, hostRef.current), end);
        if (startHit && endHit && startHit.id !== endHit.id) {
          commitPair(hitToChip(startHit), hitToChip(endHit));
          return;
        }
        onNotice("Circle two targets, then stroke between them.");
      }}
      onPointerCancel={() => {
        resetStroke();
      }}
    >
      {picks.map((chip) => {
        const box = chipBox(chip);
        return (
          <span
            key={`pick-${chip.id}`}
            className={`lc-link-pick is-${chip.hitKind ?? chip.kind}`}
            style={{
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
            }}
            aria-hidden
          />
        );
      })}
      {drawing && points.length > 1 && (() => {
        const origin = hostOrigin();
        return (
          <svg className="lc-link-stroke" aria-hidden>
            <polyline
              points={points
                .map((point) => `${point.x - origin.x},${point.y - origin.y}`)
                .join(" ")}
            />
          </svg>
        );
      })()}
      {picks.length > 0 &&
        chips
          .filter((chip) => !picks.some((pick) => pick.id === chip.id))
          .map((chip) => (
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
