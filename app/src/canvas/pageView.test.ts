import { describe, expect, it } from "vitest";

import {
  applyPageVisibility,
  clearPageVisibility,
  hasPagedElements,
  pageAtViewport,
  pageBounds,
  regionOfElement,
  viewportBand,
  type PageableElement,
} from "./pageView";
import { PAGE_BREAK, REGIONS, REGION_GUTTER, type RegionId } from "../templates/regions";

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

  /**
   * The bug the widened reach prevents: once the vertical gap grew past one
   * `REGION_GUTTER`, the middle of every break belonged to no page — and an
   * element that belongs to no page is shown on *every* page.
   */
  it("claims the whole page break, right down its middle", () => {
    const midBreak = drawn(
      "mid",
      200,
      REGIONS.constraints.y + REGIONS.constraints.h + PAGE_BREAK / 2,
    );
    const scene = [...TEMPLATE, midBreak];

    const shownSomewhere = ["constraints", "code", "approach"].map(
      (page) => applyPageVisibility(scene, page)!.find((el) => el.id === "mid")?.opacity !== 0,
    );
    expect(shownSomewhere.filter(Boolean)).toHaveLength(1);
  });
});

describe("viewportBand", () => {
  it("reads the scene band off an Excalidraw camera", () => {
    // Scrolled 500 down: scene y=500 is at the top of the screen.
    expect(viewportBand(-500, 1, 800)).toEqual({ top: 500, bottom: 1300 });
    // Origin.
    expect(viewportBand(0, 1, 800)).toEqual({ top: 0, bottom: 800 });
  });

  /** Zoomed out, one screen covers more board — the bug is forgetting to divide. */
  it("scales the band by the zoom", () => {
    expect(viewportBand(0, 0.5, 800)).toEqual({ top: 0, bottom: 1600 });
    expect(viewportBand(0, 2, 800)).toEqual({ top: 0, bottom: 400 });
  });

  it("has no band before the board is measured", () => {
    expect(viewportBand(0, 1, 0)).toBeNull();
    expect(viewportBand(0, 0, 800)).toBeNull();
  });

  /** The whole path, as Board runs it: camera in, page name out. */
  it("names the page under a real camera", () => {
    const onCode = viewportBand(-(REGIONS.code.y + 100), 1, 800)!;
    expect(
      pageAtViewport(TEMPLATE, ["constraints", "code", "approach"] as RegionId[], onCode.top, onCode.bottom),
    ).toBe("code");

    const onStatement = viewportBand(0, 1, 800)!;
    expect(
      pageAtViewport(TEMPLATE, ["constraints", "code", "approach"] as RegionId[], onStatement.top, onStatement.bottom),
    ).toBe("constraints");
  });
});

describe("pageAtViewport", () => {
  const ORDER = ["constraints", "code", "approach"] as const;
  /** Viewport spanning `height` scene units from `top`. */
  const at = (top: number, height: number) =>
    pageAtViewport(TEMPLATE, ORDER as unknown as RegionId[], top, top + height);

  it("names the page filling the viewport", () => {
    expect(at(REGIONS.constraints.y, 400)).toBe("constraints");
    expect(at(REGIONS.code.y + 200, 400)).toBe("code");
    expect(at(REGIONS.approach.y + 200, 400)).toBe("approach");
  });

  it("flips at the halfway point of a scroll between two pages", () => {
    const boundary = REGIONS.constraints.y + REGIONS.constraints.h;
    const view = 400;
    // Mostly still on the statement…
    expect(at(boundary - view * 0.75, view)).toBe("constraints");
    // …and mostly onto the code page.
    expect(at(boundary + PAGE_BREAK - view * 0.25, view)).toBe("code");
  });

  /** A short page wholly on screen beats the slivers of its neighbours. */
  it("prefers a page that fits entirely in the viewport", () => {
    const short = [
      frame("constraints", { y: 0, height: 200 }),
      frame("code", { y: 400, height: 300 }),
      frame("approach", { y: 900, height: 200 }),
    ];
    expect(pageAtViewport(short, ORDER as unknown as RegionId[], 350, 750)).toBe("code");
  });

  it("names nothing when the viewport is off the board", () => {
    expect(at(-50_000, 400)).toBeNull();
    expect(at(REGIONS.approach.y + REGIONS.approach.h + 10_000, 400)).toBeNull();
    // A degenerate camera is not a page.
    expect(pageAtViewport(TEMPLATE, ORDER as unknown as RegionId[], 100, 100)).toBeNull();
  });
});
