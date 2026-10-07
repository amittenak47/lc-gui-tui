/** Prepare a complete legacy-inline conversion off the live stores. */
import type { BookIdentity } from "./syncState";
import type { InkPageRecord } from "./inkPageStore";
import { decodeInkOps, encodeInkOps, packEncodedInk, reviveEncodedInk } from "../canvas/inkCodec";
import type { InkOp } from "../canvas/rasterInk";
import { binOpsByPage } from "../canvas/inkPageIndex";
import { conflictPdfFrames } from "../components/conflictDocumentLayout";
import { pdfInkContextFromRecord } from "./pdfInkLayout";
import { validateInk } from "./syncContent";
import { localPageKey } from "./bookSnapshot";

export interface InlineBookConversion { record: Record<string, unknown>; rows: InkPageRecord[]; converted: boolean }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export async function convertInlineBook(owner: BookIdentity, original: Record<string, unknown>, changeSeq: number): Promise<InlineBookConversion> {
  const record = structuredClone(original), rows: InkPageRecord[] = [];
  if (owner.kind === "problem") {
    if (!object(record.board)) throw new Error("The saved problem canvas cannot be read. Its content was kept.");
    if (record.board.inkC !== undefined) {
      const encoded = reviveEncodedInk(record.board.inkC);
      if (!encoded) throw new Error("The saved problem handwriting cannot be decoded. Its content was kept.");
      await validateInk(packEncodedInk(encoded));
    } else if (record.board.ink !== undefined) {
      if (!Array.isArray(record.board.ink)) throw new Error("The saved problem handwriting cannot be decoded. Its content was kept.");
      await validateInk(packEncodedInk(encodeInkOps(record.board.ink as InkOp[])));
    }
    return { record, rows, converted: false };
  }
  const ctx = owner.kind === "annotate" ? pdfInkContextFromRecord(record) : null;
  let converted = false;
  const convert = async (board: unknown, key: string) => {
    if (!object(board)) throw new Error("The legacy board cannot be read. Its original data was kept.");
    if (board.inkC === undefined && board.ink === undefined) return;
    let encoded;
    if (board.inkC !== undefined) {
      encoded = reviveEncodedInk(board.inkC);
      if (!encoded) throw new Error("Legacy inline handwriting cannot be decoded. Its original data was kept.");
    } else {
      if (!Array.isArray(board.ink)) throw new Error("Legacy inline handwriting is malformed. Its original data was kept.");
      encoded = encodeInkOps(board.ink as InkOp[]);
    }
    await validateInk(packEncodedInk(encoded));
    const ops = decodeInkOps(encoded);
    if (!ops.length) { delete board.ink; delete board.inkC; converted = true; return; }
    const primaryPdf = key === owner.id && record.doc_type === "pdf";
    const frames = primaryPdf && ctx ? conflictPdfFrames(ctx.sizes, ctx.layout.w, ctx.layout.spread) : [];
    const bins = binOpsByPage(ops, frames);
    if (!bins.size) bins.set(primaryPdf && !ctx ? 0 : 1, []);
    for (const [id, values] of bins) {
      const pageId = primaryPdf && !ctx ? 0 : id;
      const inkC = bins.size === 1 ? encoded : { ...encodeInkOps(values), ...(encoded.layout ? { layout: encoded.layout } : ctx ? { layout: ctx.layout } : {}) };
      await validateInk(packEncodedInk(inkC));
      rows.push({ v: 1, docKey: localPageKey(owner, key), pageId, inkC, updatedAt: Number(record.updated_at ?? 0),
        dirty: true, changeSeq, syncedChangeSeq: 0, syncedRev: 0, baseWireHash: null, baseLocalHash: null, bootstrap: true,
        ...(primaryPdf && !ctx ? { layoutPending: true } : {}) });
    }
    delete board.ink; delete board.inkC; converted = true;
  };
  await convert(record.board, owner.id);
  if (owner.kind === "annotate" && object(record.footnote_boards)) for (const [id, child] of Object.entries(record.footnote_boards)) {
    if (!object(child)) throw new Error("A legacy scratch board cannot be read. Its original data was kept.");
    await convert(child.board, `${owner.id}/fn/${id}`);
  }
  return { record, rows, converted };
}
