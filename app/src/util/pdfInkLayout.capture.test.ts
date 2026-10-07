import { afterEach, expect, it, vi } from "vitest";
import { savePdfPageSizes } from "../modes/pdfPageSizeCache";
import { conflictPdfFrames } from "../components/conflictDocumentLayout";
import { encodeInkOps, packEncodedInk, unpackEncodedInk } from "../canvas/inkCodec";
import { bytesToB64, b64ToBytes } from "../api/nativeHttp";
import { bytesFromMaybeGzip } from "./gzip";
import { pdfInkContextFromRecord, localizeHubInkDto } from "./pdfInkLayout";
import { validateInk } from "./syncContent";
import type { LcClient } from "../api/client";

afterEach(() => vi.unstubAllGlobals());
it("localizes a pinned page to captured layout without another unpinned record GET", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  const sizes = Array.from({ length: 40 }, (_, index) => ({ pageNumber: index + 1, width: 531, height: 666 }));
  savePdfPageSizes("captured-pdf", sizes);
  const record = { doc_type: "pdf", hash: "captured-pdf", board: { elements: [{ id: "lcmdink-0-frame", width: 760, customData: { lcMdInkFrame: true } }], appState: { pdfSpread: true } } };
  const context = pdfInkContextFromRecord(record)!;
  const frame = conflictPdfFrames(sizes, 642, false).find(page => page.pageId === 17)!;
  const encoded = { ...encodeInkOps([{ kind: "draw", color: "#112233", baseWidth: 2, maxFullness: 1, pressureClip: 1, pressureSensitive: false,
    points: [{ x: 200, y: frame.minY + 100, pressure: .5 }, { x: 220, y: frame.minY + 110, pressure: .5 }] }]), layout: { w: 642, spread: false } };
  const original = packEncodedInk(encoded), wire = await validateInk(original);
  const get = vi.fn(async () => { throw new Error("Unpinned reads are forbidden"); });
  const dto = await localizeHubInkDto({ getAnnotatePad: get } as unknown as LcClient,
    { kind: "annotate", key: "book", page_id: 17, updated_at: 1, rev: 9, hash: wire.wireHash, gz: bytesToB64(original) }, context, 642);
  expect(dto.page_id).toBe(17); expect(dto.hash).toBe(wire.wireHash); expect(get).not.toHaveBeenCalled();
  const local = await bytesFromMaybeGzip(b64ToBytes(dto.gz));
  expect(unpackEncodedInk(local)!.layout).toEqual({ w: 760, spread: true });
  expect((await validateInk(local)).wireHash).not.toBe(wire.wireHash);
  expect(pdfInkContextFromRecord(record)!.layout).toEqual(context.layout);
});
