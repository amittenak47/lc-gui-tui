/**
 * Desktop-only drag handle on the inner edge of the agent column.
 *
 * Writes `--lc-agent-width` on `<html>` during the gesture so React never
 * stamps the stored 520 back over the drag. Boards freeze their pixels the
 * same way the split sash does, then remesh on settle.
 */

import { useEffect, useRef, useState } from "react";

import {
  AGENT_PANEL_WIDTH_DEFAULT,
  applyAgentPanelWidth,
  clampAgentPanelWidth,
  loadAgentPanelWidth,
  saveAgentPanelWidth,
} from "../util/agentPanelWidth";
import { announceSplitResize } from "../util/splitResize";
import { snapshotSashCanvases } from "../util/sashCanvasSnapshot";

const MOVE_OPTS: AddEventListenerOptions = { capture: true, passive: false };

function uiHandIsLeft(): boolean {
  return document.documentElement.getAttribute("data-ui-handedness") === "left";
}

function widthAt(x: number, edge: number, leftHand: boolean): number {
  return clampAgentPanelWidth(leftHand ? x - edge : edge - x);
}

export function AgentPanelSash() {
  const [dragging, setDragging] = useState(false);
  const sashRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef(false);
  const widthRef = useRef<number | null>(null);
  const lastTapRef = useRef(0);
  const unbindRef = useRef<(() => void) | null>(null);
  const moveRafRef = useRef(0);
  const pendingXRef = useRef<number | null>(null);
  const edgeRef = useRef(0);
  const leftHandRef = useRef(false);
  const restoreBoardsRef = useRef<(() => void) | null>(null);

  const applyCss = (x: number) => {
    const next = widthAt(x, edgeRef.current, leftHandRef.current);
    widthRef.current = next;
    applyAgentPanelWidth(next);
    announceSplitResize("move");
  };

  const flushMove = (x: number) => {
    if (moveRafRef.current) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = 0;
    }
    pendingXRef.current = null;
    applyCss(x);
  };

  const scheduleMove = (x: number) => {
    pendingXRef.current = x;
    if (moveRafRef.current) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = 0;
      const pending = pendingXRef.current;
      pendingXRef.current = null;
      if (!dragRef.current || pending == null) return;
      applyCss(pending);
    });
  };

  const unbind = () => {
    if (moveRafRef.current) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = 0;
    }
    pendingXRef.current = null;
    unbindRef.current?.();
    unbindRef.current = null;
    restoreBoardsRef.current?.();
    restoreBoardsRef.current = null;
    dragRef.current = false;
    setDragging(false);
    delete document.body.dataset.lcSashDrag;
  };

  useEffect(
    () => () => {
      if (moveRafRef.current) cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = 0;
      pendingXRef.current = null;
      unbindRef.current?.();
      unbindRef.current = null;
      restoreBoardsRef.current?.();
      restoreBoardsRef.current = null;
      dragRef.current = false;
      delete document.body.dataset.lcSashDrag;
    },
    [],
  );

  const bindDrag = () => {
    unbindRef.current?.();
    restoreBoardsRef.current?.();
    const panel = sashRef.current?.closest(".lc-side");
    const box = panel?.getBoundingClientRect();
    leftHandRef.current = uiHandIsLeft();
    edgeRef.current = box ? (leftHandRef.current ? box.left : box.right) : 0;
    const boards = [...document.querySelectorAll<HTMLElement>(".lc-main .lc-board")];
    const restoreSnapshots = boards.map((node) => snapshotSashCanvases(node));
    restoreBoardsRef.current = () => {
      for (const restore of restoreSnapshots) restore();
    };
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current) return;
      event.preventDefault();
      scheduleMove(event.clientX);
    };
    const onUp = (event: PointerEvent) => {
      if (!dragRef.current) return;
      flushMove(event.clientX);
      const width = widthRef.current;
      unbind();
      if (width != null) saveAgentPanelWidth(width);
      announceSplitResize("settle");
    };
    window.addEventListener("pointermove", onMove, MOVE_OPTS);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    document.body.dataset.lcSashDrag = "vertical";
    unbindRef.current = () => {
      window.removeEventListener("pointermove", onMove, MOVE_OPTS);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  };

  const commit = (px: number) => {
    const next = applyAgentPanelWidth(saveAgentPanelWidth(px));
    widthRef.current = next;
    announceSplitResize("settle");
  };

  return (
    <button
      ref={sashRef}
      type="button"
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to resize the agent panel"
      aria-pressed={dragging}
      className={["lc-agent-sash", dragging ? "is-dragging" : ""].filter(Boolean).join(" ")}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const now = Date.now();
        if (now - lastTapRef.current < 320) {
          lastTapRef.current = 0;
          unbind();
          commit(AGENT_PANEL_WIDTH_DEFAULT);
          return;
        }
        lastTapRef.current = now;
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
        dragRef.current = true;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        bindDrag();
        applyCss(event.clientX);
      }}
      onKeyDown={(event) => {
        const here = loadAgentPanelWidth();
        const step = event.shiftKey ? 40 : 12;
        const left = uiHandIsLeft();
        let next: number | null = null;
        if (event.key === "ArrowLeft") next = clampAgentPanelWidth(here + (left ? -step : step));
        if (event.key === "ArrowRight") next = clampAgentPanelWidth(here + (left ? step : -step));
        if (event.key === "Home") next = AGENT_PANEL_WIDTH_DEFAULT;
        if (next == null) return;
        event.preventDefault();
        commit(next);
      }}
    />
  );
}
