/** @vitest-environment jsdom */

/**
 * The handedness preference is read by CSS through a root attribute, so the
 * thing worth testing is the attribute — not the localStorage round-trip.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  applyHandednessAttr,
  installHandednessAttr,
  loadInkHandedness,
  saveInkHandedness,
} from "./inkHandedness";

afterEach(() => {
  document.documentElement.removeAttribute("data-handedness");
  localStorage.clear();
});

describe("applyHandednessAttr", () => {
  it("marks the root left-handed", () => {
    applyHandednessAttr("left");
    expect(document.documentElement.getAttribute("data-handedness")).toBe("left");
  });

  it("removes the attribute for a right-handed writer", () => {
    // Right-handed is the layout the stylesheet already describes — an
    // attribute nothing matches would only invite two spellings of every rule.
    applyHandednessAttr("left");
    applyHandednessAttr("right");
    expect(document.documentElement.hasAttribute("data-handedness")).toBe(false);
  });
});

describe("installHandednessAttr", () => {
  it("applies the stored preference on install", () => {
    saveInkHandedness("left");
    const stop = installHandednessAttr();
    expect(document.documentElement.getAttribute("data-handedness")).toBe("left");
    stop();
  });

  it("follows a Settings save while the app is open", () => {
    const stop = installHandednessAttr();
    window.dispatchEvent(new CustomEvent("lc-ink-handedness", { detail: "left" }));
    expect(document.documentElement.getAttribute("data-handedness")).toBe("left");
    window.dispatchEvent(new CustomEvent("lc-ink-handedness", { detail: "right" }));
    expect(document.documentElement.hasAttribute("data-handedness")).toBe(false);
    stop();
  });

  it("falls back to storage when an event carries no detail", () => {
    saveInkHandedness("left");
    const stop = installHandednessAttr();
    applyHandednessAttr("right");
    window.dispatchEvent(new Event("lc-ink-handedness"));
    expect(document.documentElement.getAttribute("data-handedness")).toBe("left");
    stop();
  });

  it("stops listening once torn down", () => {
    const stop = installHandednessAttr();
    stop();
    window.dispatchEvent(new CustomEvent("lc-ink-handedness", { detail: "left" }));
    expect(document.documentElement.hasAttribute("data-handedness")).toBe(false);
  });

  it("defaults to right when nothing is stored", () => {
    expect(loadInkHandedness()).toBe("right");
  });
});
