import { describe, expect, it } from "vitest";

import {
  INK_LRU_RADIUS,
  PDF_FILM_CACHE,
  PDF_FILM_RADIUS,
  PDF_PAGEFILE,
  PDF_PATH_FILL,
  PDF_PAINT_INFLIGHT,
  PDF_PREVIEW_CACHE,
  PDF_PREVIEW_RADIUS,
  PDF_PREVIEW_SCALE,
  PDF_RENDER_SCALE,
  PDF_REST_SCALE,
  PDF_SESSION_CAP,
} from "./perfPreset";

describe("mixed-quality PDF constants", () => {
  it("keeps rest 2, preview 0.25, inflight 1, pagefile and path-fill on", () => {
    expect(PDF_REST_SCALE).toBe(2);
    expect(PDF_PREVIEW_SCALE).toBe(0.25);
    expect(PDF_RENDER_SCALE).toBe(PDF_REST_SCALE);
    expect(PDF_PREVIEW_RADIUS).toBe(2);
    expect(PDF_PREVIEW_CACHE).toBe(5);
    expect(PDF_SESSION_CAP).toBe(80);
    expect(PDF_PAGEFILE).toBe(true);
    expect(PDF_PATH_FILL).toBe(true);
    expect(PDF_PAINT_INFLIGHT).toBe(1);
    expect(PDF_FILM_RADIUS).toBe(3);
    expect(PDF_FILM_CACHE).toBe(16);
    expect(INK_LRU_RADIUS).toBe(3);
  });
});
