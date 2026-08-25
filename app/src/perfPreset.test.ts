import { describe, expect, it } from "vitest";

import {
  INK_LRU_RADIUS,
  PDF_FILM_DECODE_THUMBS,
  PDF_HOT_RADIUS,
  PDF_PAGEFILE,
  PDF_PATH_FILL,
  PDF_PREVIEW_SCALE,
  PDF_RENDER_SCALE,
  PDF_REST_SCALE,
  PERF_PRESET,
} from "./perfPreset";

describe("ultra-low preset", () => {
  it("is the active diagnostic quality knob", () => {
    expect(PERF_PRESET).toBe("ultra-low");
  });

  it("keeps a tiny GPU ring, rest 2× / preview 1×, no idle encode/fill", () => {
    expect(PDF_REST_SCALE).toBe(2);
    expect(PDF_PREVIEW_SCALE).toBe(1);
    expect(PDF_RENDER_SCALE).toBe(PDF_REST_SCALE);
    expect(PDF_HOT_RADIUS).toBe(1);
    expect(PDF_PAGEFILE).toBe(false);
    expect(PDF_PATH_FILL).toBe(false);
    expect(PDF_FILM_DECODE_THUMBS).toBe(false);
    expect(INK_LRU_RADIUS).toBe(1);
  });
});
