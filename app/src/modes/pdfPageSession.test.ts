/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { PdfPageSession, sessionPathPages } from "./pdfPageSession";

function sheet(n: number) {
  return { blob: new Blob([String(n)]), width: 10, height: 12 };
}

describe("PdfPageSession", () => {
  it("drops the oldest sheet when the pagefile is full", () => {
    const session = new PdfPageSession(2);
    expect(session.put(1, sheet(1))).toEqual([]);
    expect(session.put(2, sheet(2))).toEqual([]);
    expect(session.put(3, sheet(3))).toEqual([1]);
    expect(session.has(1)).toBe(false);
    expect(session.has(2)).toBe(true);
    expect(session.has(3)).toBe(true);
    expect(session.size()).toBe(2);
  });

  it("treats a get as recently used, so the other page is the one paged out", () => {
    const session = new PdfPageSession(2);
    session.put(1, sheet(1));
    session.put(2, sheet(2));
    expect(session.get(1)?.width).toBe(10);
    expect(session.put(3, sheet(3))).toEqual([2]);
    expect(session.has(1)).toBe(true);
    expect(session.has(2)).toBe(false);
  });

  it("replacing a sheet does not evict a neighbour", () => {
    const session = new PdfPageSession(2);
    session.put(1, sheet(1));
    session.put(2, sheet(2));
    expect(session.put(1, sheet(9))).toEqual([]);
    expect(session.size()).toBe(2);
    expect(session.get(1)?.blob).toBeTruthy();
  });
});

describe("sessionPathPages", () => {
  it("walks from the settle page back toward where the flick started", () => {
    expect(sessionPathPages(10, 15, 200, 80)).toEqual([14, 13, 12, 11, 10]);
  });

  it("caps the path so a long flick cannot decode the whole book on settle", () => {
    expect(sessionPathPages(1, 50, 200, 5)).toEqual([49, 48, 47, 46, 45]);
  });

  it("walks forward when the flick was toward the front of the book", () => {
    expect(sessionPathPages(15, 10, 200, 80)).toEqual([11, 12, 13, 14, 15]);
  });

  it("is empty when settle did not move", () => {
    expect(sessionPathPages(12, 12, 200, 80)).toEqual([]);
  });
});
