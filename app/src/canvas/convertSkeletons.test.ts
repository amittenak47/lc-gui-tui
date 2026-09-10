import { describe, expect, it } from "vitest";

import { convertToExcalidrawElements } from "./convertSkeletons";

describe("convertToExcalidrawElements", () => {
  it("reuses locked label ids when a diagram advances", () => {
    const make = (text: string) => convertToExcalidrawElements([{
      id: "viz-cell-0", type: "rectangle", x: 0, y: 0, width: 52, height: 52,
      locked: true, fontFamily: 3, customData: { lcVizId: "trace" }, label: { text },
    }], { regenerateIds: false }) as Array<{ id: string; locked: boolean; text?: string; fontFamily?: number }>;
    const first = make("1");
    const next = make("2");
    expect(first.map((el) => el.id)).toEqual(next.map((el) => el.id));
    expect(next.every((el) => el.locked)).toBe(true);
    expect(next[1]).toMatchObject({ text: "2", fontFamily: 3 });
  });

  it("keeps template ids and stamps metadata onto bound labels", () => {
    const out = convertToExcalidrawElements(
      [
        {
          id: "lcregion-student-frame",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          customData: { lcRegion: "student", lcRegionFrame: true },
          label: { text: "Student" },
        },
      ],
      { regenerateIds: false },
    ) as Array<{
      id: string;
      containerId?: string | null;
      customData?: { lcRegion?: string };
    }>;
    expect(out[0]?.id).toBe("lcregion-student-frame");
    expect(out[0]?.customData?.lcRegion).toBe("student");
    const label = out.find((el) => el.containerId === "lcregion-student-frame");
    expect(label?.customData?.lcRegion).toBe("student");
  });
});
