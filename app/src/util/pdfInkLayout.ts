/**
 * PDF ink between devices: source layout → the document → destination layout.
 *
 * PDF ink is stored as scene points of the layout it was written in, and the
 * layout is per device: the column width the copy was opened at, and whether
 * the reader splits sheets into two full-width halves. A tablet reading at 642
 * with split sheets and a desktop at 760 without them put the same mark at
 * different numbers. Pages crossed the hub as numbers, so the desktop drew the
 * tablet's sheet-45 ink on its own sheet 151.
 *
 * A page now says which layout it is in when it crosses the hub (a tag inside
 * its packed bytes, {@link EncodedInk.layout}). On arrival it is placed on the
 * document — sheet, half, fraction across, fraction down — and from there
 * into this device's layout, so every device stores its own numbers and the
 * board never sees another's. Pages from before the tag are placed by
 * {@link inferPdfInkLayout}: the layout in which each page's ink sits on its
 * own sheet.
 */

import type { InkPageDto, LcClient } from "../api/client";
import { b64ToBytes, bytesToB64 } from "../api/nativeHttp";
import {
  decodeInkOps,
  encodeInkOps,
  packEncodedInk,
  unpackEncodedInk,
  type EncodedInk,
  type PdfInkLayout,
} from "../canvas/inkCodec";
import { inkOpsBounds, type InkOp } from "../canvas/rasterInk";
import { conflictPdfFrames } from "../components/conflictDocumentLayout";
import { remapInkBetweenPdfLayouts } from "../modes/pdfInkSpread";
import { cachedPdfPageSizes, type PdfPageSize } from "../modes/pdfPageSizeCache";
import { annotateFrameWidthFromElements } from "../templates/annotate";
import { getAnnotateDoc } from "./annotateStore";
import { bytesFromMaybeGzip, gzipBytes } from "./gzip";

export type { PdfInkLayout };

/** This device's layout for a PDF, and the page sizes that turn it into frames. */
export interface PdfInkContext {
  layout: PdfInkLayout;
  sizes: readonly PdfPageSize[];
}

export function samePdfInkLayout(a: PdfInkLayout, b: PdfInkLayout): boolean {
  return a.w === b.w && a.spread === b.spread;
}

/**
 * The layout this device stores a PDF's ink in, or null when it cannot say:
 * not a PDF, or never opened here so its page sizes are unknown.
 */
export async function pdfInkContext(docId: string): Promise<PdfInkContext | null> {
  try {
    return await readPdfInkContext(docId);
  } catch {
    return null;
  }
}

async function readPdfInkContext(docId: string): Promise<PdfInkContext | null> {
  const doc = await getAnnotateDoc(docId);
  return doc ? pdfInkContextFromRecord({ doc_type: doc.docType, hash: doc.hash, board: doc.board }) : null;
}

/** Modern sync derives layout from the captured payload, never a later save. */
export function pdfInkContextFromRecord(record: Record<string, unknown> | null): PdfInkContext | null {
  if (!record || record.doc_type !== "pdf" || typeof record.hash !== "string") return null;
  const sizes = cachedPdfPageSizes(record.hash);
  if (!sizes?.length) return null;
  const board = record.board as { elements?: unknown; appState?: { pdfSpread?: unknown } } | null;
  const elements = Array.isArray(board?.elements) ? board.elements : [];
  const w = annotateFrameWidthFromElements(elements);
  if (!w) return null;
  let spread = board?.appState?.pdfSpread;
  if (typeof spread !== "boolean") {
    try { spread = localStorage.getItem(`whiteboard.pdfSpread.${record.hash}`) === "1"; } catch { spread = false; }
  }
  return { layout: { w, spread: Boolean(spread) }, sizes };
}

const framesCache = new Map<string, ReturnType<typeof conflictPdfFrames>>();
function framesFor(sizes: readonly PdfPageSize[], layout: PdfInkLayout) {
  const key = `${sizes.length}:${sizes[0]?.width}:${sizes[0]?.height}:${layout.w}:${layout.spread}`;
  let frames = framesCache.get(key);
  if (!frames) {
    frames = conflictPdfFrames(sizes, layout.w, layout.spread);
    if (framesCache.size > 64) framesCache.clear();
    framesCache.set(key, frames);
  }
  return frames;
}

/** Ink written in `from`, as the same marks on the document in `to`. */
export function convertPdfInkOps(
  ops: readonly InkOp[],
  from: PdfInkLayout,
  to: PdfInkLayout,
  sizes: readonly PdfPageSize[],
): InkOp[] {
  if (samePdfInkLayout(from, to) || ops.length === 0) return ops.slice();
  return remapInkBetweenPdfLayouts(ops, framesFor(sizes, from), framesFor(sizes, to), 0, from.w, {
    toWidth: to.w,
    clamp: false,
    keepIds: true,
  });
}

/** Whether `ops` sit on sheet `pageId` (page 0 is the spanning shard: no test). */
function fitsSheet(bounds: { minY: number; maxY: number }, pageId: number, frames: ReturnType<typeof conflictPdfFrames>): boolean {
  let lo = Infinity, hi = -Infinity;
  for (const frame of frames) {
    if (frame.pageId !== pageId) continue;
    lo = Math.min(lo, frame.minY);
    hi = Math.max(hi, frame.maxY);
  }
  if (!Number.isFinite(lo)) return false;
  // A stroke may run into the gap under its sheet; that still files to it.
  const slack = (hi - lo) * 0.04 + 24;
  return bounds.minY >= lo - slack && bounds.maxY <= hi + slack;
}

/**
 * The layout untagged pages were written in: the candidate in which the most
 * pages' ink sits on its own sheet. `hints` come first and win ties (this
 * device's layout, the hub copy's width); a coarse search over widths covers
 * a device nobody named. Null when no layout places any page.
 */
export function inferPdfInkLayout(
  pages: readonly { pageId: number; ops: readonly InkOp[] }[],
  sizes: readonly PdfPageSize[],
  hints: readonly PdfInkLayout[] = [],
): PdfInkLayout | null {
  const tests = pages
    .filter((page) => page.pageId > 0)
    .map((page) => ({ pageId: page.pageId, bounds: inkOpsBounds(page.ops.filter((op) => op.kind === "draw")) }))
    .filter((test): test is { pageId: number; bounds: NonNullable<typeof test.bounds> } => test.bounds != null);
  if (tests.length === 0) return null;
  const score = (layout: PdfInkLayout) => {
    const frames = framesFor(sizes, layout);
    return tests.reduce((n, test) => n + (fitsSheet(test.bounds, test.pageId, frames) ? 1 : 0), 0);
  };
  let best: PdfInkLayout | null = null;
  let bestScore = 0;
  const consider = (layout: PdfInkLayout) => {
    const s = score(layout);
    if (s > bestScore) { best = layout; bestScore = s; }
  };
  for (const hint of hints) {
    consider(hint);
    consider({ w: hint.w, spread: !hint.spread });
  }
  if (bestScore === tests.length) return best;
  // Nobody named the layout: a band of widths fits page positions alike, so
  // take the middle of the best band rather than its edge.
  const scored: { layout: PdfInkLayout; s: number }[] = [];
  for (const spread of [false, true]) {
    for (let w = 240; w <= 2400; w += 4) scored.push({ layout: { w, spread }, s: score({ w, spread }) });
  }
  const top = Math.max(bestScore, ...scored.map((entry) => entry.s));
  if (top === 0) return null;
  if (top === bestScore && best) return best;
  const band = scored.filter((entry) => entry.s === top);
  const spread = band[0]!.layout.spread;
  const widths = band.filter((entry) => entry.layout.spread === spread).map((entry) => entry.layout.w);
  return { w: widths[Math.floor(widths.length / 2)]!, spread };
}

async function unpackGz(gz: string): Promise<EncodedInk | null> {
  try { return unpackEncodedInk(await bytesFromMaybeGzip(b64ToBytes(gz))); } catch { return null; }
}

async function packGz(encoded: EncodedInk): Promise<string> {
  return bytesToB64(await gzipBytes(packEncodedInk(encoded)));
}

/** A hub page already in this device's layout. Not on the wire. */
export type LocalizedInkPageDto = InkPageDto & { localized?: true };

/** The hub copy's column width, a hint for pages from before the tag. Fetched once per pad. */
const hubWidths = new Map<string, Promise<number | null>>();
export function hubPdfWidth(client: LcClient | null | undefined, docId: string): Promise<number | null> {
  if (!client) return Promise.resolve(null);
  let width = hubWidths.get(docId);
  if (!width) {
    width = client.getAnnotatePad(docId)
      .then((pad) => {
        const elements = (pad?.board as { elements?: unknown } | null)?.elements;
        return Array.isArray(elements) ? annotateFrameWidthFromElements(elements) : null;
      })
      .catch(() => null);
    hubWidths.set(docId, width);
  }
  return width;
}

/**
 * The layout a page arriving from the hub was written in: its tag, or failing
 * that the layout that puts its ink on its own sheet.
 */
export async function sourcePdfInkLayout(
  docId: string,
  encoded: EncodedInk,
  pageId: number,
  ops: readonly InkOp[],
  ctx: PdfInkContext,
  hubWidth: number | null,
): Promise<PdfInkLayout> {
  if (encoded.layout) return encoded.layout;
  const hints: PdfInkLayout[] = [];
  const seen = inferredByDoc.get(docId);
  if (seen) hints.push(seen);
  hints.push(ctx.layout);
  if (hubWidth && hubWidth !== ctx.layout.w) hints.push({ w: hubWidth, spread: ctx.layout.spread });
  // Spanning ink (page 0) has no sheet of its own to test against: it takes
  // the layout this pad's other pages turned out to be in.
  if (pageId < 1) return seen ?? ctx.layout;
  const found = inferPdfInkLayout([{ pageId, ops }], ctx.sizes, hints) ?? ctx.layout;
  inferredByDoc.set(docId, found);
  return found;
}

/** The layout untagged pages of each pad were last found in this session. */
const inferredByDoc = new Map<string, PdfInkLayout>();

/**
 * A hub page of a PDF's ink, moved into this device's layout. Unchanged (and
 * unmarked) when the pad is not a PDF here or its page sizes are not known
 * yet; {@link localizePendingPdfInk} catches those on open.
 */
export async function localizeHubInkDto(
  client: LcClient | null | undefined,
  dto: InkPageDto,
  ctxIn?: PdfInkContext | null,
  capturedHubWidth?: number | null,
): Promise<LocalizedInkPageDto> {
  if (dto.kind !== "annotate" || !dto.gz || dto.key.includes("/fn/")) return dto;
  const ctx = ctxIn === undefined ? await pdfInkContext(dto.key) : ctxIn;
  if (!ctx) return dto;
  const encoded = await unpackGz(dto.gz);
  if (!encoded) return dto;
  const ops = decodeInkOps(encoded);
  const from = await sourcePdfInkLayout(dto.key, encoded, dto.page_id, ops, ctx,
    capturedHubWidth === undefined ? await hubPdfWidth(client, dto.key) : capturedHubWidth);
  if (samePdfInkLayout(from, ctx.layout)) return { ...dto, localized: true };
  const moved = convertPdfInkOps(ops, from, ctx.layout, ctx.sizes);
  return { ...dto, gz: await packGz({ ...encodeInkOps(moved), layout: ctx.layout }), localized: true };
}

/**
 * Bytes to send for one of this device's pages: tagged with this device's
 * layout, so the device that receives them can place them. Non-PDF pads and
 * pages that never reached this layout go as they are.
 */
export async function tagOutgoingPdfInk(gz: Uint8Array<ArrayBuffer>, ctx: PdfInkContext | null): Promise<Uint8Array<ArrayBuffer>> {
  if (!ctx) return gz;
  try {
    const encoded = unpackEncodedInk(await bytesFromMaybeGzip(gz));
    if (!encoded || encoded.layout) return gz;
    return await gzipBytes(packEncodedInk({ ...encoded, layout: ctx.layout }));
  } catch {
    return gz;
  }
}
