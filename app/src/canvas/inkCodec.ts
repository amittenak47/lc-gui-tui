/**
 * Ink, stored at the precision it can actually be seen at.
 *
 * A `ScenePoint` is four IEEE doubles from a pointer event, and JSON writes
 * every digit of them: `{"x":640.1928100585938,"y":312.4111328125,
 * "pressure":0.4235294117647059,"slowness":0.5137254901960784}` is 107 bytes
 * for a dot the width of a hair. A handwritten word is sixty of those, an
 * annotated page is a few thousand, and a 1500-page textbook annotated
 * throughout came to 114 MB against a 5 MB budget — so the library stopped
 * being written long before the reader stopped writing.
 *
 * Nearly all of that is digits nobody can see. This module is the arithmetic
 * for saying so:
 *
 *   - **Coordinates in tenths of a scene unit, as deltas.** The renderer stamps
 *     the nib every `lineWidth * 0.55`, so consecutive points are one or two
 *     scene units apart — two or three digits instead of seven, and Int16
 *     rather than a double.
 *   - **Pressure and slowness as a byte.** Neither survives to the screen at
 *     anything like double precision; see the note on the quanta below.
 *   - **Erase ops keep geometry only.** Nothing reads their per-point payload.
 *
 * Quantising happens *here*, on the way to storage, and nowhere else. What is
 * in memory and on screen while writing is untouched — the nib is not the place
 * to economise.
 *
 * Nothing in here imports React or a store. It is arithmetic over plain
 * objects, so it can be proven in isolation, which for a lossy encoder standing
 * between someone and their handwriting is the whole point.
 */

import { NO_PRESSURE, type InkOp, type ScenePoint } from "./rasterInk";

/**
 * Scene units per stored unit. Tenths.
 *
 * The board column is ~760 scene units wide and the ink canvas supersamples at
 * 2×, so a tenth of a unit is a fraction of a device pixel — an order of
 * magnitude below the tolerance `smoothInkPoints` already applies with RDP
 * before any of this runs.
 */
const COORD_SCALE = 10;

/**
 * The value a byte channel cannot use for a real reading.
 *
 * Both channels have a state that is not a number and must survive the round
 * trip, so real values map to 0..254 and 255 is spoken for. The cost is one
 * level out of 255 — against the ~1/26 the renderer can actually express, that
 * is not a quantity anyone can perceive.
 */
const BYTE_SENTINEL = 255;
const BYTE_MAX = 254;

/** Int16 range in stored units: ±3276.7 scene units between two points. */
const DELTA_MIN = -32768;
const DELTA_MAX = 32767;

/**
 * One op, encoded. Field names are short because they are written verbatim into
 * every saved board.
 */
export interface EncodedOp {
  /** "d" draw, "e" erase. */
  k: "d" | "e";
  /** First point, absolute and unrounded — everything after is relative to it. */
  x0: number;
  y0: number;
  /** Points in the op, including the first. */
  n: number;
  /* draw only */
  c?: string;
  w?: number;
  f?: number;
  pc?: number;
  ps?: 0 | 1;
  si?: number;
  /** Soften speed-ink join/dwell discs (0–1); absent → paint uses device pref. */
  sbb?: number;
  /** Hold-pool amount at the tip (0–1); absent → derive from dwell samples. */
  btg?: number;
  /** Mid-stroke pooling stamps: x, y, grow, optional pressure, optional slowness. */
  bh?: { x: number; y: number; g: number; p?: number; s?: number }[];
  /** Pace wash toward pencil (0–1); absent on older speed-ink → full wash. */
  sf?: number;
  /** Nib material (0–1); absent → hard disc. */
  gr?: number;
  /** Opacity boost (0–3); absent → paint uses device pref. */
  ib?: number;
  /** Highlighter stroke — absent means an ordinary pen one. */
  hl?: 1;
  /** Nested horizontal scroll host — document-order index in the doc scope. */
  hk?: number;
  /** Host `scrollLeft` when the stroke was written (not point slowness). */
  hsl?: number;
  /** Stable stroke id for the global undo log. Absent on pre-shard blobs. */
  i?: number;
  /** Global composite order. Absent on pre-shard blobs. */
  s?: number;
  /* erase only */
  r?: number;
  /** `dx, dy` in tenths for each point after the first — length `2 * (n - 1)`. */
  xy: Int16Array;
  /** Draw only, one per point. */
  pr?: Uint8Array;
  /** Draw only, one per point; {@link BYTE_SENTINEL} means the key was absent. */
  sl?: Uint8Array;
}

export interface EncodedInk {
  v: 2;
  ops: EncodedOp[];
  /**
   * Ops the encoder declined to touch, in their original form.
   *
   * The overflow escape hatch — see {@link encodeInkOps}. Ordering across the
   * two lists is not preserved, which is safe: ink ops composite in order
   * within a layer, but a `raw` op is by construction one that moved farther
   * than a page in a single step, and there is no such stroke in practice.
   */
  raw?: InkOp[];
}

/** Real 0..1 → 0..254, with the sentinel kept clear. */
function packUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * BYTE_MAX);
}

function unpackUnit(byte: number): number {
  return byte / BYTE_MAX;
}

/**
 * Encode a stroke list for storage.
 *
 * An op whose points step farther than Int16 can carry is passed through
 * untouched in {@link EncodedInk.raw} rather than being silently mangled. That
 * cannot happen with stamp spacing as it exists — the step is a fraction of a
 * nib width — but "cannot happen" is exactly the assumption that turns into
 * corrupted handwriting when a future tool moves the nib differently, and the
 * escape hatch costs one comparison per point.
 */
export function encodeInkOps(ops: readonly InkOp[]): EncodedInk {
  const encoded: EncodedOp[] = [];
  const raw: InkOp[] = [];

  for (const op of ops) {
    const points = op.points;
    if (!Array.isArray(points) || points.length === 0) {
      // A pointerdown that never moved and never stamped. Nothing to draw and
      // nothing to encode, but dropping it silently would change the op count
      // the autosave fingerprints on, so it goes through as-is.
      raw.push(op);
      continue;
    }

    const draw = op.kind === "draw";
    const count = points.length;
    const deltas = new Int16Array((count - 1) * 2);
    const pressures = draw ? new Uint8Array(count) : undefined;
    const slownesses = draw ? new Uint8Array(count) : undefined;

    /*
     * Deltas accumulate against the *rounded* previous position, not the real
     * one. Rounding each delta independently against the true previous point
     * would let the error compound — a hundred points each off by 0.05 in the
     * same direction is a stroke that ends five units from where it was drawn.
     * Tracking the reconstruction as the decoder will see it keeps the error
     * bounded at half a tenth for every point, forever.
     */
    let prevX = points[0].x;
    let prevY = points[0].y;
    let overflowed = false;

    for (let i = 0; i < count; i += 1) {
      const point = points[i];
      if (i > 0) {
        const dx = Math.round((point.x - prevX) * COORD_SCALE);
        const dy = Math.round((point.y - prevY) * COORD_SCALE);
        if (dx < DELTA_MIN || dx > DELTA_MAX || dy < DELTA_MIN || dy > DELTA_MAX) {
          overflowed = true;
          break;
        }
        deltas[(i - 1) * 2] = dx;
        deltas[(i - 1) * 2 + 1] = dy;
        prevX += dx / COORD_SCALE;
        prevY += dy / COORD_SCALE;
      }
      if (pressures && slownesses) {
        pressures[i] =
          point.pressure === NO_PRESSURE ? BYTE_SENTINEL : packUnit(point.pressure);
        slownesses[i] =
          point.slowness === undefined ? BYTE_SENTINEL : packUnit(point.slowness);
      }
    }

    if (overflowed) {
      raw.push(op);
      continue;
    }

    const record: EncodedOp = {
      k: draw ? "d" : "e",
      x0: points[0].x,
      y0: points[0].y,
      n: count,
      xy: deltas,
    };
    if (draw) {
      record.c = op.color;
      record.w = op.baseWidth;
      record.f = op.maxFullness;
      record.pc = op.pressureClip;
      record.ps = op.pressureSensitive ? 1 : 0;
      if (op.speedInk !== undefined) record.si = op.speedInk;
      if (op.speedBlotBlend !== undefined) record.sbb = op.speedBlotBlend;
      if (op.blotTipGrow !== undefined) record.btg = op.blotTipGrow;
      if (op.blotHalts && op.blotHalts.length > 0) {
        record.bh = op.blotHalts.map((halt) => ({
          x: halt.x,
          y: halt.y,
          g: halt.grow,
          ...(halt.pressure != null ? { p: halt.pressure } : {}),
          ...(halt.slowness != null ? { s: halt.slowness } : {}),
        }));
      }
      if (op.speedFade !== undefined) record.sf = op.speedFade;
      if (op.grain !== undefined) record.gr = op.grain;
      if (op.boldness !== undefined) record.ib = op.boldness;
      if (op.highlight) record.hl = 1;
      if (op.hostKey !== undefined) record.hk = op.hostKey;
      if (op.scrollLeftAtDraw !== undefined) record.hsl = op.scrollLeftAtDraw;
      if (op.id != null) record.i = op.id;
      if (op.seq != null) record.s = op.seq;
      record.pr = pressures;
      record.sl = slownesses;
    } else {
      /*
       * Erase ops carry geometry and nothing else.
       *
       * `eraseStampsFrom` reads `x`, `y` and the op's `radius`; the `pressure`
       * and `slowness` written onto each erase point are read by nothing, here
       * or anywhere. They are also the ops that cost the most: erase points are
       * never thinned for storage, and are stamped every `radius * 0.45` — with
       * the smallest eraser that is a point every 0.79 scene units. Dropping
       * two dead bytes per point off the densest op in the file is the single
       * largest saving in this module.
       */
      record.r = op.radius;
      if (op.hostKey !== undefined) record.hk = op.hostKey;
      if (op.scrollLeftAtDraw !== undefined) record.hsl = op.scrollLeftAtDraw;
      if (op.id != null) record.i = op.id;
      if (op.seq != null) record.s = op.seq;
    }
    encoded.push(record);
  }

  return raw.length > 0 ? { v: 2, ops: encoded, raw } : { v: 2, ops: encoded };
}

/**
 * How much one encoded ink blob costs — Phase 0 telemetry.
 *
 * `encodedPayloadBytes` is the typed-array payload IndexedDB actually clones
 * (xy + pressure + slowness). That is the disk figure. Live RAM while writing
 * is the decoded `InkOp[]` (one object per point) and is estimated separately
 * because V8 hidden-class size is not something we can measure in Node tests
 * with any honesty beyond an order of magnitude.
 *
 * The codec header's "few thousand" points per dense page is {@link DENSE_PAGE_POINTS}.
 */
export const DENSE_PAGE_POINTS = 3000;

/** Conservative bytes per decoded point object in V8 (hidden class + 4 numbers). */
export const LIVE_POINT_RAM_BYTES = 96;

export interface InkStorageStats {
  ops: number;
  points: number;
  /** Int16 xy + Uint8 pressure/slowness. What IDB stores for inkC. */
  encodedPayloadBytes: number;
  /** JSON.stringify of the encoded blob — sidecar / daemon path, before gzip. */
  encodedJsonBytes: number;
  /** JSON.stringify of the live ops — the old 78 KB/page encoding. */
  rawJsonBytes: number;
  /** Order-of-magnitude live RAM for decoded point objects. */
  livePointRamBytes: number;
}

export function inkStorageStats(
  encoded: EncodedInk,
  rawOps?: readonly InkOp[],
): InkStorageStats {
  let points = 0;
  let encodedPayloadBytes = 0;
  for (const record of encoded.ops) {
    points += record.n;
    encodedPayloadBytes += record.xy.byteLength;
    encodedPayloadBytes += record.pr?.byteLength ?? 0;
    encodedPayloadBytes += record.sl?.byteLength ?? 0;
  }
  for (const op of encoded.raw ?? []) {
    points += op.points.length;
  }
  const encodedJsonBytes = jsonUtf8Bytes(encoded);
  const rawJsonBytes = rawOps ? jsonUtf8Bytes(rawOps) : 0;
  return {
    ops: encoded.ops.length + (encoded.raw?.length ?? 0),
    points,
    encodedPayloadBytes,
    encodedJsonBytes,
    rawJsonBytes,
    livePointRamBytes: points * LIVE_POINT_RAM_BYTES,
  };
}

function jsonUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Scale one measured dense page to a 1500-page textbook and ×4 snapshot copies.
 */
export function scaleInkStorage(
  oneDensePage: InkStorageStats,
  pages: number,
  snapshotCopies = 4,
): {
  pages: number;
  encodedPayloadBytes: number;
  encodedJsonBytes: number;
  rawJsonBytes: number;
  livePointRamBytes: number;
  encodedWithSnapshotsBytes: number;
} {
  const n = Math.max(0, pages);
  return {
    pages: n,
    encodedPayloadBytes: oneDensePage.encodedPayloadBytes * n,
    encodedJsonBytes: oneDensePage.encodedJsonBytes * n,
    rawJsonBytes: oneDensePage.rawJsonBytes * n,
    livePointRamBytes: oneDensePage.livePointRamBytes * n,
    encodedWithSnapshotsBytes: oneDensePage.encodedPayloadBytes * n * snapshotCopies,
  };
}

/**
 * Rebuild strokes for the renderer.
 *
 * Call this **once, at load**. The output is the same `InkOp[]` shape the
 * renderer has always used, and it must stay identity-stable: both
 * `consumedCache` in `rasterInk` and `opBoundsCache` in `inkTiles` are
 * `WeakMap`s keyed on the op object, so decoding afresh each frame would defeat
 * the two caches that make a dense page paint at all.
 */
export function decodeInkOps(encoded: EncodedInk): InkOp[] {
  const ops: InkOp[] = [];

  for (const record of encoded.ops) {
    const count = record.n;
    const points: ScenePoint[] = new Array(count);
    let x = record.x0;
    let y = record.y0;

    for (let i = 0; i < count; i += 1) {
      if (i > 0) {
        x += record.xy[(i - 1) * 2] / COORD_SCALE;
        y += record.xy[(i - 1) * 2 + 1] / COORD_SCALE;
      }
      if (record.k === "d") {
        const rawPressure = record.pr?.[i] ?? BYTE_SENTINEL;
        const rawSlowness = record.sl?.[i] ?? BYTE_SENTINEL;
        const point: ScenePoint = {
          x,
          y,
          pressure: rawPressure === BYTE_SENTINEL ? NO_PRESSURE : unpackUnit(rawPressure),
        };
        // Absent is not zero. `slowness: undefined` means "written before speed
        // ink, read as neutral"; `slowness: 0` means "flat out". Materialising
        // the key on every point would change how those strokes are drawn.
        if (rawSlowness !== BYTE_SENTINEL) point.slowness = unpackUnit(rawSlowness);
        points[i] = point;
      } else {
        // Erase points are read for position only — see the encoder. The
        // pressure field exists because `ScenePoint` requires it.
        points[i] = { x, y, pressure: NO_PRESSURE };
      }
    }

    if (record.k === "d") {
      const op: InkOp = {
        kind: "draw",
        color: record.c ?? "#000000",
        baseWidth: record.w ?? 2,
        maxFullness: record.f ?? 1,
        pressureClip: record.pc ?? 1,
        pressureSensitive: record.ps === 1,
        points,
      };
      if (record.si !== undefined) op.speedInk = record.si;
      if (record.sbb !== undefined) op.speedBlotBlend = record.sbb;
      if (record.btg !== undefined) op.blotTipGrow = record.btg;
      if (record.bh && record.bh.length > 0) {
        op.blotHalts = record.bh.map((halt) => ({
          x: halt.x,
          y: halt.y,
          grow: halt.g,
          ...(halt.p != null ? { pressure: halt.p } : {}),
          ...(halt.s != null ? { slowness: halt.s } : {}),
        }));
      }
      if (record.sf !== undefined) op.speedFade = record.sf;
      if (record.gr !== undefined) op.grain = record.gr;
      if (record.ib !== undefined) op.boldness = record.ib;
      if (record.hl === 1) op.highlight = true;
      if (record.hk !== undefined) op.hostKey = record.hk;
      if (typeof record.hsl === "number") op.scrollLeftAtDraw = record.hsl;
      if (typeof record.i === "number") op.id = record.i;
      if (typeof record.s === "number") op.seq = record.s;
      ops.push(op);
    } else {
      const erase: InkOp = { kind: "erase", radius: record.r ?? 1, points };
      if (record.hk !== undefined) erase.hostKey = record.hk;
      if (typeof record.hsl === "number") erase.scrollLeftAtDraw = record.hsl;
      if (typeof record.i === "number") erase.id = record.i;
      if (typeof record.s === "number") erase.seq = record.s;
      ops.push(erase);
    }
  }

  if (encoded.raw) ops.push(...encoded.raw);
  return ops;
}

/**
 * The ink on a board, whichever way it was written.
 *
 * Old entries carry `ink`, new ones carry `inkC`, and both keep loading
 * forever — there is no migration pass, because a migration is a thing that can
 * fail halfway through someone's library. Every read of board ink goes through
 * here; before this existed each caller cast `saved.ink as InkOp[]` blind, so
 * a board saved in the new shape would have opened with no handwriting on it
 * and no error to say why.
 */
export function inkOpsFrom(blob: { ink?: unknown; inkC?: unknown }): InkOp[] {
  // Revive first, unconditionally. A blob out of IndexedDB still has its typed
  // arrays and passes straight through; one that came back from the sidecar
  // file or the daemon has been through JSON, where an Int16Array becomes
  // `{"0":…,"1":…}`. Decoding that object indexes `undefined` at every step and
  // collapses a page of handwriting to a single point — with no error, which is
  // the worst way for this to fail. Doing it here means no caller has to know
  // which side of the wire its board arrived from.
  try {
    const encoded = reviveEncodedInk(blob.inkC);
    if (encoded) return decodeInkOps(encoded);
  } catch {
    // A truncated or hand-edited blob should cost the ink on one board, not the
    // ability to open it. Falling through to `ink` is usually nothing, which is
    // the same thing this returned before the codec existed.
  }
  // `unknown` rather than `InkOp[]` because most callers hold a board that came
  // off the wire or out of `JSON.parse`, where the cast was the thing being
  // trusted. One check here replaces six blind ones.
  return Array.isArray(blob.ink) ? (blob.ink as InkOp[]) : [];
}

/**
 * Reattach the typed arrays after a trip through JSON.
 *
 * The sidecar export and the daemon's board endpoint are strings, and
 * `JSON.stringify(new Int16Array([1,2]))` is `{"0":1,"1":2}` — an object that
 * decodes into `undefined`s and silently flattens a page of handwriting to a
 * single point. IndexedDB has no such problem (structured clone stores typed
 * arrays natively, which is most of why the numbers are worth encoding at all),
 * so this runs only on the string paths.
 */
export function reviveEncodedInk(value: unknown): EncodedInk | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { v?: unknown; ops?: unknown; raw?: unknown };
  if (candidate.v !== 2 || !Array.isArray(candidate.ops)) return null;
  const ops = candidate.ops.map((entry) => {
    // A truncated or hand-edited blob must fail here, loudly, rather than
    // decode into a stroke with one undefined point in it.
    if (!entry || typeof entry !== "object") {
      throw new TypeError("encoded ink contains a malformed op");
    }
    const record = { ...(entry as EncodedOp) };
    if (typeof record.n !== "number" || record.n < 0) {
      throw new TypeError("encoded ink op has no point count");
    }
    record.xy = toTyped(Int16Array, record.xy);
    if (record.pr) record.pr = toTyped(Uint8Array, record.pr);
    if (record.sl) record.sl = toTyped(Uint8Array, record.sl);
    return record;
  });
  const raw = Array.isArray(candidate.raw) ? (candidate.raw as InkOp[]) : undefined;
  return raw ? { v: 2, ops, raw } : { v: 2, ops };
}

function toTyped<T extends Int16Array | Uint8Array>(
  Ctor: { new (values: number[]): T; new (length: number): T },
  value: unknown,
): T {
  if (value instanceof Ctor) return value;
  if (Array.isArray(value)) return new Ctor(value as number[]);
  if (value && typeof value === "object") {
    // JSON turns a typed array into `{"0":…,"1":…}` — keys are indices.
    const source = value as Record<string, number>;
    const length = Object.keys(source).length;
    const out = new Ctor(length);
    for (let i = 0; i < length; i += 1) out[i] = source[String(i)] ?? 0;
    return out;
  }
  return new Ctor(0);
}

/**
 * Join per-page shards into one blob, in composite (`s`) order.
 *
 * Typed arrays are shared, not copied — the caller must not mutate a shard
 * after this returns. Used for snapshots and the sidecar, never on the
 * pointer path.
 */
export function concatEncodedInk(shards: readonly EncodedInk[]): EncodedInk {
  const ops: EncodedOp[] = [];
  const raw: InkOp[] = [];
  for (const shard of shards) {
    ops.push(...shard.ops);
    if (shard.raw) raw.push(...shard.raw);
  }
  ops.sort((a, b) => (a.s ?? 0) - (b.s ?? 0));
  raw.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return raw.length > 0 ? { v: 2, ops, raw } : { v: 2, ops };
}

const PACK_MAGIC = 0x436b6e69; // "inkC" little-endian

interface PackedOpMeta {
  k: EncodedOp["k"];
  x0: number;
  y0: number;
  n: number;
  xyN: number;
  prN: number;
  slN: number;
  c?: string;
  w?: number;
  f?: number;
  pc?: number;
  ps?: 0 | 1;
  si?: number;
  sbb?: number;
  btg?: number;
  bh?: EncodedOp["bh"];
  sf?: number;
  gr?: number;
  ib?: number;
  hl?: 1;
  hk?: number;
  hsl?: number;
  i?: number;
  s?: number;
  r?: number;
}

/**
 * Pack encoded ink into a byte envelope the worker can gzip.
 *
 * Eviction itself never goes through this — dirty WAL is structured-clone
 * `EncodedInk`. Gzip is a worker job on those bytes.
 */
export function packEncodedInk(encoded: EncodedInk): Uint8Array<ArrayBuffer> {
  const meta: PackedOpMeta[] = encoded.ops.map((op) => ({
    k: op.k,
    x0: op.x0,
    y0: op.y0,
    n: op.n,
    xyN: op.xy.length,
    prN: op.pr?.length ?? 0,
    slN: op.sl?.length ?? 0,
    ...(op.c != null ? { c: op.c } : {}),
    ...(op.w != null ? { w: op.w } : {}),
    ...(op.f != null ? { f: op.f } : {}),
    ...(op.pc != null ? { pc: op.pc } : {}),
    ...(op.ps != null ? { ps: op.ps } : {}),
    ...(op.si != null ? { si: op.si } : {}),
    ...(op.sbb != null ? { sbb: op.sbb } : {}),
    ...(op.btg != null ? { btg: op.btg } : {}),
    ...(op.bh != null ? { bh: op.bh } : {}),
    ...(op.sf != null ? { sf: op.sf } : {}),
    ...(op.gr != null ? { gr: op.gr } : {}),
    ...(op.ib != null ? { ib: op.ib } : {}),
    ...(op.hl != null ? { hl: op.hl } : {}),
    ...(op.hk != null ? { hk: op.hk } : {}),
    ...(op.hsl != null ? { hsl: op.hsl } : {}),
    ...(op.i != null ? { i: op.i } : {}),
    ...(op.s != null ? { s: op.s } : {}),
    ...(op.r != null ? { r: op.r } : {}),
  }));
  const metaBytes = new TextEncoder().encode(JSON.stringify({ meta, raw: encoded.raw }));
  let payload = 0;
  for (const op of encoded.ops) {
    payload += op.xy.byteLength + (op.pr?.byteLength ?? 0) + (op.sl?.byteLength ?? 0);
  }
  const out = new Uint8Array(12 + metaBytes.length + payload);
  const view = new DataView(out.buffer);
  view.setUint32(0, PACK_MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, metaBytes.length, true);
  out.set(metaBytes, 12);
  let offset = 12 + metaBytes.length;
  for (const op of encoded.ops) {
    out.set(new Uint8Array(op.xy.buffer, op.xy.byteOffset, op.xy.byteLength), offset);
    offset += op.xy.byteLength;
    if (op.pr) {
      out.set(new Uint8Array(op.pr.buffer, op.pr.byteOffset, op.pr.byteLength), offset);
      offset += op.pr.byteLength;
    }
    if (op.sl) {
      out.set(new Uint8Array(op.sl.buffer, op.sl.byteOffset, op.sl.byteLength), offset);
      offset += op.sl.byteLength;
    }
  }
  return out;
}

export function unpackEncodedInk(bytes: Uint8Array): EncodedInk | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== PACK_MAGIC) return null;
  if (view.getUint32(4, true) !== 1) return null;
  const metaLen = view.getUint32(8, true);
  if (metaLen < 0 || 12 + metaLen > bytes.length) return null;
  let parsed: { meta?: PackedOpMeta[]; raw?: InkOp[] };
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + metaLen))) as {
      meta?: PackedOpMeta[];
      raw?: InkOp[];
    };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.meta)) return null;
  let offset = 12 + metaLen;
  const ops: EncodedOp[] = [];
  for (const item of parsed.meta) {
    const xy = new Int16Array(item.xyN);
    new Uint8Array(xy.buffer).set(bytes.subarray(offset, offset + item.xyN * 2));
    offset += item.xyN * 2;
    let pr: Uint8Array | undefined;
    let sl: Uint8Array | undefined;
    if (item.prN > 0) {
      pr = bytes.subarray(offset, offset + item.prN).slice();
      offset += item.prN;
    }
    if (item.slN > 0) {
      sl = bytes.subarray(offset, offset + item.slN).slice();
      offset += item.slN;
    }
    const record: EncodedOp = {
      k: item.k,
      x0: item.x0,
      y0: item.y0,
      n: item.n,
      xy,
    };
    if (item.c != null) record.c = item.c;
    if (item.w != null) record.w = item.w;
    if (item.f != null) record.f = item.f;
    if (item.pc != null) record.pc = item.pc;
    if (item.ps != null) record.ps = item.ps;
    if (item.si != null) record.si = item.si;
    if (item.sbb != null) record.sbb = item.sbb;
    if (item.btg != null) record.btg = item.btg;
    if (item.bh != null) record.bh = item.bh;
    if (item.sf != null) record.sf = item.sf;
    if (item.gr != null) record.gr = item.gr;
    if (item.ib != null) record.ib = item.ib;
    if (item.hl != null) record.hl = item.hl;
    if (item.hk != null) record.hk = item.hk;
    if (item.hsl != null) record.hsl = item.hsl;
    if (item.i != null) record.i = item.i;
    if (item.s != null) record.s = item.s;
    if (item.r != null) record.r = item.r;
    if (pr) record.pr = pr;
    if (sl) record.sl = sl;
    ops.push(record);
  }
  const raw = Array.isArray(parsed.raw) ? parsed.raw : undefined;
  return raw ? { v: 2, ops, raw } : { v: 2, ops };
}
