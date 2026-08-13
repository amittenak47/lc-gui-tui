/**
 * Decoded-ink LRU plus a global pointer undo log.
 *
 * The paint path used to hold every stroke in one `InkOp[]`. A dense textbook
 * is hundreds of MB of point objects; the tiles already drop off-screen
 * bitmaps, but `opsRef` still owned the whole book. This book keeps decoded
 * ops only for the current page ± {@link INK_LRU_RADIUS} (and the spanning
 * shard). Everything else stays as `EncodedInk` in a small cold map, ready to
 * hydrate on a jump or a Ctrl+Z that names a cold page.
 *
 * Undo is global, not per-page: draw on 1, scroll to 10, draw, go back, Ctrl+Z
 * must undo the page-10 stroke. A page-local stack would delete the page-1
 * stroke instead. The log stores the op itself (ops are immutable after
 * commit), not a snapshot of the whole list.
 */

import {
  concatEncodedInk,
  decodeInkOps,
  encodeInkOps,
  type EncodedInk,
} from "./inkCodec";
import {
  INK_LRU_RADIUS,
  SPANNING_PAGE_ID,
  binOpsByPage,
  fallbackPageFrames,
  lastPageId,
  lruWindow,
  pageIdForOp,
  type PageFrame,
} from "./inkPageIndex";
import type { InkEraseOp, InkOp } from "./rasterInk";
import { opsAfterStrokeErase } from "./strokeEraser";

export const INK_UNDO_CAP = 40;

/** Recently-evicted encoded pages kept in RAM so a short jump back is free. */
export const INK_COLD_CAP = 32;

export type InkUndoEntry =
  | { kind: "add"; pageId: number; op: InkOp }
  | { kind: "removeMany"; items: { pageId: number; op: InkOp }[] }
  | { kind: "clear"; pages: Map<number, EncodedInk> };

export class InkPageBook {
  frames: PageFrame[] = fallbackPageFrames(null);
  private usedFallback = true;
  visiblePage = 1;
  radius = INK_LRU_RADIUS;

  readonly hot = new Map<number, InkOp[]>();
  readonly cold = new Map<number, EncodedInk>();
  readonly dirty = new Set<number>();
  /** Pages known to have a copy in IDB — safe to drop from the cold RAM map. */
  readonly onDisk = new Set<number>();

  private nextId = 1;
  private nextSeq = 1;
  private lru: number[] = [];
  private opTotal = 0;

  undo: InkUndoEntry[] = [];
  redo: InkUndoEntry[] = [];

  pageIds(): number[] {
    const ids = new Set<number>();
    for (const id of this.hot.keys()) ids.add(id);
    for (const id of this.cold.keys()) ids.add(id);
    return [...ids].sort((a, b) => a - b);
  }

  opCount(): number {
    return this.opTotal;
  }

  hasInk(): boolean {
    return this.opTotal > 0;
  }

  dirtyCount(): number {
    return this.dirty.size;
  }

  /**
   * Install PDF (or fallback) frames. Rebins once when a real stack replaces
   * the single-page fallback so strokes committed during layout land on the
   * right shard.
   */
  setFrames(frames: readonly PageFrame[]): boolean {
    if (frames.length === 0) return false;
    const same =
      frames.length === this.frames.length &&
      frames.every((f, i) => {
        const cur = this.frames[i];
        return cur && cur.pageId === f.pageId && cur.minY === f.minY && cur.maxY === f.maxY;
      });
    if (same) return false;
    const shouldRebin = this.usedFallback && frames.length > 1 && this.opTotal > 0;
    this.frames = frames.slice();
    this.usedFallback = frames.length <= 1;
    if (shouldRebin) {
      const all = this.assembleOps();
      this.replaceAll(all, { preserveIds: true });
      return true;
    }
    return false;
  }

  /** Hydrate the LRU around `page`, evict the rest to encoded cold. */
  setVisiblePage(page: number): boolean {
    const next = Math.max(1, Math.floor(page) || 1);
    const last = lastPageId(this.frames);
    const wanted = new Set(lruWindow(next, last, this.radius));
    let changed = next !== this.visiblePage;
    this.visiblePage = next;
    this.touchLru(next);

    for (const pageId of wanted) {
      if (this.hot.has(pageId)) continue;
      if (this.hydrate(pageId)) changed = true;
    }
    for (const pageId of [...this.hot.keys()]) {
      if (wanted.has(pageId)) continue;
      if (pageId === SPANNING_PAGE_ID) continue;
      this.evict(pageId);
      changed = true;
    }
    this.trimCold();
    return changed;
  }

  paintOps(): InkOp[] {
    const out: InkOp[] = [];
    for (const ops of this.hot.values()) out.push(...ops);
    out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return out;
  }

  assembleOps(): InkOp[] {
    const out: InkOp[] = [];
    for (const [pageId, ops] of this.hot) {
      out.push(...ops);
      void pageId;
    }
    for (const [pageId, encoded] of this.cold) {
      if (this.hot.has(pageId)) continue;
      out.push(...decodeInkOps(encoded));
    }
    out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return out;
  }

  assembleEncoded(): EncodedInk {
    return concatEncodedInk(this.allEncodedShards());
  }

  allEncodedShards(): EncodedInk[] {
    const ids = this.pageIds();
    const shards: EncodedInk[] = [];
    for (const pageId of ids) {
      const encoded = this.encodedPage(pageId);
      if (encoded && (encoded.ops.length > 0 || (encoded.raw?.length ?? 0) > 0)) {
        shards.push(encoded);
      }
    }
    return shards;
  }

  encodedPage(pageId: number): EncodedInk | null {
    const hot = this.hot.get(pageId);
    if (hot) return encodeInkOps(hot);
    return this.cold.get(pageId) ?? null;
  }

  takeDirtyEncoded(): Map<number, EncodedInk> {
    const out = new Map<number, EncodedInk>();
    for (const pageId of this.dirty) {
      out.set(pageId, this.encodedPage(pageId) ?? { v: 2, ops: [] });
    }
    return out;
  }

  markFlushed(pageIds: Iterable<number>): void {
    for (const pageId of pageIds) {
      this.dirty.delete(pageId);
      this.onDisk.add(pageId);
    }
  }

  ingestEncodedPages(pages: Map<number, EncodedInk> | Iterable<[number, EncodedInk]>): void {
    this.hot.clear();
    this.cold.clear();
    this.dirty.clear();
    this.onDisk.clear();
    this.undo = [];
    this.redo = [];
    this.opTotal = 0;
    this.nextId = 1;
    this.nextSeq = 1;
    for (const [pageId, encoded] of pages) {
      this.cold.set(pageId, encoded);
      this.onDisk.add(pageId);
      this.opTotal += encoded.ops.length + (encoded.raw?.length ?? 0);
      this.bumpCounters(encoded);
    }
    this.usedFallback = this.frames.length <= 1;
    this.setVisiblePage(this.visiblePage);
  }

  /** Cold fill from IDB without marking dirty. */
  seedCold(pages: Iterable<[number, EncodedInk]>): void {
    for (const [pageId, encoded] of pages) {
      if (this.hot.has(pageId) || this.dirty.has(pageId)) continue;
      this.cold.set(pageId, encoded);
      this.onDisk.add(pageId);
    }
  }

  replaceAll(ops: readonly InkOp[], opts?: { preserveIds?: boolean }): void {
    this.hot.clear();
    this.cold.clear();
    this.dirty.clear();
    this.onDisk.clear();
    this.undo = [];
    this.redo = [];
    this.lru = [];
    if (!opts?.preserveIds) {
      this.nextId = 1;
      this.nextSeq = 1;
    }
    const stamped = ops.map((op) => this.ensureIdentity(op, opts?.preserveIds));
    const bins = binOpsByPage(stamped, this.frames);
    this.opTotal = stamped.length;
    const last = lastPageId(this.frames);
    const wanted = new Set(lruWindow(this.visiblePage, last, this.radius));
    for (const [pageId, list] of bins) {
      this.dirty.add(pageId);
      if (wanted.has(pageId) || pageId === SPANNING_PAGE_ID) {
        this.hot.set(pageId, list);
      } else {
        this.cold.set(pageId, encodeInkOps(list));
      }
    }
    if (!this.hot.has(SPANNING_PAGE_ID) && bins.has(SPANNING_PAGE_ID)) {
      this.hot.set(SPANNING_PAGE_ID, bins.get(SPANNING_PAGE_ID)!);
    }
    this.trimCold();
  }

  commit(op: InkOp): InkOp {
    const stamped = this.ensureIdentity(op);
    const pageId = pageIdForOp(stamped, this.frames);
    this.pushUndo({ kind: "add", pageId, op: stamped });
    this.redo = [];
    this.insert(pageId, stamped);
    this.opTotal += 1;
    this.markDirty(pageId);
    this.touchLru(pageId);
    return stamped;
  }

  /**
   * Stroke-eraser: drop whole draw ops the rub touched. Searches the hot set
   * (what the writer can see). Returns the kept paint list, or null if nothing
   * was hit — same contract as {@link opsAfterStrokeErase}.
   */
  strokeErase(erase: InkEraseOp): InkOp[] | null {
    const paint = this.paintOps();
    const kept = opsAfterStrokeErase(paint, erase);
    if (!kept) return null;
    const keptSet = new Set(kept);
    const removed: { pageId: number; op: InkOp }[] = [];
    for (const [pageId, list] of this.hot) {
      const next = list.filter((op) => {
        if (keptSet.has(op)) return true;
        if (op.kind !== "draw") return true;
        removed.push({ pageId, op });
        return false;
      });
      if (next.length !== list.length) {
        this.hot.set(pageId, next);
        this.markDirty(pageId);
      }
    }
    if (removed.length === 0) return null;
    this.opTotal -= removed.length;
    this.pushUndo({ kind: "removeMany", items: removed });
    this.redo = [];
    return this.paintOps();
  }

  clear(): void {
    if (this.opTotal === 0) return;
    const pages = new Map<number, EncodedInk>();
    for (const pageId of this.pageIds()) {
      const encoded = this.encodedPage(pageId);
      if (encoded) pages.set(pageId, encoded);
    }
    this.pushUndo({ kind: "clear", pages });
    this.redo = [];
    this.hot.clear();
    this.cold.clear();
    this.dirty.clear();
    for (const pageId of pages.keys()) this.dirty.add(pageId);
    this.opTotal = 0;
  }

  undoOnce(): boolean {
    const entry = this.undo.pop();
    if (!entry) return false;
    this.applyInverse(entry);
    this.redo.push(entry);
    return true;
  }

  redoOnce(): boolean {
    const entry = this.redo.pop();
    if (!entry) return false;
    this.applyForward(entry);
    this.undo.push(entry);
    return true;
  }

  canUndo(): boolean {
    return this.undo.length > 0 || this.opTotal > 0;
  }

  private applyInverse(entry: InkUndoEntry): void {
    if (entry.kind === "add") {
      this.removeOp(entry.pageId, entry.op);
      this.opTotal = Math.max(0, this.opTotal - 1);
      this.markDirty(entry.pageId);
      return;
    }
    if (entry.kind === "removeMany") {
      for (const item of entry.items) {
        this.hydrate(item.pageId);
        this.insert(item.pageId, item.op);
        this.opTotal += 1;
        this.markDirty(item.pageId);
      }
      return;
    }
    this.hot.clear();
    this.cold.clear();
    this.opTotal = 0;
    for (const [pageId, encoded] of entry.pages) {
      this.cold.set(pageId, encoded);
      this.opTotal += encoded.ops.length + (encoded.raw?.length ?? 0);
    }
    for (const pageId of entry.pages.keys()) this.markDirty(pageId);
    this.setVisiblePage(this.visiblePage);
  }

  private applyForward(entry: InkUndoEntry): void {
    if (entry.kind === "add") {
      this.hydrate(entry.pageId);
      this.insert(entry.pageId, entry.op);
      this.opTotal += 1;
      this.markDirty(entry.pageId);
      return;
    }
    if (entry.kind === "removeMany") {
      for (const item of entry.items) {
        this.removeOp(item.pageId, item.op);
        this.opTotal = Math.max(0, this.opTotal - 1);
        this.markDirty(item.pageId);
      }
      return;
    }
    this.hot.clear();
    this.cold.clear();
    this.opTotal = 0;
    this.dirty.clear();
    for (const pageId of entry.pages.keys()) this.markDirty(pageId);
  }

  private insert(pageId: number, op: InkOp): void {
    this.hydrate(pageId);
    const list = this.hot.get(pageId);
    if (list) list.push(op);
    else this.hot.set(pageId, [op]);
  }

  private removeOp(pageId: number, op: InkOp): void {
    this.hydrate(pageId);
    const list = this.hot.get(pageId);
    if (!list) return;
    const id = op.id;
    const next = id != null ? list.filter((item) => item.id !== id) : list.filter((item) => item !== op);
    this.hot.set(pageId, next);
  }

  private hydrate(pageId: number): boolean {
    if (this.hot.has(pageId)) return false;
    const encoded = this.cold.get(pageId);
    if (!encoded) {
      if (pageId === SPANNING_PAGE_ID || pageId === this.visiblePage) {
        this.hot.set(pageId, []);
      }
      return false;
    }
    this.hot.set(pageId, decodeInkOps(encoded));
    this.cold.delete(pageId);
    this.touchLru(pageId);
    return true;
  }

  private evict(pageId: number): void {
    const list = this.hot.get(pageId);
    if (!list) return;
    this.cold.set(pageId, encodeInkOps(list));
    this.hot.delete(pageId);
    this.touchLru(pageId);
  }

  private trimCold(): void {
    // Encoded cold pages are tens of MB for a dense textbook — cheap next to
    // decoded point objects. Dropping them here without an IDB round-trip on
    // hydrate would blank a jump to a page that had already been evicted from
    // RAM. The LRU still drops *decoded* ops; this map stays.
  }

  private touchLru(pageId: number): void {
    if (pageId === SPANNING_PAGE_ID) return;
    this.lru = this.lru.filter((id) => id !== pageId);
    this.lru.push(pageId);
  }

  private markDirty(pageId: number): void {
    this.dirty.add(pageId);
  }

  private pushUndo(entry: InkUndoEntry): void {
    this.undo.push(entry);
    if (this.undo.length > INK_UNDO_CAP) {
      this.undo.splice(0, this.undo.length - INK_UNDO_CAP);
    }
  }

  private ensureIdentity(op: InkOp, preserve = false): InkOp {
    const id = preserve && op.id != null ? op.id : this.nextId++;
    const seq = preserve && op.seq != null ? op.seq : this.nextSeq++;
    if (id >= this.nextId) this.nextId = id + 1;
    if (seq >= this.nextSeq) this.nextSeq = seq + 1;
    if (op.id === id && op.seq === seq) return op;
    return { ...op, id, seq };
  }

  private bumpCounters(encoded: EncodedInk): void {
    for (const record of encoded.ops) {
      if (typeof record.i === "number" && record.i >= this.nextId) this.nextId = record.i + 1;
      if (typeof record.s === "number" && record.s >= this.nextSeq) this.nextSeq = record.s + 1;
    }
    for (const op of encoded.raw ?? []) {
      if (typeof op.id === "number" && op.id >= this.nextId) this.nextId = op.id + 1;
      if (typeof op.seq === "number" && op.seq >= this.nextSeq) this.nextSeq = op.seq + 1;
    }
  }
}
