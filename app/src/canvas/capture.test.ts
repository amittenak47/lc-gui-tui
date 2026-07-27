import { describe, expect, it } from "vitest";

import {
  captureStrokes,
  captureStructure,
  captureTypedText,
  elementIds,
  resolveCaptureIds,
  sceneHash,
  strokeDelta,
  studentAuthoredElements,
  studentElements,
  type SceneElementLike,
} from "./capture";
import { mergeRecognized, NoopRecognizer, pickRecognizer, type InkRecognizer } from "./ink";

function element(overrides: Partial<SceneElementLike> & { id: string }): SceneElementLike {
  return {
    type: "freedraw",
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    version: 1,
    ...overrides,
  };
}

describe("studentElements", () => {
  it("drops deleted elements", () => {
    const scene = [element({ id: "a" }), element({ id: "b", isDeleted: true })];
    expect(studentElements(scene).map((el) => el.id)).toEqual(["a"]);
  });

  it("excludes the coach's own diagrams", () => {
    // Otherwise the coach reads its own injected output back as if the student
    // had drawn it, and starts agreeing with itself.
    const scene = [
      element({ id: "mine" }),
      element({ id: "coach", customData: { lcVizId: "nums" } }),
    ];
    expect(studentElements(scene).map((el) => el.id)).toEqual(["mine"]);
  });
});

describe("studentAuthoredElements", () => {
  it("keeps only what the student put down, not the seeded template", () => {
    // This is the submit gate: a board carrying nothing but the problem
    // statement is empty, and one shape of their own is not.
    const scene = [
      element({ id: "frame", customData: { lcRegion: "approach" } }),
      element({ id: "statement", customData: { lcRegion: "constraints" } }),
      element({ id: "coach", customData: { lcVizId: "nums" } }),
      element({ id: "theirs", type: "rectangle" }),
    ];
    expect(studentAuthoredElements(scene).map((el) => el.id)).toEqual(["theirs"]);
    expect(studentAuthoredElements(scene.slice(0, 3))).toHaveLength(0);
  });
});

describe("captureStructure", () => {
  it("strips to id, type, position, size and text", () => {
    const scene = [
      element({ id: "abcdefghij", type: "rectangle", x: 10.4, y: 20.6, width: 99.5, height: 50.2 }),
    ];
    expect(captureStructure(scene)).toEqual([
      { id: "abcdefgh", type: "rectangle", x: 10, y: 21, w: 100, h: 50 },
    ]);
  });

  it("keeps short ids intact and includes typed text and the region", () => {
    const scene = [
      element({ id: "t", type: "text", text: "two pointers", customData: { lcRegion: "approach" } }),
    ];
    expect(captureStructure(scene)[0]).toMatchObject({
      id: "t",
      type: "text",
      text: "two pointers",
      region: "approach",
    });
  });

  it("omits empty text rather than sending blank fields", () => {
    const scene = [element({ id: "t", type: "text", text: "   " })];
    expect(captureStructure(scene)[0].text).toBeUndefined();
  });

  it("ids are stable across a re-capture", () => {
    const scene = [element({ id: "stable-id-xyz", type: "text", text: "hi" })];
    expect(captureStructure(scene)[0].id).toBe(captureStructure(scene)[0].id);
    expect(captureStructure(scene)[0].id).toBe("stable-i");
  });
});

describe("resolveCaptureIds", () => {
  it("matches truncated prefixes back to live elements", () => {
    const scene = [
      element({ id: "abcdefghij", type: "text", text: "a" }),
      element({ id: "other", type: "text", text: "b" }),
    ];
    expect(resolveCaptureIds(scene, ["abcdefgh"]).map((el) => el.id)).toEqual(["abcdefghij"]);
  });
});

describe("captureTypedText", () => {
  it("reads top-to-bottom, then left-to-right", () => {
    const scene = [
      element({ id: "c", type: "text", text: "third", x: 0, y: 100 }),
      element({ id: "b", type: "text", text: "second", x: 50, y: 10 }),
      element({ id: "a", type: "text", text: "first", x: 0, y: 10 }),
    ];
    expect(captureTypedText(scene)).toBe("first\nsecond\nthird");
  });
});

describe("captureStrokes", () => {
  it("converts element-relative points to absolute ones", () => {
    const scene = [
      element({
        id: "s",
        type: "freedraw",
        x: 100,
        y: 200,
        points: [
          [0, 0],
          [5, 10],
        ],
      }),
    ];
    expect(captureStrokes(scene)).toEqual([
      { points: [{ x: 100, y: 200 }, { x: 105, y: 210 }] },
    ]);
  });

  it("ignores non-freedraw elements", () => {
    const scene = [element({ id: "r", type: "rectangle", points: [[0, 0]] })];
    expect(captureStrokes(scene)).toEqual([]);
  });
});

describe("sceneHash", () => {
  it("is stable for an unchanged board", () => {
    const scene = [element({ id: "a", version: 3 }), element({ id: "b", version: 1 })];
    expect(sceneHash(scene)).toBe(sceneHash([...scene]));
  });

  it("changes when a stroke is edited", () => {
    const before = [element({ id: "a", version: 3 })];
    const after = [element({ id: "a", version: 4 })];
    expect(sceneHash(before)).not.toBe(sceneHash(after));
  });

  it("changes when a stroke is added or erased", () => {
    const one = [element({ id: "a" })];
    const two = [element({ id: "a" }), element({ id: "b" })];
    expect(sceneHash(one)).not.toBe(sceneHash(two));
  });

  it("ignores the coach's diagrams, so injecting one doesn't retrigger analysis", () => {
    const scene = [element({ id: "a" })];
    const withCoach = [...scene, element({ id: "viz", customData: { lcVizId: "nums" } })];
    expect(sceneHash(withCoach)).toBe(sceneHash(scene));
  });

  it("stays a non-negative 32-bit integer, so the daemon's u64 accepts it", () => {
    const scene = Array.from({ length: 200 }, (_, i) => element({ id: `e${i}`, version: i }));
    const hash = sceneHash(scene);
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("strokeDelta", () => {
  it("counts only elements new since the last analysis", () => {
    const previous = elementIds([element({ id: "a" })]);
    const now = [element({ id: "a" }), element({ id: "b" }), element({ id: "c" })];
    expect(strokeDelta(now, previous)).toBe(2);
  });

  it("is zero on an unchanged board", () => {
    const scene = [element({ id: "a" })];
    expect(strokeDelta(scene, elementIds(scene))).toBe(0);
  });
});

describe("ink recognizers", () => {
  it("falls back to the no-op recognizer when nothing is available", async () => {
    const unavailable: InkRecognizer = {
      name: "mlkit",
      available: async () => false,
      recognize: async () => "should not be called",
    };
    const picked = await pickRecognizer([unavailable]);
    expect(picked.name).toBe("none");
    expect(await picked.recognize([])).toBe("");
  });

  it("prefers the first available recognizer", async () => {
    const available: InkRecognizer = {
      name: "mlkit",
      available: async () => true,
      recognize: async () => "two pointers",
    };
    const picked = await pickRecognizer([available, new NoopRecognizer()]);
    expect(picked.name).toBe("mlkit");
  });

  it("merges handwriting with typed text, skipping empty halves", () => {
    expect(mergeRecognized("sort first", "O(n log n)")).toBe("sort first\nO(n log n)");
    expect(mergeRecognized("", "O(n)")).toBe("O(n)");
    expect(mergeRecognized("  ", "  ")).toBe("");
  });
});
