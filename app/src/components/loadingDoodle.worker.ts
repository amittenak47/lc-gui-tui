/// <reference lib="webworker" />
/**
 * Draws loading doodles from the pen's samples as Android reports them.
 *
 * See `util/nativeDoodle`. The page attaches each doodle's canvas here; this
 * worker tells Android where those canvases are, and Android sends every
 * touch that starts on one of them here instead of to the page. The strokes
 * are drawn by the doodle's engine, the same as on the page.
 *
 * Samples arrive as text, one event per message:
 * `kind|tool|x,y,pressure,time;…` — kind is d(own), m(ove), u(p) or c(ancel);
 * x and y are device pixels from the WebView's top-left; a move carries every
 * sample since the last one, oldest first.
 */

import { createDoodleEngine, type DoodleEngine, type DoodleInk, type DoodleSample } from "./loadingDoodleEngine";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Doodle {
  id: number;
  engine: DoodleEngine;
  rect: Rect;
  /** CSS px → the device pixels Android reports. */
  dpr: number;
  /** The bitmap's scale, as on the page (the pixel ratio, at most 2). */
  scale: number;
  enabled: boolean;
}

type FromPage =
  | { type: "port"; port: MessagePort }
  | {
      type: "attach";
      id: number;
      canvas: OffscreenCanvas;
      ink: DoodleInk;
      rect: Rect;
      dpr: number;
      scale: number;
      enabled: boolean;
    }
  | { type: "ink"; id: number; ink: DoodleInk }
  | { type: "place"; id: number; rect: Rect; dpr: number; scale: number; enabled: boolean }
  | { type: "detach"; id: number };

/** Android forgets the doodles if not told again within this long. */
const REGION_TTL_MS = 2500;
const REGION_REFRESH_MS = 1000;

const scope = self as unknown as DedicatedWorkerGlobalScope;
const doodles = new Map<number, Doodle>();
let port: MessagePort | null = null;
let active: Doodle | null = null;
let activeTool = "touch";
let refresh: ReturnType<typeof setInterval> | null = null;

function sendRegions(): void {
  if (!port) return;
  const rects: string[] = [];
  for (const doodle of doodles.values()) {
    if (!doodle.enabled) continue;
    const { left, top, width, height } = doodle.rect;
    const k = doodle.dpr;
    rects.push([left * k, top * k, (left + width) * k, (top + height) * k].map((n) => n.toFixed(1)).join(","));
  }
  port.postMessage(`r|${rects.join(";")}|${REGION_TTL_MS}`);
  if (rects.length > 0 && refresh == null) refresh = setInterval(sendRegions, REGION_REFRESH_MS);
  if (rects.length === 0 && refresh != null) {
    clearInterval(refresh);
    refresh = null;
  }
}

function samplesOf(text: string, doodle: Doodle, tool: string): DoodleSample[] {
  const out: DoodleSample[] = [];
  for (const part of text.split(";")) {
    if (!part) continue;
    const [x, y, pressure, t] = part.split(",").map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({
      x: x! / doodle.dpr - doodle.rect.left,
      y: y! / doodle.dpr - doodle.rect.top,
      t: t!,
      pressure: pressure!,
      pointerType: tool,
    });
  }
  return out;
}

/** The topmost showing doodle under a device-pixel point. */
function doodleAt(x: number, y: number): Doodle | null {
  let hit: Doodle | null = null;
  for (const doodle of doodles.values()) {
    if (!doodle.enabled) continue;
    const cx = x / doodle.dpr, cy = y / doodle.dpr;
    const { left, top, width, height } = doodle.rect;
    if (cx >= left && cx <= left + width && cy >= top && cy <= top + height) hit = doodle;
  }
  return hit;
}

function onNative(data: unknown): void {
  if (typeof data !== "string") return;
  const [kind, tool = "touch", body = ""] = data.split("|");
  if (kind === "d") {
    active?.engine.end(null);
    const first = body.split(";")[0]?.split(",").map(Number) ?? [];
    active = first.length >= 2 ? doodleAt(first[0]!, first[1]!) : null;
    activeTool = tool;
    if (!active) return;
    const [sample] = samplesOf(body, active, tool);
    if (sample) active.engine.begin(sample);
    return;
  }
  if (!active) return;
  if (kind === "m") {
    active.engine.move(samplesOf(body, active, activeTool));
    return;
  }
  if (kind === "u" || kind === "c") {
    const samples = kind === "u" ? samplesOf(body, active, activeTool) : [];
    active.engine.end(samples[samples.length - 1] ?? null);
    active = null;
  }
}

scope.onmessage = (event: MessageEvent<FromPage>) => {
  const msg = event.data;
  if (msg.type === "port") {
    port = msg.port;
    port.onmessage = (e) => onNative(e.data);
    sendRegions();
    return;
  }
  if (msg.type === "attach") {
    const id = msg.id;
    const engine = createDoodleEngine(
      msg.canvas,
      () => new OffscreenCanvas(1, 1),
      msg.ink,
      (on) => scope.postMessage({ type: "stroke", id, active: on }),
    );
    if (!engine) return;
    engine.resize(msg.rect.width, msg.rect.height, msg.scale);
    doodles.set(id, { id, engine, rect: msg.rect, dpr: msg.dpr, scale: msg.scale, enabled: msg.enabled });
    sendRegions();
    return;
  }
  const doodle = doodles.get(msg.id);
  if (!doodle) return;
  if (msg.type === "ink") {
    doodle.engine.setInk(msg.ink);
  } else if (msg.type === "place") {
    const moved = msg.rect.width !== doodle.rect.width || msg.rect.height !== doodle.rect.height || msg.scale !== doodle.scale;
    const changed = moved || msg.dpr !== doodle.dpr || msg.rect.left !== doodle.rect.left ||
      msg.rect.top !== doodle.rect.top || msg.enabled !== doodle.enabled;
    doodle.rect = msg.rect;
    doodle.dpr = msg.dpr;
    doodle.scale = msg.scale;
    doodle.enabled = msg.enabled;
    if (moved) doodle.engine.resize(msg.rect.width, msg.rect.height, msg.scale);
    if (changed) sendRegions();
  } else if (msg.type === "detach") {
    if (active === doodle) active = null;
    doodle.engine.dispose();
    doodles.delete(msg.id);
    sendRegions();
  }
};
