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
  knownInkSummary,
  summarizeEncodedInk,
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
import { isHostBoundOp, inkOpsBounds, unionSceneBounds, type InkEraseOp, type InkOp, type SceneBounds } from "./rasterInk";
import { opsAfterPartialErase, opsAfterStrokeErase, opsWithErasesBaked } from "./strokeEraser";

/** Ops on a stored page, without unpacking one that came with its summary. */
function encodedOpCount(encoded: EncodedInk): number {
  return knownInkSummary(encoded)?.n ?? encoded.ops.length + (encoded.raw?.length ?? 0);
}

/** Which strokes a page holds, by identity. A rebin moves strokes, never edits them. */
function opIdsKey(ops: readonly InkOp[]): string {
  return ops.map((op) => `${op.id}:${op.seq}`).sort().join(",");
}

/** Recently-evicted encoded pages kept in RAM so a short jump back is free. */
export const INK_COLD_CAP = 32;

export type InkUndoEntry =
  | { kind: "add"; pageId: number; op: InkOp }
  | { kind: "removeMany"; items: { pageId: number; op: InkOp }[] }
  | {
      kind: "replaceMany";
      removed: { pageId: number; op: InkOp }[];
      added: { pageId: number; op: InkOp }[];
    }
  | { kind: "clear"; pages: Map<number, EncodedInk> };

export class InkPageBook {
  frames: PageFrame[] = fallbackPageFrames(null);
  private usedFallback = true;
  /**
   * Everything held came back from storage, filed by page as it was saved,
   * and nothing has been written or binned since. See `setFrames`.
   */
  private storeOnly = false;
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
  /** Bumps on every mutation, including undo/redo that keep the same op count. */
  private generation = 0;
  private boundsByPage = new Map<number, SceneBounds | null>();

  undo: InkUndoEntry[] = [];
  redo: InkUndoEntry[] = [];

  pageIds(): number[] {
    // Hydration creates empty paint slots for the viewport and spanning ink.
    // They are not stored pages. Keep dirty/persisted empty shards, however:
    // those carry erasures and must still sync.
    const ids = new Set<number>([...this.onDisk, ...this.dirty]);
    for (const [id, ops] of this.hot) if (ops.length) ids.add(id);
    for (const [id, ink] of this.cold) if (encodedOpCount(ink)) ids.add(id);
    return [...ids].sort((a, b) => a - b);
  }

  opCount(): number {
    return this.opTotal;
  }

  revision(): number {
    return this.generation;
  }

  hasInk(): boolean {
    return this.opTotal > 0;
  }

  /** Nested-scroll observers must not sort the whole hot set to answer this. */
  hasHostBoundInk(): boolean {
    for (const ops of this.hot.values()) {
      for (const op of ops) {
        if (isHostBoundOp(op)) return true;
      }
    }
    return false;
  }

  dirtyCount(): number {
    return this.dirty.size;
  }

  /**
   * Install PDF (or fallback) frames, and rebin when that moves any page.
   *
   * Rebins when a real stack replaces the single-page fallback, so strokes
   * committed during layout land on the right shard — and whenever a page that
   * was already laid out moves, which is what switching a PDF between split
   * and whole sheets does. That second case used to keep every stroke in the
   * bin the old layout chose: a remapped sheet-118 stroke sat in a far-away
   * page's shard, out of the paint window and stored under the wrong page.
   * Pages only *appended* (the layout arriving in batches) move nothing.
   */
  setFrames(frames: readonly PageFrame[]): boolean {
    if (frames.length === 0) return false;
    const same =
      frames.length === this.frames.length &&
      frames.every((f, i) => {
        const cur = this.frames[i];
        return cur && cur.pageId === f.pageId && cur.minY === f.minY && cur.maxY === f.maxY &&
          cur.minX === f.minX && cur.maxX === f.maxX;
      });
    if (same) return false;
    const prevCount = this.frames.length;
    const shared = Math.min(prevCount, frames.length);
    let moved = false;
    for (let i = 0; i < shared && !moved; i += 1) {
      const cur = this.frames[i]!;
      const next = frames[i]!;
      moved = cur.pageId !== next.pageId || cur.minY !== next.minY || cur.maxY !== next.maxY;
    }
    const shouldRebin =
      this.opTotal > 0 &&
      frames.length > 1 &&
      (this.usedFallback || prevCount <= 1 || moved);
    /*
     * Ink read back from storage is already filed under the pages of the
     * layout it was saved in. A PDF's layout arrives after the ink does, so
     * every open replaced the stand-in frames and rebinned the whole book —
     * every page decoded, sorted and encoded again, two seconds of a tablet
     * before the splash could go. When each stored page's ink lies on that
     * page in the layout arriving, there is nothing to move.
     */
    const fromStandIn = this.usedFallback || prevCount <= 1;
    const misfiled = shouldRebin && fromStandIn && this.storeOnly ? this.shardsFit(frames) : "not as stored";
    const filed = shouldRebin && misfiled === null;
    if (shouldRebin && !filed) {
      // eslint-disable-next-line no-console
      console.info("[lc:open] ink rebinned for layout", JSON.stringify({ moved, fromStandIn, why: misfiled }));
    }
    this.frames = frames.slice();
    this.usedFallback = frames.length <= 1;
    if (shouldRebin && !filed) {
      /*
       * Rewrite only the pages whose strokes move. One stroke filed on the
       * stand-in page while the layout was arriving used to mark every page
       * dirty, so the whole book got a new stamp and the next Sync raised a
       * conflict for each page the other device had touched.
       */
      const held = new Map<number, string>();
      const all: InkOp[] = [];
      for (const pageId of new Set([...this.hot.keys(), ...this.cold.keys()])) {
        const hot = this.hot.get(pageId);
        const ops = hot ?? decodeInkOps(this.cold.get(pageId)!);
        all.push(...ops);
        if (ops.length) held.set(pageId, opIdsKey(ops));
      }
      all.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const wasDirty = new Set(this.dirty);
      const wasOnDisk = new Set(this.onDisk);
      this.replaceAll(all, { preserveIds: true });
      for (const [pageId, ops] of binOpsByPage(all, this.frames)) {
        if (wasDirty.has(pageId) || !wasOnDisk.has(pageId) || held.get(pageId) !== opIdsKey(ops)) continue;
        this.dirty.delete(pageId);
        this.onDisk.add(pageId);
      }
      return true;
    }
    return false;
  }

  /**
   * Whether every page's ink is where `frames` would file it — see
   * `setFrames`. As `pageIdForOp` files a stroke: on its page, touching no
   * other (the gap below a page is still that page's).
   */
  private shardsFit(frames: readonly PageFrame[]): string | null {
    const pageIds = new Set(frames.map((f) => f.pageId));
    for (const id of new Set([...this.hot.keys(), ...this.cold.keys()])) {
      if (id === SPANNING_PAGE_ID) continue;
      if (!this.boundsByPage.has(id)) {
        const hot = this.hot.get(id);
        this.boundsByPage.set(id, hot ? inkOpsBounds(hot) : summarizeEncodedInk(this.cold.get(id)!).b);
      }
      const bounds = this.boundsByPage.get(id);
      if (!bounds) continue;
      if (!pageIds.has(id)) return `page ${id} not in layout`;
      for (const f of frames) {
        if (f.pageId === id || f.maxY < bounds.minY || f.minY > bounds.maxY) continue;
        return `page ${id} ink reaches page ${f.pageId}`;
      }
    }
    return null;
  }

  /** Hydrate the LRU around `page`, evict the rest to encoded cold. */
  setVisiblePage(page: number): boolean {
    const next = Math.max(1, Math.floor(page) || 1);
    const last = lastPageId(this.frames);
    const wanted = new Set(lruWindow(next, last, this.radius));
    this.visiblePage = next;
    this.touchLru(next);

    let changed = false;
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

  /** Layout and camera fits must not decode the entire saved notebook. */
  inkBounds(): SceneBounds | null {
    let bounds: SceneBounds | null = null;
    for (const id of new Set([...this.hot.keys(), ...this.cold.keys()])) {
      if (!this.boundsByPage.has(id)) {
        const hot = this.hot.get(id);
        this.boundsByPage.set(id, hot
          ? inkOpsBounds(hot)
          : summarizeEncodedInk(this.cold.get(id)!).b);
      }
      bounds = unionSceneBounds(bounds, this.boundsByPage.get(id) ?? null);
    }
    return bounds;
  }

  /** Read a capture's page shards without hydrating or evicting the reading window. */
  opsInBounds(bounds: SceneBounds): InkOp[] {
    if (this.usedFallback) return this.assembleOps();
    const ids = new Set([SPANNING_PAGE_ID]);
    for (const frame of this.frames) {
      if (frame.maxY >= bounds.minY && frame.minY <= bounds.maxY) ids.add(frame.pageId);
    }
    const out: InkOp[] = [];
    for (const id of ids) {
      const hot = this.hot.get(id);
      if (hot) out.push(...hot);
      else {
        const encoded = this.cold.get(id);
        if (encoded) out.push(...decodeInkOps(encoded));
      }
    }
    return out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
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

  /** Attachment snapshots need clean empty pages as well as authored strokes. */
  snapshotEncodedPages(): Map<number, EncodedInk> {
    return new Map(this.pageIds().map(id => [id, this.encodedPage(id) ?? {v:2,ops:[]}]));
  }

  encodedPage(pageId: number): EncodedInk | null {
    const hot = this.hot.get(pageId);
    if (hot) return encodeInkOps(hot);
    return this.cold.get(pageId) ?? null;
  }

  takeDirtyEncoded(): Map<number, EncodedInk> {
    const out = new Map<number, EncodedInk>();
    for (const pageId of this.dirty) {
      const raw = this.encodedPage(pageId) ?? { v: 2, ops: [] };
      out.set(pageId, encodeInkOps(opsWithErasesBaked(decodeInkOps(raw))));
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
    this.boundsByPage.clear();
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
      this.opTotal += encodedOpCount(encoded);
      this.bumpCounters(encoded);
    }
    this.usedFallback = this.frames.length <= 1;
    this.setVisiblePage(this.visiblePage);
    this.bump();
    this.storeOnly = true;
  }

  /** Cold fill from IDB without marking dirty. */
  seedCold(pages: Iterable<[number, EncodedInk]>): void {
    for (const [pageId, encoded] of pages) {
      if (this.hot.has(pageId) || this.dirty.has(pageId)) continue;
      this.boundsByPage.delete(pageId);
      this.cold.set(pageId, encoded);
      this.onDisk.add(pageId);
    }
  }

  replaceAll(
    ops: readonly InkOp[],
    opts?: { preserveIds?: boolean; frames?: readonly PageFrame[] },
  ): void {
    this.storeOnly = false;
    this.boundsByPage.clear();
    // Every page that held ink before, so one left empty is written empty.
    const before = this.pageIds();
    // Bin by the layout these strokes are in. A caller replacing ink after a
    // layout change knows the new frames before the next paint window does.
    if (opts?.frames && opts.frames.length > 0) {
      this.frames = opts.frames.slice();
      this.usedFallback = this.frames.length <= 1;
    }
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
    /*
     * A page whose strokes all went elsewhere keeps its stored shard unless it
     * is told otherwise. Marking it dirty with nothing in it writes it empty —
     * the same path an erasure takes — instead of leaving the old copy on disk
     * (and on the hub) to come back beside the moved one.
     */
    for (const pageId of before) {
      if (!bins.has(pageId)) {
        this.dirty.add(pageId);
        this.onDisk.add(pageId);
      }
    }
    this.trimCold();
    this.bump();
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
    this.bump();
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
    this.bump();
    return this.paintOps();
  }

  /**
   * Pixel-eraser: cut the rub out of visible draw ops so remesh/save/sync
   * cannot put the ink back. `null` when the rub missed.
   */
  partialErase(erase: InkEraseOp): InkOp[] | null {
    const paint = this.paintOps();
    const clipped = opsAfterPartialErase(paint, erase);
    if (!clipped) return null;
    const nextOps = opsWithErasesBaked(clipped);
    const removed: { pageId: number; op: InkOp }[] = [];
    for (const [pageId, list] of this.hot) {
      for (const op of list) removed.push({ pageId, op });
    }
    const added: { pageId: number; op: InkOp }[] = [];
    for (const op of nextOps) {
      const stamped = this.ensureIdentity(op, op.id != null || op.seq != null);
      added.push({ pageId: pageIdForOp(stamped, this.frames), op: stamped });
    }
    this.hot.clear();
    for (const item of added) {
      const list = this.hot.get(item.pageId);
      if (list) list.push(item.op);
      else this.hot.set(item.pageId, [item.op]);
      this.markDirty(item.pageId);
    }
    for (const item of removed) this.markDirty(item.pageId);
    this.opTotal += added.length - removed.length;
    this.pushUndo({ kind: "replaceMany", removed, added });
    this.redo = [];
    this.setVisiblePage(this.visiblePage);
    this.bump();
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
    this.bump();
  }

  undoOnce(): InkUndoEntry | null {
    const entry = this.undo.pop();
    if (!entry) return null;
    this.applyInverse(entry);
    this.redo.push(entry);
    this.bump();
    return entry;
  }

  redoOnce(): InkUndoEntry | null {
    const entry = this.redo.pop();
    if (!entry) return null;
    this.applyForward(entry);
    this.undo.push(entry);
    this.bump();
    return entry;
  }

  canUndo(): boolean {
    return this.undo.length > 0;
  }

  canRedo(): boolean {
    return this.redo.length > 0;
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
    if (entry.kind === "replaceMany") {
      for (const item of entry.added) {
        this.removeOp(item.pageId, item.op);
        this.opTotal = Math.max(0, this.opTotal - 1);
        this.markDirty(item.pageId);
      }
      for (const item of entry.removed) {
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
      this.opTotal += encodedOpCount(encoded);
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
    if (entry.kind === "replaceMany") {
      for (const item of entry.removed) {
        this.removeOp(item.pageId, item.op);
        this.opTotal = Math.max(0, this.opTotal - 1);
        this.markDirty(item.pageId);
      }
      for (const item of entry.added) {
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
    this.boundsByPage.delete(pageId);
    this.cold.delete(pageId);
    this.touchLru(pageId);
    return true;
  }

  private evict(pageId: number): void {
    const list = this.hot.get(pageId);
    if (!list) return;
    this.cold.set(pageId, encodeInkOps(list));
    this.boundsByPage.delete(pageId);
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

  private bump(): void {
    this.generation += 1;
  }

  private markDirty(pageId: number): void {
    this.storeOnly = false;
    this.boundsByPage.delete(pageId);
    this.dirty.add(pageId);
  }

  private pushUndo(entry: InkUndoEntry): void {
    this.undo.push(entry);
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
    // From the stored page's summary where it has one: its strokes stay packed.
    const { i, s } = summarizeEncodedInk(encoded);
    if (i >= this.nextId) this.nextId = i + 1;
    if (s >= this.nextSeq) this.nextSeq = s + 1;
  }
}
