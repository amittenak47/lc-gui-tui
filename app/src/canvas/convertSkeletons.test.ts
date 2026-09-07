import { describe, expect, it } from "vitest";

import { convertToExcalidrawElements } from "./convertSkeletons";

describe("convertToExcalidrawElements", () => {
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
