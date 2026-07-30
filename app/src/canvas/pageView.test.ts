import { describe, expect, it } from "vitest";

import {
  applyPageVisibility,
  clearPageVisibility,
  hasPagedElements,
  pageBounds,
  regionOfElement,
  type PageableElement,
} from "./pageView";
import { REGIONS, REGION_GUTTER } from "../templates/regions";

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

    // Half a gutter of padding, so ink just past the frame edge is not lost.
    const pad = REGION_GUTTER / 2;
    const bounds = pageBounds([...scene, inside], "code");
    expect(bounds).toEqual({
      minX: moved.x! - pad,
      minY: moved.y! - pad,
      maxX: moved.x! + moved.width! + pad,
      maxY: moved.y! + moved.height! + pad,
    });
  });

  it("gives work in the gutter to the page it sits under", () => {
    // Just below the Problem frame, in the gap before Code: it belongs to one
    // of them, not to all five.
    const inGutter = drawn("gutter", 200, REGIONS.constraints.y + REGIONS.constraints.h + 10);
    const onConstraints = applyPageVisibility([...TEMPLATE, inGutter], "constraints")!;
    expect(onConstraints.find((element) => element.id === "gutter")?.opacity).toBeUndefined();
    const onApproach = applyPageVisibility([...TEMPLATE, inGutter], "approach")!;
    expect(onApproach.find((element) => element.id === "gutter")?.opacity).toBe(0);
  });

  it("leaves work that sits off the board entirely alone", () => {
    const stray = drawn("stray", -9000, -9000);
    const paged = applyPageVisibility([...TEMPLATE, stray], "constraints")!;
    expect(paged.find((element) => element.id === "stray")?.opacity).toBeUndefined();
  });

  it("shows coach diagrams on the Coach page, not Walkthrough", () => {
    const board = [
      frame("walkthrough"),
      frame("agent"),
      {
        id: "lcviz-demo-cell-0",
        type: "rectangle",
        x: REGIONS.agent.x + 40,
        y: REGIONS.agent.y + 120,
        width: 48,
        height: 48,
        customData: { lcVizId: "demo", lcRegion: "agent" },
      } satisfies PageableElement,
    ];
    const onWalkthrough = applyPageVisibility(board, "walkthrough")!;
    expect(onWalkthrough.find((el) => el.id === "lcviz-demo-cell-0")?.opacity).toBe(0);

    const onCoach = applyPageVisibility(onWalkthrough, "agent")!;
    expect(onCoach.find((el) => el.id === "lcviz-demo-cell-0")?.opacity).toBe(100);
  });
});
