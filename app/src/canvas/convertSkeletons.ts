/**
 * Skeleton → scene elements. Used to be Excalidraw's convertToExcalidrawElements.
 */

import type { Skeleton } from "../templates/skeleton";
import { applyMetadata } from "./scene";

export type ConvertSkeletonInput = Skeleton & {
  fileId?: string;
  status?: string;
  scale?: [number, number];
};

let seed = 1;

function newId(): string {
  seed += 1;
  return `lc-${seed.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function baseElement(skeleton: ConvertSkeletonInput, id: string): Record<string, unknown> {
  const width = skeleton.width ?? 0;
  const height = skeleton.height ?? 0;
  return {
    id,
    type: skeleton.type,
    x: skeleton.x,
    y: skeleton.y,
    width,
    height,
    angle: skeleton.angle ?? 0,
    strokeColor: skeleton.strokeColor ?? "#1e1e1e",
    backgroundColor: skeleton.backgroundColor ?? "transparent",
    fillStyle: skeleton.fillStyle ?? "solid",
    strokeWidth: skeleton.strokeWidth ?? 2,
    strokeStyle: skeleton.strokeStyle ?? "solid",
    roughness: skeleton.roughness ?? 0,
    opacity: skeleton.opacity ?? 100,
    groupIds: [],
    frameId: null,
    roundness: skeleton.roundness ?? null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: skeleton.locked ?? false,
    customData: skeleton.customData ?? null,
  };
}

export function convertToExcalidrawElements(
  skeletons: readonly ConvertSkeletonInput[],
  opts?: { regenerateIds?: boolean },
): unknown[] {
  const regenerate = opts?.regenerateIds ?? true;
  const out: Record<string, unknown>[] = [];
  for (const skeleton of skeletons) {
    const id = !regenerate && skeleton.id ? skeleton.id : newId();
    const el = baseElement(skeleton, id);
    if (skeleton.type === "text") {
      el.text = skeleton.text ?? "";
      el.originalText = skeleton.text ?? "";
      el.fontSize = skeleton.fontSize ?? 20;
      el.fontFamily = skeleton.fontFamily ?? 2;
      el.lineHeight = skeleton.lineHeight ?? 1.25;
      el.textAlign = skeleton.textAlign ?? "left";
      el.verticalAlign = skeleton.verticalAlign ?? "top";
      el.autoResize = skeleton.autoResize ?? true;
      el.containerId = null;
      const lines = String(el.text).split("\n");
      if (!skeleton.width) el.width = Math.max(1, ...lines.map((line) => line.length * Number(el.fontSize) * 0.62));
      if (!skeleton.height) el.height = lines.length * Number(el.fontSize) * Number(el.lineHeight);
    }
    if (skeleton.type === "arrow" || skeleton.type === "line") {
      el.points = skeleton.points ?? [
        [0, 0],
        [skeleton.width ?? 0, skeleton.height ?? 0],
      ];
    }
    if (skeleton.type === "image") {
      el.fileId = skeleton.fileId;
      el.status = skeleton.status ?? "saved";
      el.scale = skeleton.scale ?? [1, 1];
    }
    if (skeleton.label?.text) {
      const labelId = !regenerate ? `${id}-label` : newId();
      const fontSize = skeleton.label.fontSize ?? 20;
      const label: Record<string, unknown> = {
        ...baseElement(
          {
            type: "text",
            x: skeleton.x,
            y: skeleton.y,
            width: skeleton.width ?? 100,
            height: fontSize * 1.25,
            text: skeleton.label.text,
            fontSize,
            strokeColor: skeleton.label.strokeColor ?? skeleton.strokeColor,
            textAlign: skeleton.label.textAlign ?? "center",
            verticalAlign: skeleton.label.verticalAlign ?? "middle",
            customData: skeleton.customData,
            locked: skeleton.locked,
            opacity: skeleton.opacity,
          },
          labelId,
        ),
        type: "text",
        text: skeleton.label.text,
        originalText: skeleton.label.text,
        fontSize,
        fontFamily: skeleton.fontFamily ?? 2,
        lineHeight: 1.25,
        textAlign: skeleton.label.textAlign ?? "center",
        verticalAlign: skeleton.label.verticalAlign ?? "middle",
        autoResize: true,
        containerId: id,
      };
      el.boundElements = [{ id: labelId, type: "text" }];
      out.push(el, label);
    } else {
      out.push(el);
    }
  }
  return applyMetadata(out as never, skeletons);
}
