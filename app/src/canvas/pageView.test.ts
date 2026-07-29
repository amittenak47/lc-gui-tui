import { describe, expect, it } from "vitest";

import {
  applyPageVisibility,
  clearPageVisibility,
  hasPagedElements,
  pageBounds,
  regionOfElement,
  type PageableElement,
} from "./pageView";
import { REGIONS } from "../templates/regions";

/** A dashed region frame, as the template seeds it. */
function frame(region: string, over?: Partial<PageableElement>): PageableElement {
  const authored = REGIONS[region as keyof typeof REGIONS];
  return {
    id: `lcregion-${region}`,
    type: "rectangle",
    x: authored.x,
    y: authored.y,
    width: authored.w,
    height: authored.h,
    customData: { lcRegion: region, lcRegionFrame: true },
    ...over,
  };
}

/** Something the student drew — untagged, placed by coordinates alone. */
function drawn(id: string, x: number, y: number): PageableElement {
  return { id, type: "freedraw", x, y, width: 40, height: 20 };
}

const TEMPLATE = [frame("constraints"), frame("code"), frame("approach")];

describe("page visibility", () => {
  it("hides every region but the open one, and puts them all back", () => {
    const scene = [...TEMPLATE, drawn("note", REGIONS.approach.x + 10, REGIONS.approach.y + 10)];

    const paged = applyPageVisibility(scene, "constraints");
    expect(paged).not.toBeNull();
    const byId = new Map(paged!.map((element) => [element.id, element]));
    expect(byId.get("lcregion-constraints")?.opacity).toBeUndefined();
    expect(byId.get("lcregion-code")?.opacity).toBe(0);
    expect(byId.get("lcregion-code")?.locked).toBe(true);
    // Untagged work follows the frame it was drawn in.
    expect(byId.get("note")?.opacity).toBe(0);

    const restored = clearPageVisibility(paged!);
    expect(hasPagedElements(restored)).toBe(false);
    expect(restored.find((element) => element.id === "note")?.opacity).toBe(100);
    expect(restored.find((element) => element.id === "lcregion-code")?.locked).toBe(false);
  });

  it("keeps an element's own locked state across a page turn", () => {
    const pinned = { ...drawn("pinned", REGIONS.code.x + 5, REGIONS.code.y + 5), locked: true, opacity: 60 };
    const hidden = applyPageVisibility([...TEMPLATE, pinned], "constraints")!;
    const restored = clearPageVisibility(hidden);
    const back = restored.find((element) => element.id === "pinned");
    expect(back?.locked).toBe(true);
    expect(back?.opacity).toBe(60);
    expect(back?.customData).toBeNull();
  });

  it("reports no change when the scene already matches the page", () => {
    const paged = applyPageVisibility(TEMPLATE, "code")!;
    expect(applyPageVisibility(paged, "code")).toBeNull();
    // …and desktop (no page) reveals everything again, once.
    const revealed = applyPageVisibility(paged, null);
    expect(revealed).not.toBeNull();
    expect(applyPageVisibility(revealed!, null)).toBeNull();
  });

  it("follows a frame the student resized rather than the authored box", () => {
    const moved = frame("code", { y: REGIONS.code.y + 400, height: 600 });
    const scene = [frame("constraints"), moved];
    const inside = drawn("inside", REGIONS.code.x + 20, REGIONS.code.y + 500);
    const rects = new Map([
      ["constraints", { x: REGIONS.constraints.x, y: REGIONS.constraints.y, w: REGIONS.constraints.w, h: REGIONS.constraints.h }],
      ["code", { x: moved.x!, y: moved.y!, w: moved.width!, h: moved.height! }],
    ]);
    expect(regionOfElement(inside, rects)).toBe("code");

    const bounds = pageBounds([...scene, inside], "code");
    expect(bounds).toEqual({
      minX: moved.x,
      minY: moved.y,
      maxX: moved.x! + moved.width!,
      maxY: moved.y! + moved.height!,
    });
  });

  it("leaves work that sits in no region alone", () => {
    const gutter = drawn("gutter", -900, -900);
    const paged = applyPageVisibility([...TEMPLATE, gutter], "constraints")!;
    expect(paged.find((element) => element.id === "gutter")?.opacity).toBeUndefined();
  });
});
