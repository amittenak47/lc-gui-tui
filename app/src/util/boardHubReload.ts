import type { BoardBlob } from "../canvas/BoardHandle";
import { isAnnotatePageFrame } from "../templates/annotate";
import { linedPaperModeFromAppState } from "./linedPaperPref";

/** Camera belongs to this viewport; ruling belongs to the synced board. */
export function hubReloadAppState(
  live: BoardBlob["appState"], saved: BoardBlob["appState"],
): BoardBlob["appState"] {
  return {
    ...live,
    linedPaperMode: linedPaperModeFromAppState(saved),
    linedPitch: saved.linedPitch,
    linedPitchWide: saved.linedPitchWide,
    linedPitchCollege: saved.linedPitchCollege,
    linedRule: saved.linedRule,
  };
}

/** A live, measured document cannot become a short saved seed during an ink reload. */
export function hubReloadDocumentElements(saved: unknown[], live: unknown[]): unknown[] {
  type Frame = { id?: string; width?: number; height?: number; customData?: Record<string, unknown> };
  const frames = new Map(live.filter((el): el is Frame =>
    Boolean(el && typeof el === "object" && isAnnotatePageFrame(el as Frame)),
  ).map((el) => [el.id, el]));
  return saved.map((element) => {
    if (!element || typeof element !== "object") return element;
    const frame = element as Frame;
    const measured = frames.get(frame.id);
    if (!isAnnotatePageFrame(frame) || !measured || frame.width !== measured.width) return element;
    if (!Number.isFinite(measured.height) || (measured.height ?? 0) <= (frame.height ?? 0)) return element;
    return { ...frame, height: measured.height };
  });
}
