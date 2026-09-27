import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PDF_SIZE_CACHE_DOCS,
  decodePageSizes,
  encodePageSizes,
  loadPdfPageSizes,
  savePdfPageSizes,
} from "./pdfPageSizeCache";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
  });
});
afterEach(() => vi.unstubAllGlobals());

const book = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1, width: i === 5 ? 800 : 612, height: 792 }));

it("stores a mostly uniform book as a few runs and reads it back exactly", () => {
  const sizes = book(432);
  expect(encodePageSizes(sizes)).toEqual([[5, 612, 792], [1, 800, 792], [426, 612, 792]]);
  expect(decodePageSizes(encodePageSizes(sizes))).toEqual(sizes);
});

it("answers only for the same file with the same page count", () => {
  savePdfPageSizes("hash-a", book(10));
  expect(loadPdfPageSizes("hash-a", 10)).toEqual(book(10));
  expect(loadPdfPageSizes("hash-a", 11)).toBeNull();
  expect(loadPdfPageSizes("hash-b", 10)).toBeNull();
  expect(loadPdfPageSizes(null, 10)).toBeNull();
});

it("forgets the oldest books past the limit", () => {
  for (let i = 0; i <= PDF_SIZE_CACHE_DOCS; i += 1) savePdfPageSizes(`h${i}`, book(2));
  expect(loadPdfPageSizes("h0", 2)).toBeNull();
  expect(loadPdfPageSizes(`h${PDF_SIZE_CACHE_DOCS}`, 2)).toEqual(book(2));
});

it("rejects damaged entries rather than laying out garbage", () => {
  expect(decodePageSizes([[0, 612, 792]])).toBeNull();
  expect(decodePageSizes([[2, -1, 792]])).toBeNull();
  expect(decodePageSizes("nope")).toBeNull();
});
