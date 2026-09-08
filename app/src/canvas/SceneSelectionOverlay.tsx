/**
 * Transform chrome for selected scene primitives: scale, rotate, flip, arrow bends.
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

import type { PaintSceneElement } from "./paintScene";
import type { ViewportTransform } from "./rasterInk";
import {
  insertLinearMid,
  resizeBounds,
  rotateDeltaFromDrag,
  rotateElement,
  scaleAbout,
  sceneSelectionBounds,
  setLinearPoint,
  type ScaleHandle,
  type SceneBounds,
} from "./shapeGesture";

export interface SceneSelectionOverlayHandle {
  redraw(): void;
}

export interface SceneSelectionOverlayProps {
  getMembers: () => PaintSceneElement[];
  getViewport: () => ViewportTransform | null;
  clientToScene: (clientX: number, clientY: number) => { x: number; y: number };
  onChange: (next: PaintSceneElement[], commit: boolean) => void;
  onFlip: (axis: "h" | "v") => void;
}

interface OverlayView {
  left: number;
  top: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
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
    linear,
    mids,
  };
}

export const SceneSelectionOverlay = forwardRef<
  SceneSelectionOverlayHandle,
  SceneSelectionOverlayProps
>(function SceneSelectionOverlay(
  { getMembers, getViewport, clientToScene, onChange, onFlip },
  ref,
) {
  const [box, setBox] = useState<OverlayView | null>(null);
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

  useImperativeHandle(ref, () => ({ redraw }), [redraw]);

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
    dragRef.current = { kind: "scale", handle, from, origin: members };
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
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
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
      onChangeRef.current(
        getMembersRef.current().map((el) => rotateElement(el, delta)),
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
    if (!dragRef.current) return;
    event.stopPropagation();
    dragRef.current = null;
    onChangeRef.current(getMembersRef.current(), true);
  };

  const onMidClick = (after: number) => (event: ReactPointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const el = getMembersRef.current()[0];
    if (!el) return;
    onChangeRef.current([insertLinearMid(el, after)], true);
  };

  if (!box) return null;

  return (
    <div className="lc-scene-select" aria-hidden>
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
      <button
        type="button"
        className="lc-scene-select-rotate"
        style={{ left: box.cx, top: box.top }}
        aria-label="Rotate"
        onPointerDown={onRotateDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        ↻
      </button>
      <div className="lc-scene-select-flips" style={{ left: box.cx, top: box.top + box.height }}>
        <button
          type="button"
          aria-label="Flip horizontal"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onFlip("h");
          }}
        >
          ⇄
        </button>
        <button
          type="button"
          aria-label="Flip vertical"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onFlip("v");
          }}
        >
          ⇅
        </button>
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
    </div>
  );
});
