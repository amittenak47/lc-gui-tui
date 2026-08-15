import { describe, expect, it } from "vitest";

import { nextTextareaHeight, parseCssPx } from "./fitTextareaHeight";

describe("nextTextareaHeight", () => {
  it("uses scrollHeight when there is no cap", () => {
    expect(nextTextareaHeight(48, null)).toBe(48);
  });

  it("caps at max so the thread above still has room", () => {
    expect(nextTextareaHeight(400, 132)).toBe(132);
  });

  it("does not grow when content is under the cap", () => {
    expect(nextTextareaHeight(52, 132)).toBe(52);
  });

  it("floors at min-height so an empty box is not 15px inline", () => {
    expect(nextTextareaHeight(15, 132, 52)).toBe(52);
  });
});

describe("parseCssPx", () => {
  it("reads a pixel cap", () => {
    expect(parseCssPx("132px")).toBe(132);
  });

  it("treats none as uncapped", () => {
    expect(parseCssPx("none")).toBeNull();
  });
});
