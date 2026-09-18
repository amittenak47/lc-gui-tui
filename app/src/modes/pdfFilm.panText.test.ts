/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";

import {
  clearPdfTextHit,
  hidePdfPanText,
  PDF_PAN_TEXT_HIDDEN_CLASS,
  PDF_TEXT_HIT_CLASS,
  revealPdfPanText,
  syncPdfTextHit,
} from "./pdfFilm";

function page(n: number, filled: boolean) {
  const slot = document.createElement("div");
  slot.dataset.pdfPage = String(n);
  const text = document.createElement("div");
  text.className = "lc-pdf-text textLayer";
  if (filled) {
    const span = document.createElement("span");
    span.textContent = `p${n}`;
    text.append(span);
  }
  slot.append(text);
  return { slot, text };
}

describe("hidePdfPanText", () => {
  it("hides only the intersecting hosts, not the rest of the book", () => {
    const host = document.createElement("div");
    const p1 = page(1, true);
    const p2 = page(2, true);
    const p3 = page(3, true);
    host.append(p1.slot, p2.slot, p3.slot);
    const hidden = new Set<HTMLElement>();
    hidePdfPanText(host, [2], hidden);
    expect(p1.text.classList.contains(PDF_PAN_TEXT_HIDDEN_CLASS)).toBe(false);
    expect(p2.text.classList.contains(PDF_PAN_TEXT_HIDDEN_CLASS)).toBe(true);
    expect(p3.text.classList.contains(PDF_PAN_TEXT_HIDDEN_CLASS)).toBe(false);
    hidePdfPanText(host, [2, 3], hidden);
    expect(p1.text.classList.contains(PDF_PAN_TEXT_HIDDEN_CLASS)).toBe(false);
    expect(p3.text.classList.contains(PDF_PAN_TEXT_HIDDEN_CLASS)).toBe(true);
    expect(hidden.size).toBe(2);
    revealPdfPanText(hidden);
    expect(p2.text.classList.contains(PDF_PAN_TEXT_HIDDEN_CLASS)).toBe(false);
    expect(p3.text.classList.contains(PDF_PAN_TEXT_HIDDEN_CLASS)).toBe(false);
    expect(hidden.size).toBe(0);
  });

  it("does not hide every layer when the intersecting set is empty", () => {
    const host = document.createElement("div");
    const p1 = page(1, true);
    host.append(p1.slot);
    const hidden = new Set<HTMLElement>();
    hidePdfPanText(host, [], hidden);
    expect(p1.text.classList.contains(PDF_PAN_TEXT_HIDDEN_CLASS)).toBe(false);
    expect(hidden.size).toBe(0);
  });
});

describe("syncPdfTextHit", () => {
  it("marks only the intersecting hosts and drops pages that left", () => {
    const host = document.createElement("div");
    const p1 = page(1, true);
    const p2 = page(2, true);
    const p3 = page(3, true);
    host.append(p1.slot, p2.slot, p3.slot);
    const hit = new Set<HTMLElement>();
    syncPdfTextHit(host, [2], hit);
    expect(p1.text.classList.contains(PDF_TEXT_HIT_CLASS)).toBe(false);
    expect(p2.text.classList.contains(PDF_TEXT_HIT_CLASS)).toBe(true);
    expect(p3.text.classList.contains(PDF_TEXT_HIT_CLASS)).toBe(false);
    syncPdfTextHit(host, [3], hit);
    expect(p2.text.classList.contains(PDF_TEXT_HIT_CLASS)).toBe(false);
    expect(p3.text.classList.contains(PDF_TEXT_HIT_CLASS)).toBe(true);
    clearPdfTextHit(hit);
    expect(p3.text.classList.contains(PDF_TEXT_HIT_CLASS)).toBe(false);
    expect(hit.size).toBe(0);
  });
});
