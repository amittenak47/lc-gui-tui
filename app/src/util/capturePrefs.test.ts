/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";

import {
  describeCaptureResult,
  loadCaptureCountdown,
  loadCaptureDestination,
  loadCaptureFolder,
  saveCaptureCountdown,
  saveCaptureDestination,
  saveCaptureFolder,
  shortPath,
  CAPTURE_COUNTDOWN_DEFAULT,
} from "./capturePrefs";

beforeEach(() => {
  localStorage.clear();
});

describe("capture destination", () => {
  it("defaults to the photo library", () => {
    expect(loadCaptureDestination()).toBe("photos");
  });

  it("round-trips every destination, including the new folder one", () => {
    for (const dest of ["photos", "downloads", "folder", "share"] as const) {
      saveCaptureDestination(dest);
      expect(loadCaptureDestination()).toBe(dest);
    }
  });

  it("falls back when the stored value is not one we know", () => {
    localStorage.setItem("lc.capture.destination", "dropbox");
    expect(loadCaptureDestination()).toBe("photos");
  });
});

describe("capture folder", () => {
  it("is empty until set", () => {
    expect(loadCaptureFolder()).toBe("");
  });

  it("trims what it stores, so a stray space is not a path", () => {
    saveCaptureFolder("  ~/Pictures/lc  ");
    expect(loadCaptureFolder()).toBe("~/Pictures/lc");
  });
});

describe("capture countdown", () => {
  it("defaults to a short countdown", () => {
    expect(loadCaptureCountdown()).toBe(CAPTURE_COUNTDOWN_DEFAULT);
  });

  it("round-trips the offered choices", () => {
    for (const seconds of [0, 3, 5]) {
      saveCaptureCountdown(seconds);
      expect(loadCaptureCountdown()).toBe(seconds);
    }
  });

  it("refuses a value that is not on the dial", () => {
    localStorage.setItem("lc.capture.countdown", "42");
    expect(loadCaptureCountdown()).toBe(CAPTURE_COUNTDOWN_DEFAULT);
  });
});

describe("describeCaptureResult", () => {
  it("names the place and the file when it has one", () => {
    expect(describeCaptureResult({ outcome: "photos", path: "/home/a/Pictures/lc/x.png" })).toContain(
      "x.png",
    );
    expect(describeCaptureResult({ outcome: "photos" })).toBe("Saved to Photos");
  });

  it("says so when nothing was written", () => {
    expect(describeCaptureResult({ outcome: "board-only" })).toBe("Added to the board");
  });

  it("carries the reason a save failed", () => {
    expect(describeCaptureResult({ outcome: "failed", detail: "permission denied" })).toContain(
      "permission denied",
    );
  });

  it("covers every outcome", () => {
    const outcomes = [
      "photos",
      "downloads",
      "folder",
      "shared",
      "downloaded",
      "board-only",
      "failed",
    ] as const;
    for (const outcome of outcomes) {
      expect(describeCaptureResult({ outcome }).length).toBeGreaterThan(0);
    }
  });
});

describe("shortPath", () => {
  it("leaves a path that already fits", () => {
    expect(shortPath("/a/b.png")).toBe("/a/b.png");
  });

  it("keeps the tail, which is what identifies the file", () => {
    const long = `/very/long/prefix${"/x".repeat(40)}/capture.png`;
    const short = shortPath(long);
    expect(short.length).toBeLessThanOrEqual(44);
    expect(short.endsWith("capture.png")).toBe(true);
    expect(short.startsWith("…")).toBe(true);
  });
});
