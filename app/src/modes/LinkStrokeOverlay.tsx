/**
 * Drawing a link with the pen.
 *
 * Circle or scribble a mark / image / drawing (high-contrast stroke, not ink).
 * Then draw a stroke connecting two picks. The polyline confirms and fades —
 * deleting the graph edge later must not leave a squiggle.
 *
 * The overlay takes the pointer so RasterInkLayer never records the gesture.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { hitToChip, nearestHit, pickBestHit, pickLoopTarget, type LinkHit } from "./linkHitTest";
import {
  CHIP_HIT_RADIUS,
  MIN_LINK_SPAN,
  classifyStroke,
  boxCenter,
  pathBox,
  pathLength,
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
  /** Pointer-up landed on a target. `origin` carries the first pick's label. */
  onCommit: (originId: string, target: LinkChip, origin?: LinkChip) => void;
  /** Escape — leave the tool. Missed strokes stay armed. */
  onCancel: () => void;
  /**
   * Formerly: say why a press did not start a link. Kept for callers; the
   * reason now shows in the overlay's hint pill so failed strokes never
   * stack notification cards.
   */
  onNotice?: (message: string) => void;
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

/**
 * The words a loop drew around, for naming a text snippet.
 *
 * The hit-test only knows a box, so a circled passage used to be called
 * "selection" and the notice read `Linked "snippet:10:102" to "selection"`.
 * Read the text nodes whose boxes sit mostly inside the loop instead.
 */
export function textUnder(box: StrokeBox, overlay: HTMLElement | null): string {
  if (typeof document === "undefined") return "";
  const words: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (overlay?.contains(node) || !node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx >= box.left && cx <= box.left + box.width && cy >= box.top && cy <= box.top + box.height) {
        words.push(node.textContent.trim());
        break;
      }
    }
    if (words.join(" ").length > 60) break;
  }
  const text = words.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

function chipBox(chip: LinkChip): StrokeBox {
  if (chip.box) return chip.box;
  return { left: chip.x - 20, top: chip.y - 20, width: 40, height: 40 };
}

function facingPoint(box: StrokeBox, other: StrokeBox): StrokePoint {
  const center = boxCenter(box);
  const target = boxCenter(other);
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  return Math.abs(dx) > Math.abs(dy)
    ? { x: center.x + (dx > 0 ? box.width / 2 : -box.width / 2), y: center.y }
    : { x: center.x, y: center.y + (dy > 0 ? box.height / 2 : -box.height / 2) };
}

function pathMidpoint(path: readonly StrokePoint[]): StrokePoint {
  let remaining = pathLength(path) / 2;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > 0 && remaining <= length) {
      const fraction = remaining / length;
      return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
    }
    remaining -= length;
  }
  return path[0]!;
}

interface ConnectorPair {
  from: LinkChip;
  to: LinkChip;
  targetId: string;
}

interface StrokeFeedback {
  kind: "confirm" | "miss";
  fading: boolean;
  pair?: ConnectorPair;
}

export function LinkStrokeOverlay({
  marks,
  onSuggest,
  onResolve,
  onCommit,
  onCancel,
}: LinkStrokeOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** A chip for a pick; a plain-text snippet is named by the words it circles. */
  const chipFor = (hit: LinkHit) => {
    const chip = hitToChip(hit);
    if (hit.kind === "snippet" && hit.label === "selection") {
      chip.label = textUnder(hit, hostRef.current) || "a passage";
    }
    return chip;
  };
  const [picks, setPicks] = useState<LinkChip[]>([]);
  const [points, setPoints] = useState<StrokePoint[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [chips, setChips] = useState<LinkChip[]>([]);
  const [readyPair, setReadyPair] = useState<ConnectorPair | null>(null);
  const [feedback, setFeedback] = useState<StrokeFeedback | null>(null);
  const pathRef = useRef<StrokePoint[]>([]);
  const drawingRef = useRef(false);
  const lockedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** One preview per frame: a pen sends far more moves than the screen shows. */
  const frameRef = useRef<number | null>(null);
  /** Why a stroke did not count, shown in the hint pill instead of stacking notices. */
  const [hintNote, setHintNote] = useState<string | null>(null);
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const note = (message: string) => {
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    setHintNote(message);
    noteTimerRef.current = setTimeout(() => setHintNote(null), 2500);
  };
  const suggestionGeneration = useRef(0);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => () => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    clearTimer();
    suggestionGeneration.current++;
  }, [clearTimer]);

  const resetStroke = useCallback(() => {
    pathRef.current = [];
    drawingRef.current = false;
    setPoints([]);
    setDrawing(false);
    setReadyPair(null);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      clearTimer();
      lockedRef.current = false;
      suggestionGeneration.current++;
      setFeedback(null);
      setPicks([]);
      setChips([]);
      resetStroke();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, resetStroke, clearTimer]);

  const hostOrigin = (): StrokePoint => {
    const box = hostRef.current?.getBoundingClientRect();
    return { x: box?.left ?? 0, y: box?.top ?? 0 };
  };

  const finishStroke = (path: StrokePoint[], pair: ConnectorPair | null) => {
    clearTimer();
    drawingRef.current = false;
    setDrawing(false);
    setReadyPair(null);
    setPoints(path);
    const kind = pair ? "confirm" : "miss";
    setFeedback({ kind, fading: false, pair: pair ?? undefined });
    lockedRef.current = !!pair;
    const finish = () => {
      timerRef.current = null;
      lockedRef.current = false;
      setFeedback(null);
      resetStroke();
      if (pair) {
        suggestionGeneration.current++;
        setPicks([]);
        setChips([]);
        onCommitRef.current(pair.from.id, pair.to, pair.from);
      }
    };
    timerRef.current = setTimeout(() => {
      if (reducedMotion) {
        finish();
      } else {
        setFeedback({ kind, fading: true, pair: pair ?? undefined });
        timerRef.current = setTimeout(finish, 300);
      }
    }, pair ? 450 : 250);
  };

  const addPick = (chip: LinkChip) => {
    if (picks.some((entry) => entry.id === chip.id)) return;
    const next = picks.length === 0 ? [chip] : [picks[0]!, chip];
    setPicks(next);
    if (picks.length === 0) {
      const generation = ++suggestionGeneration.current;
      setChips(marks.filter((mark) => mark.id !== chip.id));
      void onSuggest(chip.id)
        .then((extra) => {
          if (suggestionGeneration.current !== generation) return;
          setChips((live) => [...live, ...extra]);
        })
        .catch(() => {});
    }
  };

  // The preview and release use exactly the same classification and hit rules.
  /**
   * The green "release now" preview, run at most once a frame while drawing.
   *
   * Geometry only, against the A/B boxes and the suggestion chips already on
   * screen. The full `resolveConnector` (page hit-testing, text labels) runs
   * once on release; running it per pointer move lagged the pen badly.
   */
  const previewConnector = (path: readonly StrokePoint[]): ConnectorPair | null => {
    if (path.length < 2) return null;
    const start = path[0]!;
    const end = path[path.length - 1]!;
    if (Math.hypot(end.x - start.x, end.y - start.y) < MIN_LINK_SPAN) return null;
    if (picks.length >= 2) {
      const a = picks[0]!;
      const b = picks[1]!;
      const startOnA = pointNearBox(start, chipBox(a));
      const startOnB = pointNearBox(start, chipBox(b));
      if (startOnA && pointNearBox(end, chipBox(b))) return { from: a, to: b, targetId: b.id };
      if (startOnB && pointNearBox(end, chipBox(a))) return { from: a, to: b, targetId: a.id };
      return null;
    }
    if (picks.length === 1) {
      const origin = picks[0]!;
      if (!pointNearBox(start, chipBox(origin), 52)) return null;
      const landed = nearestChip(chips, end.x, end.y);
      return landed && landed.id !== origin.id ? { from: origin, to: landed, targetId: landed.id } : null;
    }
    return null;
  };

  const resolveConnector = (path: readonly StrokePoint[]): { pair: ConnectorPair | null; notice?: string } => {
    if (classifyStroke(path) !== "connector") return { pair: null };
    const start = path[0]!;
    const end = path[path.length - 1]!;
    const suggestionHits: LinkHit[] = chips.map((chip) => ({
      id: chip.id,
      label: chip.label,
      kind: chip.hitKind ?? (chip.kind === "mark" ? "mark" : "snippet"),
      ...chipBox(chip),
    }));
    const pickHits: LinkHit[] = picks.map((chip) => ({
      id: chip.id,
      label: chip.label,
      kind: chip.hitKind ?? "mark",
      ...chipBox(chip),
    }));
    const pairOf = (from: LinkChip, to: LinkChip, targetId = to.id) =>
      from.id === to.id
        ? { pair: null, notice: "Circle a second target, then stroke between them." }
        : { pair: { from, to, targetId } };

    if (picks.length >= 2) {
      const a = picks[0]!;
      const b = picks[1]!;
      const startOnA = pointNearBox(start, chipBox(a));
      const startOnB = pointNearBox(start, chipBox(b));
      const endOnA = pointNearBox(end, chipBox(a));
      const endOnB = pointNearBox(end, chipBox(b));
      if ((startOnA && endOnB) || (startOnB && endOnA)) {
        return pairOf(a, b, startOnA && endOnB ? b.id : a.id);
      }
    }

    if (picks.length === 1) {
      const origin = picks[0]!;
      if (!pointNearBox(start, chipBox(origin), 52)) {
        return { pair: null, notice: "Start the connecting stroke on the circled target." };
      }
      const landed = nearestChip(chips, end.x, end.y) ?? (() => {
        const hit = nearestHit([...pickHits, ...suggestionHits], end);
        return hit ? chipFor(hit) : null;
      })();
      const resolved = landed ?? (() => {
        const box = { left: end.x - 24, top: end.y - 24, width: 48, height: 48 };
        const hit = pickBestHit(onResolve(box, hostRef.current), box);
        return hit && hit.id !== origin.id ? chipFor(hit) : null;
      })();
      return resolved
        ? pairOf(origin, resolved)
        : { pair: null, notice: "Land on a second circled target, mark, or suggestion." };
    }

    const startHit = nearestHit(onResolve({ left: start.x - 20, top: start.y - 20, width: 40, height: 40 }, hostRef.current), start);
    const endHit = nearestHit(onResolve({ left: end.x - 20, top: end.y - 20, width: 40, height: 40 }, hostRef.current), end);
    if (startHit && endHit && startHit.id !== endHit.id) {
      return pairOf(chipFor(startHit), chipFor(endHit));
    }
    return { pair: null, notice: "Circle two targets, then stroke between them." };
  };

  const visibleChips = chips.filter((chip) => !picks.some((pick) => pick.id === chip.id));
  const displayPair = feedback?.pair ?? readyPair;
  const displayPicks = displayPair && (feedback?.pair || picks.length < 2)
    ? [displayPair.from, displayPair.to] : picks;
  const hint = hintNote ?? (picks.length === 0 ? "Circle the first thing"
    : picks.length === 2 ? "Draw a line from A to B"
    : visibleChips.some((chip) => chip.kind === "suggestion")
      ? "Circle the second thing — or draw to a suggestion" : "Circle the second thing");
  const midpoint = feedback?.kind === "confirm" ? pathMidpoint(points) : null;

  return (
    <div
      ref={hostRef}
      className={`lc-link-overlay${readyPair ? " is-ready" : ""}${feedback ? ` is-${feedback.kind}` : ""}${feedback?.fading ? " is-fading" : ""}${reducedMotion ? " is-reduced-motion" : ""}`}
      role="presentation"
      onPointerDown={(event) => {
        if (event.button !== 0 || lockedRef.current) return;
        clearTimer();
        setFeedback(null);
        setReadyPair(null);
        event.currentTarget.setPointerCapture(event.pointerId);
        drawingRef.current = true;
        setDrawing(true);
        pathRef.current = [{ x: event.clientX, y: event.clientY }];
        setPoints(pathRef.current);
      }}
      onPointerMove={(event) => {
        if (!drawingRef.current || lockedRef.current) return;
        const path = [...pathRef.current, { x: event.clientX, y: event.clientY }];
        pathRef.current = path;
        setPoints(path);
        if (frameRef.current == null) {
          frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            const next = previewConnector(pathRef.current);
            setReadyPair((current) =>
              current?.from.id === next?.from.id && current?.to.id === next?.to.id ? current : next);
          });
        }
      }}
      onPointerUp={(event) => {
        if (!drawingRef.current || lockedRef.current) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const path = [...pathRef.current, { x: event.clientX, y: event.clientY }];
        const kind = classifyStroke(path);
        const end = path[path.length - 1]!;

        if (kind === "loop" || kind === "scribble") {
          const box = pathBox(path);
          if (!box) return;
          const hit = pickLoopTarget(onResolve(box, hostRef.current), box);
          if (!hit) {
            note("Circle a mark, image, or drawing.");
            finishStroke(path, null);
            return;
          }
          resetStroke();
          addPick(chipFor(hit));
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
            resetStroke();
            addPick(chip);
            return;
          }
          if (picks.length === 0) {
            note("Circle a mark, image, or drawing — then stroke to connect.");
          }
          finishStroke(path, null);
          return;
        }

        const result = resolveConnector(path);
        if (result.notice) note(result.notice);
        finishStroke(path, result.pair);
      }}
      onPointerCancel={() => {
        if (lockedRef.current) return;
        resetStroke();
      }}
    >
      <span className="lc-link-hint" role="status" aria-live="polite">{hint}</span>
      {readyPair && <span className="lc-link-ready" aria-hidden>Release now</span>}
      {displayPicks.map((chip, index) => {
        const box = chipBox(chip);
        const other = displayPicks[1 - index];
        const dot = other ? facingPoint(box, chipBox(other)) : null;
        return (
          <span
            key={`pick-${chip.id}`}
            className={`lc-link-pick is-${index === 0 ? "a" : "b"} is-${chip.hitKind ?? chip.kind}${readyPair?.targetId === chip.id ? " is-target" : ""}`}
            data-pick-id={chip.id}
            style={{
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
            }}
            aria-hidden
          >
            <span className="lc-link-badge">{index === 0 ? "A" : "B"}</span>
            {dot && <span className="lc-link-dot" style={{ left: dot.x - box.left, top: dot.y - box.top }} />}
          </span>
        );
      })}
      {(drawing || feedback) && points.length > 1 && (() => {
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
      {midpoint && <span className="lc-link-confirm" style={{ left: midpoint.x, top: midpoint.y }} aria-hidden>✓</span>}
      {picks.length > 0 &&
        visibleChips
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
