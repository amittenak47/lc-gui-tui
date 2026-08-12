/**
 * Host-ink lab — prove Approach-2 glue with production paint/host helpers.
 *
 * Uses {@link scrollHostAtPoint}, {@link hostKeyInDoc}, {@link applyInkOp},
 * {@link applyInkOpInHost}, {@link hostScrollDx} — not a toy renderer — so a
 * pass here predicts RasterInkLayer behavior. UI shell only (no Board /
 * Excalidraw / tiles).
 *
 * Open: http://localhost:1420/host-ink-lab.html
 */

import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  applyInkOp,
  applyInkOpInHost,
  hostScrollDx,
  inkBaseWidthForZoom,
  pointerPressure,
  smoothPressure,
  type InkDrawOp,
  type InkOp,
  type ScenePoint,
} from "../canvas/rasterInk";
import {
  DOC_PAGE_SELECTOR,
  hostKeyInDoc,
  hostSceneBounds,
  horizontalScrollHostsIn,
  scrollHostAtPoint,
} from "../canvas/scrollHost";

import "./hostInkLab.css";

type Mode = "scroll" | "annotate";

const WIDE_LINE =
  "// " + Array.from({ length: 90 }, (_, i) => `tok${i}`).join(" ");

const CODE = [
  "function glueInkToScrollHost(ops, hosts, scrollLeft) {",
  "  // Wide line on purpose — scroll the box sideways.",
  `  ${WIDE_LINE}`,
  "  const dx = -(scrollLeft - (ops[0]?.scrollLeftAtDraw ?? 0));",
  "  return ops.map((op) => ({ ...op, dx, hostKey: op.hostKey }));",
  "}",
  "",
  "export async function demo() {",
  "  return glueInkToScrollHost([], new Map(), 0);",
  "}",
].join("\n");

function HostInkLab() {
  const [mode, setMode] = useState<Mode>("annotate");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const opsRef = useRef<InkOp[]>([]);
  const liveRef = useRef<InkDrawOp | null>(null);
  const pressureEmaRef = useRef(0);
  const strokeHostRef = useRef<{
    key: number;
    scrollLeftAtDraw: number;
    el: HTMLElement;
  } | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const rafRef = useRef(0);

  const paint = () => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const doc = docRef.current;
    if (!canvas || !stage || !doc) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = stage.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const viewport = { zoom: 1, scrollX: 0, scrollY: 0 };
    const canvasRect = canvas.getBoundingClientRect();
    const hosts = horizontalScrollHostsIn(doc);
    const lookup = new Map<
      number,
      { bounds: ReturnType<typeof hostSceneBounds>; scrollLeft: number }
    >();
    hosts.forEach((el, key) => {
      lookup.set(key, {
        bounds: hostSceneBounds(el, canvasRect, viewport),
        scrollLeft: el.scrollLeft,
      });
    });

    const pixelScale = dpr;
    const all = [...opsRef.current];
    if (liveRef.current) all.push(liveRef.current);

    for (const op of all) {
      if (op.kind !== "draw") continue;
      if (op.hostKey == null || op.scrollLeftAtDraw == null) {
        applyInkOp(ctx, op, pixelScale);
        continue;
      }
      const host = lookup.get(op.hostKey);
      if (!host) {
        applyInkOp(ctx, op, pixelScale);
        continue;
      }
      const dx = hostScrollDx(op, host.scrollLeft);
      applyInkOpInHost(ctx, op, host.bounds, dx, pixelScale);
    }
  };

  const schedulePaint = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      paint();
    });
  };

  useEffect(() => {
    const doc = docRef.current;
    const stage = stageRef.current;
    if (!doc || !stage) return;
    const onScroll = () => schedulePaint();
    const hosts = horizontalScrollHostsIn(doc);
    for (const host of hosts) {
      host.addEventListener("scroll", onScroll, { passive: true });
    }
    doc.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", schedulePaint);
    const ro = new ResizeObserver(() => schedulePaint());
    ro.observe(stage);
    ro.observe(doc);
    // Sync resize — rAF alone was cancelled under StrictMode before first paint,
    // leaving the canvas at the default 300×150 while CSS stretched it.
    paint();
    schedulePaint();
    return () => {
      for (const host of hosts) {
        host.removeEventListener("scroll", onScroll);
      }
      doc.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedulePaint);
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    schedulePaint();
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const doc = docRef.current;
    if (!canvas || !doc) return;

    const clientToScene = (event: PointerEvent): ScenePoint => {
      const rect = canvas.getBoundingClientRect();
      const raw = pointerPressure(event.pressure, event.pointerType);
      const prev = pressureEmaRef.current;
      const pressure = raw < 0 ? raw : smoothPressure(prev || raw, raw);
      if (raw >= 0) pressureEmaRef.current = pressure;
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        pressure,
      };
    };

    const onDown = (event: PointerEvent) => {
      if (modeRef.current !== "annotate") return;
      if (event.button !== 0 && event.pointerType !== "pen") return;
      event.preventDefault();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* best-effort */
      }
      pressureEmaRef.current = 0;
      const point = clientToScene(event);
      const host = scrollHostAtPoint(event.clientX, event.clientY);
      if (host && doc.contains(host)) {
        const key = hostKeyInDoc(host, doc);
        if (key != null) {
          strokeHostRef.current = {
            key,
            scrollLeftAtDraw: host.scrollLeft,
            el: host,
          };
        } else {
          strokeHostRef.current = null;
        }
      } else {
        strokeHostRef.current = null;
      }
      const binding = strokeHostRef.current;
      liveRef.current = {
        kind: "draw",
        color: "#1a1a1a",
        baseWidth: inkBaseWidthForZoom(4, 1),
        maxFullness: 1,
        pressureClip: 1,
        // Mouse/touch report NO_PRESSURE — pressure-on would still paint via the
        // non-stylus branch, but lab is clearer as a fixed nib.
        pressureSensitive: false,
        speedInk: 0,
        boldness: 1,
        points: [point],
        ...(binding
          ? { hostKey: binding.key, scrollLeftAtDraw: binding.scrollLeftAtDraw }
          : {}),
      };
      schedulePaint();
    };

    const onMove = (event: PointerEvent) => {
      if (!liveRef.current) return;
      liveRef.current.points.push(clientToScene(event));
      schedulePaint();
    };

    const onUp = (event: PointerEvent) => {
      if (!liveRef.current) return;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      if (liveRef.current.points.length > 1) {
        opsRef.current = [...opsRef.current, liveRef.current];
      }
      liveRef.current = null;
      strokeHostRef.current = null;
      schedulePaint();
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <div className="hil-root">
      <header className="hil-bar">
        <strong>host-ink lab</strong>
        <span className="hil-hint">
          Production paint + scrollHost helpers. Annotate: draw. Scroll: drag the
          box. Ink in the pre should ride scrollLeft and clip; ink outside stays.
        </span>
        <div className="hil-modes" role="group" aria-label="Mode">
          <button
            type="button"
            className={mode === "scroll" ? "is-on" : ""}
            onClick={() => setMode("scroll")}
          >
            Scroll
          </button>
          <button
            type="button"
            className={mode === "annotate" ? "is-on" : ""}
            onClick={() => setMode("annotate")}
          >
            Annotate
          </button>
          <button
            type="button"
            onClick={() => {
              opsRef.current = [];
              liveRef.current = null;
              schedulePaint();
            }}
          >
            Clear
          </button>
        </div>
      </header>

      <div className="hil-stage" ref={stageRef}>
        {/* DOC_PAGE_SELECTOR root — required by scrollHost helpers */}
        <div
          className={`lc-md-ink-doc hil-doc ${mode === "annotate" ? "is-annotate" : ""}`}
          ref={docRef}
          data-doc-scope="lab"
        >
          <p className="hil-prose">
            Page notes go here (outside the scroller). Draw in Annotate mode —
            these strokes stay put when you scroll the code box.
          </p>
          <div className="hil-host-wrap">
            <pre className="hil-host">{CODE}</pre>
          </div>
          <p className="hil-prose">
            More page surface under the box. Selectors used:{" "}
            <code>{DOC_PAGE_SELECTOR}</code>
          </p>
        </div>
        <canvas
          ref={canvasRef}
          className={`lc-raster-ink hil-ink ${mode === "scroll" ? "is-pass" : ""}`}
          aria-hidden
        />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <HostInkLab />
    </StrictMode>,
  );
}
