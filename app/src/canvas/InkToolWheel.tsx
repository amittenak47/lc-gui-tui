/**
 * Dual radial at the nib: outer tools, inner preset wedges, hub Confirm.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { MorphBar } from "../components/MorphBar";
import { HighlighterIcon, PenToolIcon, PinkEraserIcon } from "../components/MarkToolIcons";
import { HOLD_MS } from "../util/gesture";
import type { InkHandedness } from "../util/inkHandedness";
import {
  eraserWedgeFill,
  isEraserWedge,
  specCardSide,
  wedgeAt,
  wheelAutoApply,
  wheelConfirmEnabled,
  type InkPresetKind,
  type InkToolPresetStore,
  type InkWedgeSnapshot,
} from "../util/inkToolPresets";
import { clampWheelAnchor } from "./ColorRadial";

const WHEEL_R = 96;
const OUTER_INNER = 67;
const INNER_OUTER = 64;
const INNER_INNER = 28;
const VIEW_PAD = 12;
const CARD_W = 184;

const KINDS: InkPresetKind[] = ["pen", "highlighter", "eraser"];

function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + Math.sin(angle) * r, cy - Math.cos(angle) * r];
}

function donutSlice(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  a0: number,
  a1: number,
): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, outer, a0);
  const [x1, y1] = polar(cx, cy, outer, a1);
  const [x2, y2] = polar(cx, cy, inner, a1);
  const [x3, y3] = polar(cx, cy, inner, a0);
  return `M ${x0} ${y0} A ${outer} ${outer} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${inner} ${inner} 0 ${large} 0 ${x3} ${y3} Z`;
}

function buildSlices(count: number, handedness: InkHandedness) {
  const step = (Math.PI * 2) / count;
  const bias = handedness === "right" ? -step * 0.15 : step * 0.15;
  const start0 = -Math.PI + bias;
  return Array.from({ length: count }, (_, index) => {
    const start = start0 + step * index;
    const end = start + step;
    return { start, end, mid: (start + end) / 2 };
  });
}

function angleInWedge(a: number, start: number, end: number): boolean {
  const tau = Math.PI * 2;
  let x = a;
  while (x < start) x += tau;
  while (x >= start + tau) x -= tau;
  return x < end;
}

/** SVG-local coords, origin at wheel center, y down. Matches `polar()`. */
function innerWedgeIndexAt(
  lx: number,
  ly: number,
  slices: Array<{ start: number; end: number }>,
): number | null {
  const r = Math.hypot(lx, ly);
  if (r < INNER_INNER - 1 || r > INNER_OUTER + 1) return null;
  const a = Math.atan2(lx, -ly);
  for (let i = 0; i < slices.length; i++) {
    if (angleInWedge(a, slices[i].start, slices[i].end)) return i;
  }
  return null;
}

function localFromSvgPointer(event: React.PointerEvent<SVGElement>): { lx: number; ly: number } | null {
  const svg =
    event.currentTarget.ownerSVGElement ??
    (event.currentTarget as SVGSVGElement);
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0) return null;
  const scale = (WHEEL_R * 2) / rect.width;
  return {
    lx: (event.clientX - (rect.left + rect.width / 2)) * scale,
    ly: (event.clientY - (rect.top + rect.height / 2)) * scale,
  };
}

/**
 * Where the editor morphs out of when no wedge rect was captured: the hub.
 *
 * Measured rather than derived from {@link WHEEL_R}, because the dial is drawn
 * at `--lc-chrome-scale` and the rendered box is the only one that agrees with
 * the viewport coordinates a morph origin is in.
 */
function hubRectFallback(root: HTMLElement | null): DOMRect {
  const box = root?.getBoundingClientRect();
  const cx = (box?.left ?? 0) + (box?.width ?? WHEEL_R * 2) / 2;
  const cy = (box?.top ?? 0) + (box?.height ?? WHEEL_R * 2) / 2;
  return new DOMRect(cx - 16, cy - 16, 32, 32);
}

function wedgeFill(kind: InkPresetKind, snap: InkWedgeSnapshot | null): string {
  if (!snap) return "transparent";
  if (kind === "eraser" && isEraserWedge(snap)) return eraserWedgeFill(snap.eraserWidth);
  if (!isEraserWedge(snap)) return snap.colour;
  return "transparent";
}

function specRows(
  kind: InkPresetKind,
  snap: InkWedgeSnapshot | null,
): Array<{ label: string; value: string }> {
  if (!snap) {
    return [{ label: "Empty", value: "hold to fill" }];
  }
  if (kind === "eraser" && isEraserWedge(snap)) {
    return [
      { label: "Nib", value: String(Math.round(snap.eraserWidth)) },
      { label: "Eraser", value: snap.partialErase ? "Rub out" : "Whole stroke" },
    ];
  }
  if (isEraserWedge(snap)) return [{ label: "Name", value: snap.name }];
  return [
    { label: "Nib", value: String(snap.width) },
    { label: "Ink fullness", value: `${Math.round((snap.pressureSensitive ? snap.fullness : 1) * 100)}%` },
    { label: "Pressure", value: snap.pressureSensitive ? "On" : "Off" },
    { label: "Straight line", value: snap.straightInk ? "On" : "Off" },
    { label: "Speed ink", value: snap.speed === 0 ? "Off" : `${Math.round(snap.speed * 100)}%` },
    ...(snap.speed > 0
      ? [
          {
            label: "Body accent",
            value: (snap.body ?? 0) === 0 ? "Off" : `${Math.round((snap.body ?? 0) * 100)}%`,
          },
        ]
      : []),
    { label: "Speed fade", value: snap.fade === 0 ? "Off" : `${Math.round(snap.fade * 100)}%` },
    { label: "Speed blot", value: snap.blot === 0 ? "Off" : `${Math.round(snap.blot * 100)}%` },
    { label: "Ink boost", value: `${Math.round(snap.boldness * 100)}%` },
    {
      label: "Smoothing",
      value: snap.smoothing === 0 ? "Off" : `${Math.round(snap.smoothing * 100)}% ${snap.smoothingMode}`,
    },
  ];
}

/** Nib coords, or the drawable hole (canvas wrap minus the docked island). */
export type InkWheelAnchor = { x: number; y: number } | "canvas";

/**
 * Middle of the page the reader is on.
 *
 * `host` is the board that asked for the wheel. Without it this fell back to
 * `document.querySelector(".lc-canvas-wrap")`, which is the *first* pane in the
 * DOM — the left half of a split, or worse, a parked tab. A parked wrap is
 * `display: none`, so its rect is 0×0 and the centre of it is the origin: the
 * wheel appeared in the top-left corner of the window, half off screen, nowhere
 * near the page it belonged to.
 */
function measureCanvasDial(host?: HTMLElement | null): { x: number; y: number } {
  const owned = host?.closest(".lc-canvas-wrap") ?? host ?? null;
  const ownedBox = owned instanceof HTMLElement ? owned.getBoundingClientRect() : null;
  // A hidden pane measures zero. Fall back rather than centre on nothing.
  const usable = ownedBox && ownedBox.width > 8 && ownedBox.height > 8 ? owned : null;
  const wrap =
    usable ??
    document.querySelector(".lc-canvas-wrap:not(.lc-canvas-parked)") ??
    document.querySelector(".lc-board");
  const raw = wrap instanceof HTMLElement ? wrap.getBoundingClientRect() : null;
  const box =
    raw && raw.width > 8 && raw.height > 8
      ? raw
      : {
          left: 0,
          top: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
          width: window.innerWidth,
          height: window.innerHeight,
        };
  const toolbar = document.querySelector(".lc-toolbar:not(.lc-toolbar-floating)");
  let bottom = box.bottom;
  if (toolbar instanceof HTMLElement) {
    const bar = toolbar.getBoundingClientRect();
    if (bar.top > box.top + 48) bottom = Math.min(bottom, bar.top);
  }
  const pad = WHEEL_R + VIEW_PAD;
  const x = box.left + box.width / 2;
  const y = box.top + Math.max(0, bottom - box.top) / 2;
  const minX = box.left + pad;
  const maxX = box.right - pad;
  const minY = box.top + pad;
  const maxY = bottom - pad;
  return {
    x: maxX < minX ? x : Math.min(maxX, Math.max(minX, x)),
    y: maxY < minY ? y : Math.min(maxY, Math.max(minY, y)),
  };
}

export interface InkToolWheelProps {
  open: boolean;
  /** Pointer/nib point, or `"canvas"` for chip-hold (never over the island). */
  anchor: InkWheelAnchor;
  /**
   * The board that opened it, so `"canvas"` means *this* page.
   *
   * Split panes and parked tabs are both `.lc-canvas-wrap`; asking the document
   * for one picks whichever is first, which is neither.
   */
  host?: HTMLElement | null;
  handedness: InkHandedness;
  store: InkToolPresetStore;
  liveKind: InkPresetKind;
  onClose: () => void;
  onConfirm: (kind: InkPresetKind, wedge: number) => void;
  onEdit: (kind: InkPresetKind, wedge: number, from: DOMRect) => void;
  /** Editor is up — keep the dial mounted but ignore Escape / backdrop. */
  locked?: boolean;
}

export function InkToolWheel({
  open,
  anchor,
  host,
  handedness,
  store,
  liveKind,
  onClose,
  onConfirm,
  onEdit,
  locked = false,
}: InkToolWheelProps) {
  const [closing, setClosing] = useState(false);
  const [selectedKind, setSelectedKind] = useState<InkPresetKind | null>(liveKind);
  const [selectedWedge, setSelectedWedge] = useState<number | null>(store.lastWedge[liveKind]);
  const [outerDone, setOuterDone] = useState(true);
  const [innerChosen, setInnerChosen] = useState(false);
  const [linger, setLinger] = useState<number | null>(null);
  const [armed, setArmed] = useState(false);
  const [hold, setHold] = useState<{ index: number; t: number } | null>(null);
  const [dialShake, setDialShake] = useState(false);
  const openKindRef = useRef(liveKind);
  const openWedgeRef = useRef(store.lastWedge[liveKind]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const holdRafRef = useRef<number | null>(null);
  const holdStartRef = useRef(0);
  const holdIndexRef = useRef<number | null>(null);
  const holdFromRef = useRef<DOMRect | null>(null);
  const confirmedHoldRef = useRef(false);
  const appliedRef = useRef(false);
  const pressedWedgeRef = useRef<number | null>(null);
  const holdPointerIdRef = useRef<number | null>(null);
  const attachHoldWindowRef = useRef<(pointerId: number) => void>(() => {});
  const detachHoldWindowRef = useRef<() => void>(() => {});
  const storeRef = useRef(store);
  storeRef.current = store;
  const tapOkRef = useRef(store.tapOk);
  tapOkRef.current = store.tapOk;
  const outerDoneRef = useRef(true);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const kindRef = useRef(selectedKind ?? liveKind);
  kindRef.current = selectedKind ?? liveKind;

  const stopHold = useCallback((opts: { confirm: boolean; from?: DOMRect }) => {
    if (holdRafRef.current != null) {
      cancelAnimationFrame(holdRafRef.current);
      holdRafRef.current = null;
    }
    detachHoldWindowRef.current();
    const index = holdIndexRef.current;
    holdIndexRef.current = null;
    if (opts.confirm && index != null && !confirmedHoldRef.current) {
      confirmedHoldRef.current = true;
      const from = opts.from ?? holdFromRef.current ?? hubRectFallback(rootRef.current);
      onEditRef.current(kindRef.current, index, from);
    }
    holdFromRef.current = null;
    setHold(null);
  }, []);

  const tickHold = useCallback(() => {
    const index = holdIndexRef.current;
    if (index == null) return;
    const t = Math.min(1, (performance.now() - holdStartRef.current) / HOLD_MS);
    setHold({ index, t });
    if (t >= 1) {
      stopHold({ confirm: true });
      return;
    }
    holdRafRef.current = requestAnimationFrame(tickHold);
  }, [stopHold]);

  const startHold = useCallback(
    (index: number) => {
      if (holdRafRef.current != null) cancelAnimationFrame(holdRafRef.current);
      confirmedHoldRef.current = false;
      holdIndexRef.current = index;
      holdStartRef.current = performance.now();
      setHold({ index, t: 0 });
      holdRafRef.current = requestAnimationFrame(tickHold);
    },
    [tickHold],
  );

  useEffect(() => {
    const onUp = (event: PointerEvent) => {
      if (
        holdPointerIdRef.current != null &&
        event.pointerId !== holdPointerIdRef.current
      ) {
        return;
      }
      const useIndex = pressedWedgeRef.current;
      pressedWedgeRef.current = null;
      detachHoldWindowRef.current();
      const held = confirmedHoldRef.current;
      if (!held) stopHold({ confirm: false });
      if (held || appliedRef.current || useIndex == null) return;
      const useSnap = wedgeAt(storeRef.current, kindRef.current, useIndex);
      if (!useSnap) return;
      if (
        !wheelAutoApply({
          tapOk: tapOkRef.current,
          outerDone: outerDoneRef.current,
          openKind: openKindRef.current,
          openWedge: openWedgeRef.current,
          selectedKind: kindRef.current,
          selectedWedge: useIndex,
          innerChosen: true,
        })
      ) {
        return;
      }
      appliedRef.current = true;
      onConfirmRef.current(kindRef.current, useIndex);
    };
    attachHoldWindowRef.current = (pointerId: number) => {
      detachHoldWindowRef.current();
      holdPointerIdRef.current = pointerId;
      window.addEventListener("pointerup", onUp, true);
    };
    detachHoldWindowRef.current = () => {
      window.removeEventListener("pointerup", onUp, true);
      holdPointerIdRef.current = null;
    };
    return () => detachHoldWindowRef.current();
  }, [stopHold]);

  useEffect(() => () => stopHold({ confirm: false }), [stopHold]);

  useEffect(() => {
    if (!open) {
      setClosing(false);
      setArmed(false);
      appliedRef.current = false;
      pressedWedgeRef.current = null;
      stopHold({ confirm: false });
      return;
    }
    openKindRef.current = liveKind;
    openWedgeRef.current = store.lastWedge[liveKind];
    appliedRef.current = false;
    pressedWedgeRef.current = null;
    setSelectedKind(liveKind);
    setSelectedWedge(store.lastWedge[liveKind]);
    setOuterDone(true);
    setInnerChosen(false);
    setLinger(null);
    const id = window.setTimeout(() => setArmed(true), 80);
    return () => window.clearTimeout(id);
    // Only re-seed when the dial opens. lastWedge identity changes must not
    // wipe a wedge tap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stopHold]);

  const close = useCallback(() => {
    stopHold({ confirm: false });
    setClosing(true);
    window.setTimeout(() => {
      setClosing(false);
      onClose();
    }, 220);
  }, [onClose, stopHold]);

  useEffect(() => {
    if (!open || locked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, locked, close]);

  const [placed, setPlaced] = useState(() =>
    anchor === "canvas"
      ? measureCanvasDial(host)
      : clampWheelAnchor(
          anchor.x,
          anchor.y,
          WHEEL_R,
          {
            width: window.innerWidth,
            height: window.innerHeight,
          },
          VIEW_PAD,
        ),
  );
  useLayoutEffect(() => {
    if (anchor === "canvas") {
      setPlaced(measureCanvasDial(host));
      return;
    }
    setPlaced(
      clampWheelAnchor(
        anchor.x,
        anchor.y,
        WHEEL_R,
        {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        VIEW_PAD,
      ),
    );
  }, [anchor, host, open]);

  const toolSlices = useMemo(() => buildSlices(3, handedness), [handedness]);
  const wedgeSlices = useMemo(() => buildSlices(6, handedness), [handedness]);

  const kind = selectedKind ?? liveKind;
  outerDoneRef.current = outerDone;
  const canConfirm = wheelConfirmEnabled({
    openKind: openKindRef.current,
    openWedge: openWedgeRef.current,
    selectedKind,
    selectedWedge,
    innerChosen,
  });
  const lingerSnap = linger != null ? wedgeAt(store, kind, linger) : null;
  const hubSnap =
    selectedWedge != null ? wedgeAt(store, kind, selectedWedge) : wedgeAt(store, kind, 0);
  const hubFill = wedgeFill(kind, hubSnap);
  const cardSide = specCardSide(placed.x, WHEEL_R, CARD_W, window.innerWidth, VIEW_PAD);

  if (!open && !closing) return null;

  const onBackdrop = (event: React.PointerEvent) => {
    if (locked || !armed) return;
    const node = rootRef.current;
    if (node && event.target instanceof Node && node.contains(event.target)) return;
    close();
  };

  return createPortal(
    <div
      className="lc-ink-wheel-layer"
      onPointerDown={onBackdrop}
    >
      <div
        ref={rootRef}
        className={
          closing ? "lc-ink-wheel is-closing" : "lc-ink-wheel is-open"
        }
        style={{
          left: placed.x - WHEEL_R,
          top: placed.y - WHEEL_R,
          width: WHEEL_R * 2,
          height: WHEEL_R * 2,
        }}
        role="dialog"
        aria-label="Ink presets"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div
          className={dialShake ? "lc-ink-wheel-dial is-shake" : "lc-ink-wheel-dial"}
          onAnimationEnd={(event) => {
            if (event.animationName === "lc-stuck-shake") setDialShake(false);
          }}
        >
        <svg
          viewBox={`0 0 ${WHEEL_R * 2} ${WHEEL_R * 2}`}
          width={WHEEL_R * 2}
          height={WHEEL_R * 2}
          overflow="visible"
        >
          <defs>
            <clipPath id="lc-wedge-hold-clip">
              <rect
                x={0}
                y={WHEEL_R * 2 * (1 - (hold?.t ?? 0))}
                width={WHEEL_R * 2}
                height={WHEEL_R * 2 * (hold?.t ?? 0)}
              />
            </clipPath>
          </defs>
          {toolSlices.map((slice, index) => {
            const sliceKind = KINDS[index];
            const active = kind === sliceKind;
            return (
              <path
                key={sliceKind}
                d={donutSlice(WHEEL_R, WHEEL_R, OUTER_INNER, WHEEL_R, slice.start, slice.end)}
                className={active ? "lc-ink-wheel-tool is-active" : "lc-ink-wheel-tool"}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (!armed) return;
                  stopHold({ confirm: false });
                  if (sliceKind === kind) {
                    setOuterDone(true);
                    return;
                  }
                  setSelectedKind(sliceKind);
                  setSelectedWedge(store.lastWedge[sliceKind]);
                  setOuterDone(true);
                  setInnerChosen(false);
                  setLinger(null);
                }}
              />
            );
          })}
          {wedgeSlices.map((slice, index) => {
            const snap = wedgeAt(store, kind, index);
            const active = selectedWedge === index;
            const holding = hold?.index === index;
            const fillT = holding ? hold.t : 0;
            return (
              <g key={`w${index}`}>
                <path
                  d={donutSlice(WHEEL_R, WHEEL_R, INNER_INNER, INNER_OUTER, slice.start, slice.end)}
                  fill={wedgeFill(kind, snap)}
                  className={
                    snap
                      ? active
                        ? "lc-ink-wheel-wedge is-active"
                        : "lc-ink-wheel-wedge"
                      : "lc-ink-wheel-wedge is-empty"
                  }
                  onPointerEnter={() => setLinger(index)}
                  onPointerLeave={() => setLinger((cur) => (cur === index ? null : cur))}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!armed) return;
                    const local = localFromSvgPointer(event);
                    const hit =
                      local != null
                        ? innerWedgeIndexAt(local.lx, local.ly, wedgeSlices)
                        : null;
                    const useIndex = hit ?? index;
                    const useSnap = wedgeAt(store, kind, useIndex);
                    pressedWedgeRef.current = useIndex;
                    if (useSnap) {
                      setSelectedKind(kind);
                      setSelectedWedge(useIndex);
                      setInnerChosen(true);
                    }
                    setLinger(useIndex);
                    holdFromRef.current = event.currentTarget.getBoundingClientRect();
                    attachHoldWindowRef.current(event.pointerId);
                    startHold(useIndex);
                  }}
                />
                <path
                  d={donutSlice(
                    WHEEL_R,
                    WHEEL_R,
                    INNER_INNER,
                    INNER_OUTER,
                    slice.start,
                    slice.end,
                  )}
                  className="lc-ink-wheel-wedge-hold-fill"
                  clipPath="url(#lc-wedge-hold-clip)"
                  pointerEvents="none"
                  opacity={holding && fillT > 0 ? 1 : 0}
                />
              </g>
            );
          })}
        </svg>
        {toolSlices.map((slice, index) => {
          const [x, y] = polar(WHEEL_R, WHEEL_R, (WHEEL_R + OUTER_INNER) / 2, slice.mid);
          const sliceKind = KINDS[index];
          return (
            <span
              key={`i${sliceKind}`}
              className="lc-ink-wheel-tool-icon"
              style={{ left: x, top: y }}
              aria-hidden
            >
              {sliceKind === "highlighter" ? (
                <HighlighterIcon size={15} />
              ) : sliceKind === "eraser" ? (
                <PinkEraserIcon size={15} />
              ) : (
                <PenToolIcon size={15} />
              )}
            </span>
          );
        })}
        <button
          type="button"
          className={[
            "lc-ink-wheel-hub",
            canConfirm && store.tapOk ? "is-ready" : "is-idle",
          ]
            .filter(Boolean)
            .join(" ")}
          style={
            hubFill !== "transparent"
              ? { ["--lc-hub-fill" as string]: hubFill }
              : undefined
          }
          aria-disabled={!store.tapOk || !canConfirm}
          aria-label={
            store.tapOk
              ? canConfirm
                ? `Confirm ${kind}`
                : `${kind} — pick a wedge`
              : `${kind} colour`
          }
          onClick={() => {
            if (!store.tapOk) return;
            if (!canConfirm || selectedKind == null || selectedWedge == null) {
              setDialShake(false);
              requestAnimationFrame(() => setDialShake(true));
              return;
            }
            onConfirm(selectedKind, selectedWedge);
          }}
        />
        </div>
        <MorphBar
          active={linger != null ? "card" : "idle"}
          className={[
            "lc-ink-wheel-card",
            cardSide === "right" ? "is-right" : "is-left",
            linger != null ? "is-open" : "is-idle",
          ].join(" ")}
        >
          <div data-morph-id="idle" />
          <aside data-morph-id="card">
            <header className="lc-ink-wheel-card-head">
              <span
                className="lc-ink-wheel-card-swatch"
                style={{ background: lingerSnap ? wedgeFill(kind, lingerSnap) : "transparent" }}
                aria-hidden
              />
              <strong className="lc-ink-wheel-card-name">
                {lingerSnap?.name ?? "Empty"}
              </strong>
              <span className="lc-ink-wheel-card-slot">
                Slot {linger != null ? linger + 1 : "—"}
              </span>
            </header>
            <dl className="lc-ink-wheel-card-grid">
              {specRows(kind, lingerSnap).map((row) => (
                <div key={row.label} className="lc-ink-wheel-card-row">
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            <p className="lc-ink-wheel-card-hint">
              Linger to read · hold the wedge until it fills to edit
            </p>
          </aside>
        </MorphBar>
      </div>
    </div>,
    document.body,
  );
}
