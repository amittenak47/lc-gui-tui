import type { InkOp } from "../canvas/rasterInk";
import type { ConflictInkSlot } from "./conflictInkLayout";

export interface ConflictInkTile extends ConflictInkSlot {
  key: string;
  offsetY: number;
}

/** Small backing stores near the viewport, not one giant canvas per notebook. */
export function conflictVisibleInkTiles(slots: readonly ConflictInkSlot[], top: number, height: number): ConflictInkTile[] {
  const low = Math.max(0, top - height), high = top + height * 2;
  const out: ConflictInkTile[] = [];
  for (const slot of slots) {
    if (slot.top > high || slot.top + slot.height < low) continue;
    const first = Math.max(0, Math.floor((low - slot.top) / 512));
    const last = Math.min(Math.ceil(slot.height / 512) - 1, Math.floor((high - slot.top) / 512));
    for (let index = first; index <= last; index++) {
      const offsetY = index * 512;
      out.push({ ...slot, key: `${slot.page}:${index}:${slot.width}:${slot.height}`, offsetY,
        top: slot.top + offsetY, height: Math.min(512, slot.height - offsetY) });
    }
  }
  return out.sort((a, b) => Math.abs(a.top + a.height / 2 - top - height / 2) - Math.abs(b.top + b.height / 2 - top - height / 2));
}

export interface ConflictPaintPage { page: number; ops: readonly InkOp[]; scale: number; originX: number; originY: number }
export interface ConflictPaintJob { key: string; page: number; width: number; height: number; offsetY: number; dpr: number }
export type ConflictPaintRequest = { type: "pages"; pages: ConflictPaintPage[] } | { type: "paint"; job: ConflictPaintJob };

export function conflictInkBackingSize(width: number, height: number, dpr: number) {
  const ratio = Math.min(Math.max(1, dpr || 1), 3, 4096 / Math.max(1, width));
  return { width: Math.max(1, Math.ceil(width * ratio)), height: Math.max(1, Math.ceil(height * ratio)), dpr: ratio };
}

