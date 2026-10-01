import { describe, expect, it } from "vitest";

import { inlineMarkdownImages, isLocalImageTarget, localImageRefs, normalizePath } from "./markdownImages";

const png = (bytes: number[]) => new Blob([new Uint8Array(bytes)], { type: "image/png" });

describe("local image references", () => {
  it("finds pictures beside the note, in every way markdown can point at one", () => {
    const source = [
      "![plot](figures/plot.png)",
      '![titled](./figures/a%20b.png "A title")',
      '<img src="figures/raw.jpg" width="40">',
      "![ref][fig]",
      "[fig]: figures/ref.svg",
      "![web](https://example.com/x.png) ![data](data:image/png;base64,AAAA) ![root](/abs.png)",
      "[not an image](notes.pdf)",
    ].join("\n\n");
    expect(localImageRefs(source)).toEqual([
      "figures/plot.png",
      "./figures/a%20b.png",
      "figures/raw.jpg",
      "figures/ref.svg",
    ]);
  });

  it("leaves addresses, data and rooted paths alone", () => {
    for (const target of ["https://x/y.png", "data:image/png;base64,AA", "/a.png", "#x", "mailto:a@b"]) {
      expect(isLocalImageTarget(target)).toBe(false);
    }
  });

  it("normalizes paths the way a folder listing spells them", () => {
    expect(normalizePath("notes/./figures/../figures/a%20b.png")).toBe("notes/figures/a b.png");
    expect(normalizePath("notes\\figures\\c.png")).toBe("notes/figures/c.png");
  });
});

describe("inlining", () => {
  it("writes each picture into the note, resolved from where the note sits", async () => {
    const files = [
      { path: "course/week3/notes.md", file: new Blob(["# Notes"]) },
      { path: "course/week3/figures/plot.png", file: png([1, 2, 3]) },
      { path: "course/week9/figures/plot.png", file: png([9, 9, 9]) },
    ];
    const out = await inlineMarkdownImages("![p](figures/plot.png) and ![q](figures/gone.png)", "notes.md", files);
    expect(out.inlined).toEqual(["figures/plot.png"]);
    expect(out.missing).toEqual(["figures/gone.png"]);
    // The week3 figure, not week9's file of the same name.
    expect(out.text).toContain(`![p](data:image/png;base64,${btoa("\x01\x02\x03")})`);
    expect(out.text).toContain("![q](figures/gone.png)");
  });

  it("falls back to the only file of that name when the path does not match", async () => {
    const files = [{ path: "pics/diagram.svg", file: new Blob(["<svg/>"], { type: "" }) }];
    const out = await inlineMarkdownImages('<img src="figures/diagram.svg">', "notes.md", files);
    expect(out.text).toBe(`<img src="data:image/svg+xml;base64,${btoa("<svg/>")}">`);
  });
});
