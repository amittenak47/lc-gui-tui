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
    { label: "Point blending", value: `${Math.round(snap.blot * 100)}%` },
    { label: "Ink boost", value: `${Math.round(snap.boldness * 100)}%` },
    {
      label: "Smoothing",
      value: snap.smoothing === 0 ? "Off" : `${Math.round(snap.smoothing * 100)}% ${snap.smoothingMode}`,
    },
  ];
}

/** Nib coords, or the drawable hole (canvas wrap minus the docked island). */
export type InkWheelAnchor = { x: number; y: number } | "canvas";

function measureCanvasDial(): { x: number; y: number } {
  const wrap =
    document.querySelector(".lc-canvas-wrap") ?? document.querySelector(".lc-board");
  const box =
    wrap instanceof HTMLElement
      ? wrap.getBoundingClientRect()
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
  handedness: InkHandedness;
  store: InkToolPresetStore;
  liveKind: InkPresetKind;
  onClose: () => void;
  onConfirm: (kind: InkPresetKind, wedge: number) => void;
  onEdit: (kind: InkPresetKind, wedge: number, from: DOMRect) => void;
}

export function InkToolWheel({
  open,
  anchor,
  handedness,
  store,
  liveKind,
  onClose,
  onConfirm,
  onEdit,
}: InkToolWheelProps) {
  const [closing, setClosing] = useState(false);
  const [selectedKind, setSelectedKind] = useState<InkPresetKind | null>(liveKind);
  const [selectedWedge, setSelectedWedge] = useState<number | null>(store.lastWedge[liveKind]);
  const [outerDone, setOuterDone] = useState(true);
  const [innerChosen, setInnerChosen] = useState(false);
  const [linger, setLinger] = useState<number | null>(null);
  const [armed, setArmed] = useState(false);
  const [hold, setHold] = useState<{ index: number; t: number } | null>(null);
  const [hubShake, setHubShake] = useState(false);
  const openKindRef = useRef(liveKind);
  const openWedgeRef = useRef(store.lastWedge[liveKind]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const holdRafRef = useRef<number | null>(null);
  const holdStartRef = useRef(0);
  const holdIndexRef = useRef<number | null>(null);
  const holdFromRef = useRef<DOMRect | null>(null);
  const confirmedHoldRef = useRef(false);
  const appliedRef = useRef(false);
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
    const index = holdIndexRef.current;
    holdIndexRef.current = null;
    if (opts.confirm && index != null && !confirmedHoldRef.current) {
      confirmedHoldRef.current = true;
      const from =
        opts.from ??
        holdFromRef.current ??
        new DOMRect(
          (rootRef.current?.getBoundingClientRect().left ?? 0) + WHEEL_R - 16,
          (rootRef.current?.getBoundingClientRect().top ?? 0) + WHEEL_R - 16,
          32,
          32,
        );
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

  useEffect(() => () => stopHold({ confirm: false }), [stopHold]);

  useEffect(() => {
    if (!open) {
      setClosing(false);
      setArmed(false);
      appliedRef.current = false;
      stopHold({ confirm: false });
      return;
    }
    openKindRef.current = liveKind;
    openWedgeRef.current = store.lastWedge[liveKind];
    appliedRef.current = false;
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
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const [placed, setPlaced] = useState(() =>
    anchor === "canvas"
      ? measureCanvasDial()
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
      setPlaced(measureCanvasDial());
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
  }, [anchor, open]);

  const toolSlices = useMemo(() => buildSlices(3, handedness), [handedness]);
  const wedgeSlices = useMemo(() => buildSlices(6, handedness), [handedness]);

  const kind = selectedKind ?? liveKind;
  const canConfirm = wheelConfirmEnabled({
    openKind: openKindRef.current,
    openWedge: openWedgeRef.current,
    selectedKind,
    selectedWedge,
    innerChosen,
  });
  const autoApply = wheelAutoApply({
    tapOk: store.tapOk,
    outerDone,
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

  useEffect(() => {
    if (!open || !autoApply || appliedRef.current) return;
    if (selectedKind == null || selectedWedge == null) return;
    appliedRef.current = true;
    onConfirmRef.current(selectedKind, selectedWedge);
  }, [open, autoApply, selectedKind, selectedWedge]);

  if (!open && !closing) return null;

  const onBackdrop = (event: React.PointerEvent) => {
    if (!armed) return;
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
                    event.stopPropagation();
                    if (!armed) return;
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId);
                    } catch {
                      /* already captured */
                    }
                    if (snap) {
                      setSelectedKind(kind);
                      setSelectedWedge(index);
                      setInnerChosen(true);
                    }
                    setLinger(index);
                    holdFromRef.current = event.currentTarget.getBoundingClientRect();
                    startHold(index);
                  }}
                  onPointerUp={() => {
                    if (!confirmedHoldRef.current) stopHold({ confirm: false });
                  }}
                  onPointerCancel={() => stopHold({ confirm: false })}
                />
                {holding && fillT > 0 && (
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
                  />
                )}
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
            hubShake ? "is-shake" : "",
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
          onAnimationEnd={(event) => {
            if (event.animationName === "lc-stuck-shake") setHubShake(false);
          }}
          onClick={() => {
            if (!store.tapOk) return;
            if (!canConfirm || selectedKind == null || selectedWedge == null) {
              setHubShake(false);
              requestAnimationFrame(() => setHubShake(true));
              return;
            }
            onConfirm(selectedKind, selectedWedge);
          }}
        />
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
