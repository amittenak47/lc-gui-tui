/**
 * Transform chrome for selected scene primitives.
 *
 * Corner grips scale. One morphing dock holds rotate / flip / delete so the
 * actions sit together instead of as four floating pills.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { MorphBar } from "../components/MorphBar";
import type { PaintSceneElement } from "./paintScene";
import type { ViewportTransform } from "./rasterInk";
import {
  clonePaintElements,
  insertLinearMid,
  magnetOrthogonal,
  resizeBounds,
  rotateDeltaFromDrag,
  rotateAbout,
  scaleAbout,
  sceneSelectionBounds,
  setLinearPoint,
  snapAngle,
  type ScaleHandle,
  type SceneBounds,
} from "./shapeGesture";

export interface SceneSelectionOverlayHandle {
  redraw(): void;
  setMarquee(box: { left: number; top: number; width: number; height: number } | null): void;
}

export interface SceneSelectionOverlayProps {
  getMembers: () => PaintSceneElement[];
  getViewport: () => ViewportTransform | null;
  clientToScene: (clientX: number, clientY: number) => { x: number; y: number };
  onChange: (next: PaintSceneElement[], commit: boolean) => void;
  onFlip: (axis: "h" | "v") => void;
  onDelete: () => void;
}

interface OverlayView {
  left: number;
  top: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
  dockTop: boolean;
  linear: Array<{ index: number; left: number; top: number }>;
  mids: Array<{ after: number; left: number; top: number }>;
}

function cssPoint(x: number, y: number, view: ViewportTransform): { left: number; top: number } {
  return {
    left: (x + view.scrollX) * view.zoom,
    top: (y + view.scrollY) * view.zoom,
  };
}

function buildView(members: PaintSceneElement[], view: ViewportTransform): OverlayView | null {
  const bounds = sceneSelectionBounds(members);
  if (!bounds) return null;
  const nw = cssPoint(bounds.minX, bounds.minY, view);
  const se = cssPoint(bounds.maxX, bounds.maxY, view);
  const left = nw.left;
  const top = nw.top;
  const width = Math.max(8, se.left - nw.left);
  const height = Math.max(8, se.top - nw.top);
  const linear: OverlayView["linear"] = [];
  const mids: OverlayView["mids"] = [];
  if (members.length === 1) {
    const el = members[0]!;
    if ((el.type === "arrow" || el.type === "line") && el.points && el.points.length >= 2) {
      for (let i = 0; i < el.points.length; i++) {
        const pt = el.points[i]!;
        const p = cssPoint(el.x + pt[0], el.y + pt[1], view);
        linear.push({ index: i, left: p.left, top: p.top });
      }
      for (let i = 0; i < el.points.length - 1; i++) {
        const a = el.points[i]!;
        const b = el.points[i + 1]!;
        const p = cssPoint(el.x + (a[0] + b[0]) / 2, el.y + (a[1] + b[1]) / 2, view);
        mids.push({ after: i, left: p.left, top: p.top });
      }
    }
  }
  return {
    left,
    top,
    width,
    height,
    cx: left + width / 2,
    cy: top + height / 2,
    dockTop: top >= 56,
    linear,
    mids,
  };
}

function RotateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 12a8 8 0 0 1 13.7-5.6L20 8"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20 3v5h-5"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        d="M20 12a8 8 0 1 1-3-6.3"
      />
    </svg>
  );
}

function FlipHIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path fill="none" stroke="currentColor" strokeWidth="1.8" d="M12 3v18" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        d="M10 8 5 12l5 4M14 8l5 4-5 4"
      />
    </svg>
  );
}

function FlipVIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path fill="none" stroke="currentColor" strokeWidth="1.8" d="M3 12h18" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        d="M8 10 12 5l4 5M8 14l4 5 4-5"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"
      />
    </svg>
  );
}

function spinLabel(rad: number): string {
  let deg = Math.round((rad * 180) / Math.PI) % 360;
  if (deg < 0) deg += 360;
  return `${deg}°`;
}

export const SceneSelectionOverlay = forwardRef<
  SceneSelectionOverlayHandle,
  SceneSelectionOverlayProps
>(function SceneSelectionOverlay(
  { getMembers, getViewport, clientToScene, onChange, onFlip, onDelete },
  ref,
) {
  const [box, setBox] = useState<OverlayView | null>(null);
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [spin, setSpin] = useState<number | null>(null);
  const getMembersRef = useRef(getMembers);
  getMembersRef.current = getMembers;
  const getViewportRef = useRef(getViewport);
  getViewportRef.current = getViewport;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const clientToSceneRef = useRef(clientToScene);
  clientToSceneRef.current = clientToScene;
  const dragRef = useRef<
    | {
        kind: "scale";
        handle: ScaleHandle;
        from: SceneBounds;
        origin: PaintSceneElement[];
      }
    | {
        kind: "rotate";
        cx: number;
        cy: number;
        lastX: number;
        lastY: number;
        origin: PaintSceneElement[];
        accumulated: number;
      }
    | { kind: "point"; index: number }
    | null
  >(null);

  const redraw = useCallback(() => {
    const view = getViewportRef.current();
    const members = getMembersRef.current();
    if (!view || members.length === 0) {
      setBox(null);
      return;
    }
    setBox(buildView(members, view));
  }, []);

  useImperativeHandle(ref, () => ({ redraw, setMarquee }), [redraw]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  const sceneFromEvent = (event: ReactPointerEvent) =>
    clientToSceneRef.current(event.clientX, event.clientY);

  const onScaleDown = (handle: ScaleHandle) => (event: ReactPointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const members = getMembersRef.current();
    const from = sceneSelectionBounds(members);
    if (!from) return;
    dragRef.current = { kind: "scale", handle, from, origin: clonePaintElements(members) };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onRotateDown = (event: ReactPointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const members = getMembersRef.current();
    const bounds = sceneSelectionBounds(members);
    if (!bounds) return;
    const scene = sceneFromEvent(event);
    dragRef.current = {
      kind: "rotate",
      cx: (bounds.minX + bounds.maxX) / 2,
      cy: (bounds.minY + bounds.maxY) / 2,
      lastX: scene.x,
      lastY: scene.y,
      origin: clonePaintElements(members),
      accumulated: 0,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setSpin(0);
  };

  const onPointDown = (index: number) => (event: ReactPointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    dragRef.current = { kind: "point", index };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.stopPropagation();
    const scene = sceneFromEvent(event);
    if (drag.kind === "scale") {
      const to = resizeBounds(drag.from, drag.handle, scene.x, scene.y);
      onChangeRef.current(
        drag.origin.map((el) => scaleAbout(el, drag.from, to)),
        false,
      );
      return;
    }
    if (drag.kind === "rotate") {
      const delta = rotateDeltaFromDrag(drag.cx, drag.cy, drag.lastX, drag.lastY, scene.x, scene.y);
      drag.lastX = scene.x;
      drag.lastY = scene.y;
      drag.accumulated += delta;
      const live = magnetOrthogonal(drag.accumulated);
      setSpin(live);
      onChangeRef.current(
        drag.origin.map((el) => rotateAbout(el, drag.cx, drag.cy, live)),
        false,
      );
      return;
    }
    const members = getMembersRef.current();
    const el = members[0];
    if (!el) return;
    onChangeRef.current([setLinearPoint(el, drag.index, scene.x, scene.y)], false);
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.stopPropagation();
    dragRef.current = null;
    if (drag.kind === "rotate") {
      const snapped = snapAngle(drag.accumulated);
      setSpin(null);
      onChangeRef.current(
        drag.origin.map((el) => rotateAbout(el, drag.cx, drag.cy, snapped)),
        true,
      );
      return;
    }
    onChangeRef.current(getMembersRef.current(), true);
  };

  const onMidClick = (after: number) => (event: ReactPointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const el = getMembersRef.current()[0];
    if (!el) return;
    onChangeRef.current([insertLinearMid(el, after)], true);
  };

  return (
    <div className="lc-scene-select">
      {marquee && (
        <div
          className="lc-scene-select-marquee"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      )}
      {box && (
        <>
          <div
            className="lc-scene-select-box"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          />
          {(["nw", "ne", "se", "sw"] as ScaleHandle[]).map((handle) => (
            <button
              key={handle}
              type="button"
              className={`lc-scene-select-handle lc-scene-select-handle-${handle}`}
              style={{
                left: handle === "nw" || handle === "sw" ? box.left : box.left + box.width,
                top: handle === "nw" || handle === "ne" ? box.top : box.top + box.height,
              }}
              aria-label={`Scale ${handle}`}
              onPointerDown={onScaleDown(handle)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          ))}
          <div
            className={box.dockTop ? "lc-scene-select-dock is-above" : "lc-scene-select-dock is-below"}
            style={{
              left: box.cx,
              top: box.dockTop ? box.top : box.top + box.height,
            }}
          >
            <MorphBar active="actions" axis="width" className="lc-scene-select-menu">
              <div data-morph-id="actions">
                <button
                  type="button"
                  className={spin != null ? "lc-scene-select-spinning" : undefined}
                  aria-label="Rotate"
                  title="Rotate — snaps to 90°"
                  onPointerDown={onRotateDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                >
                  <MorphBar
                    active={spin != null ? "deg" : "icon"}
                    axis="width"
                    animateOnMount={false}
                    className="lc-scene-select-rotate"
                  >
                    <div data-morph-id="icon">
                      <RotateIcon />
                    </div>
                    <div data-morph-id="deg">
                      <span className="lc-scene-select-angle">{spinLabel(spin ?? 0)}</span>
                    </div>
                  </MorphBar>
                </button>
                <button
                  type="button"
                  aria-label="Flip horizontal"
                  title="Flip horizontal"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onFlip("h");
                  }}
                >
                  <FlipHIcon />
                </button>
                <button
                  type="button"
                  aria-label="Flip vertical"
                  title="Flip vertical"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onFlip("v");
                  }}
                >
                  <FlipVIcon />
                </button>
                <button
                  type="button"
                  aria-label="Delete selection"
                  title="Delete"
                  className="is-danger"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete();
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
            </MorphBar>
          </div>
          {box.linear.map((pt) => (
            <button
              key={`p-${pt.index}`}
              type="button"
              className="lc-scene-select-point"
              style={{ left: pt.left, top: pt.top }}
              aria-label={`Point ${pt.index + 1}`}
              onPointerDown={onPointDown(pt.index)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          ))}
          {box.mids.map((mid) => (
            <button
              key={`m-${mid.after}`}
              type="button"
              className="lc-scene-select-mid"
              style={{ left: mid.left, top: mid.top }}
              aria-label="Add bend"
              title="Add bend"
              onPointerDown={onMidClick(mid.after)}
            >
              +
            </button>
          ))}
        </>
      )}
    </div>
  );
});
