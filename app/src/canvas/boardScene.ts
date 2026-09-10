/**
 * Board camera + scene store. Replaces the Excalidraw component.
 * Frames / text / stamps stay as data. The visible pad is Ink lab.
 */

import { paintSceneToExport } from "./paintScene";

export const CaptureUpdateAction = {
  NEVER: "NEVER",
  IMMEDIATELY: "IMMEDIATELY",
  EVENTUALLY: "EVENTUALLY",
} as const;

export type CaptureUpdate =
  | typeof CaptureUpdateAction.NEVER
  | typeof CaptureUpdateAction.IMMEDIATELY
  | typeof CaptureUpdateAction.EVENTUALLY;

export type BoardScrollHandler = (
  scrollX: number,
  scrollY: number,
  zoom: { value: number },
) => void;

export type BoardChangeHandler = (
  elements: readonly unknown[],
  appState: Record<string, unknown>,
) => void;

export interface ExcalidrawApi {
  getSceneElements(): readonly unknown[];
  getAppState(): Record<string, unknown>;
  getFiles(): Record<string, unknown>;
  addFiles?(files: Array<{
    id: string;
    mimeType: string;
    dataURL: string;
    created: number;
  }>): void;
  updateScene(scene: {
    elements?: unknown[];
    appState?: Record<string, unknown>;
    captureUpdate?: CaptureUpdate;
  }): void;
  setActiveTool(tool: {
    type: string;
    customType?: string;
    locked?: boolean;
  }): void;
  setCursor?(cursor: string): void;
  resetCursor?(): void;
  scrollToContent(target?: unknown, opts?: unknown): void;
  onScrollChange?(callback: BoardScrollHandler): () => void;
  setOnChange?(handler: BoardChangeHandler | null): void;
  history?: {
    clear(): void;
    undo(): boolean;
    redo(): boolean;
    canUndo(): boolean;
    canRedo(): boolean;
  };
  refresh?(): void;
}

type SceneEl = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isDeleted?: boolean;
  points?: Array<[number, number]>;
};

const CAMERA_KEYS = new Set([
  "scrollX",
  "scrollY",
  "zoom",
  "width",
  "height",
  "offsetLeft",
  "offsetTop",
]);

function zoomValue(state: Record<string, unknown>): number {
  const zoom = state.zoom as { value?: number } | number | undefined;
  if (typeof zoom === "number" && zoom > 0) return zoom;
  if (zoom && typeof zoom === "object" && typeof zoom.value === "number" && zoom.value > 0) {
    return zoom.value;
  }
  return 1;
}

function isCameraOnly(scene: { elements?: unknown[]; appState?: Record<string, unknown> }): boolean {
  if (scene.elements) return false;
  const state = scene.appState;
  if (!state) return false;
  const keys = Object.keys(state);
  return keys.length > 0 && keys.every((key) => CAMERA_KEYS.has(key));
}

export function getCommonBounds(elements: readonly unknown[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const raw of elements) {
    const el = raw as SceneEl;
    if (el.isDeleted) continue;
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    const w = el.width ?? 0;
    const h = el.height ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
    if (Array.isArray(el.points)) {
      for (const pt of el.points) {
        minX = Math.min(minX, x + pt[0]);
        minY = Math.min(minY, y + pt[1]);
        maxX = Math.max(maxX, x + pt[0]);
        maxY = Math.max(maxY, y + pt[1]);
      }
    }
  }
  if (!Number.isFinite(minX)) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}

function paperColor(appState: Record<string, unknown> | undefined): string {
  const color = appState?.viewBackgroundColor;
  if (typeof color === "string" && color && color !== "transparent") return color;
  return "#ffffff";
}

export async function exportToCanvas(opts: {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: unknown;
  exportPadding?: number;
}): Promise<HTMLCanvasElement> {
  const padding = opts.exportPadding ?? 0;
  const [minX, minY, maxX, maxY] = getCommonBounds(opts.elements);
  const exportScale =
    typeof opts.appState?.exportScale === "number" && opts.appState.exportScale > 0
      ? opts.appState.exportScale
      : 1;
  const width = Math.max(1, Math.round((maxX - minX + padding * 2) * exportScale));
  const height = Math.max(1, Math.round((maxY - minY + padding * 2) * exportScale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = paperColor(opts.appState);
    ctx.fillRect(0, 0, width, height);
    const files = (opts.files ?? {}) as Record<string, { dataURL?: string } | undefined>;
    const { loadSceneImages } = await import("./sceneImages");
    const images = await loadSceneImages(opts.elements as import("./paintScene").PaintSceneElement[], files);
    paintSceneToExport(ctx, opts.elements, {
      minX,
      minY,
      padding,
      exportScale,
      files,
      images,
    });
  }
  return canvas;
}

export async function exportToBlob(opts: {
  elements: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: unknown;
  mimeType?: string;
  quality?: number;
  exportPadding?: number;
}): Promise<Blob> {
  const canvas = await exportToCanvas(opts);
  const mime = opts.mimeType ?? "image/png";
  const quality = opts.quality ?? 0.8;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
  return blob ?? new Blob([], { type: mime });
}

export function createBoardScene(initial?: {
  elements?: unknown[];
  appState?: Record<string, unknown>;
}): ExcalidrawApi {
  let elements: unknown[] = initial?.elements ? [...initial.elements] : [];
  let files: Record<string, unknown> = {};
  let appState: Record<string, unknown> = {
    zoom: { value: 1 },
    scrollX: 0,
    scrollY: 0,
    offsetLeft: 0,
    offsetTop: 0,
    width: 1,
    height: 1,
    viewBackgroundColor: "#fbfcfd",
    selectedElementIds: {},
    selectedGroupIds: {},
    selectedLinearElement: null,
    editingLinearElement: null,
    currentItemStrokeColor: "#1a1a1a",
    currentItemStrokeWidth: 2,
    currentItemFontFamily: 2,
    currentItemFontSize: 48,
    currentItemAutoResize: true,
    gridModeEnabled: false,
    activeTool: { type: "hand" },
    ...(initial?.appState ?? {}),
  };
  const scrollListeners = new Set<BoardScrollHandler>();
  let onChange: BoardChangeHandler | null = null;
  const cursor = { value: "" };
  const undoStack: unknown[][] = [];
  const redoStack: unknown[][] = [];
  let applyingHistory = false;
  const HISTORY_LIMIT = 80;

  const cloneElements = (list: unknown[]): unknown[] =>
    JSON.parse(JSON.stringify(list)) as unknown[];

  const recordsHistory = (capture?: CaptureUpdate): boolean =>
    capture === CaptureUpdateAction.IMMEDIATELY || capture === CaptureUpdateAction.EVENTUALLY;

  const liveElements = () => elements.filter((raw) => !(raw as SceneEl).isDeleted);

  const notifyChange = () => {
    onChange?.(liveElements(), appState);
  };

  const notifyScroll = () => {
    const zoom = { value: zoomValue(appState) };
    const x = typeof appState.scrollX === "number" ? appState.scrollX : 0;
    const y = typeof appState.scrollY === "number" ? appState.scrollY : 0;
    for (const listener of scrollListeners) listener(x, y, zoom);
  };

  const api: ExcalidrawApi = {
    getSceneElements() {
      return liveElements();
    },
    getAppState() {
      return appState;
    },
    getFiles() {
      return files;
    },
    addFiles(next) {
      for (const file of next) files[file.id] = file;
    },
    updateScene(scene) {
      const prevX = appState.scrollX;
      const prevY = appState.scrollY;
      const prevZoom = zoomValue(appState);
      if (
        scene.elements &&
        !applyingHistory &&
        recordsHistory(scene.captureUpdate)
      ) {
        undoStack.push(cloneElements(elements));
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
        redoStack.length = 0;
      }
      if (scene.elements) elements = scene.elements;
      if (scene.appState) {
        const nextZoom = scene.appState.zoom;
        appState = { ...appState, ...scene.appState };
        if (nextZoom && typeof nextZoom === "object") {
          appState.zoom = {
            ...((typeof appState.zoom === "object" && appState.zoom) || {}),
            ...nextZoom,
          };
        }
      }
      const nextZoom = zoomValue(appState);
      const cameraMoved =
        prevX !== appState.scrollX || prevY !== appState.scrollY || prevZoom !== nextZoom;
      if (cameraMoved) notifyScroll();
      if (!isCameraOnly(scene)) notifyChange();
    },
    setActiveTool(tool) {
      appState = {
        ...appState,
        activeTool: { ...tool },
      };
    },
    setCursor(next) {
      cursor.value = next;
    },
    resetCursor() {
      cursor.value = "";
    },
    scrollToContent() {
      const [minX, minY, maxX, maxY] = getCommonBounds(api.getSceneElements());
      const width = typeof appState.width === "number" ? appState.width : 1;
      const height = typeof appState.height === "number" ? appState.height : 1;
      const zoom = zoomValue(appState);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      appState = {
        ...appState,
        scrollX: width / (2 * zoom) - cx,
        scrollY: height / (2 * zoom) - cy,
      };
      notifyScroll();
    },
    onScrollChange(callback) {
      scrollListeners.add(callback);
      return () => {
        scrollListeners.delete(callback);
      };
    },
    setOnChange(handler) {
      onChange = handler;
    },
    history: {
      clear() {
        undoStack.length = 0;
        redoStack.length = 0;
      },
      undo() {
        if (undoStack.length === 0) return false;
        redoStack.push(cloneElements(elements));
        applyingHistory = true;
        elements = undoStack.pop()!;
        appState = {
          ...appState,
          selectedElementIds: {},
          selectedGroupIds: {},
          selectedLinearElement: null,
          editingLinearElement: null,
        };
        applyingHistory = false;
        notifyChange();
        return true;
      },
      redo() {
        if (redoStack.length === 0) return false;
        undoStack.push(cloneElements(elements));
        applyingHistory = true;
        elements = redoStack.pop()!;
        appState = {
          ...appState,
          selectedElementIds: {},
          selectedGroupIds: {},
          selectedLinearElement: null,
          editingLinearElement: null,
        };
        applyingHistory = false;
        notifyChange();
        return true;
      },
      canUndo() {
        return undoStack.length > 0;
      },
      canRedo() {
        return redoStack.length > 0;
      },
    },
    refresh() {},
  };
  return api;
}
