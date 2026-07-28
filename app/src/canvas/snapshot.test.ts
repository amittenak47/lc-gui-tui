import { describe, expect, it } from "vitest";

import type { BoardHandle } from "./BoardHandle";
import type { InkStroke, SceneElementLike } from "./capture";
import { NoopRecognizer, type InkRecognizer } from "./ink";
import { buildSnapshot } from "./snapshot";

/** Only the four accessors `buildSnapshot` reaches for; the rest never runs. */
function board(parts: {
  elements?: SceneElementLike[];
  strokes?: InkStroke[];
  inkStrokes?: InkStroke[];
  png?: string;
}): BoardHandle {
  return {
    getElements: () => parts.elements ?? [],
    getStrokes: () => parts.strokes ?? [],
    getInkStrokes: () => parts.inkStrokes ?? [],
    getInkOpCount: () => (parts.inkStrokes ?? []).length,
    exportPng: async () => parts.png ?? "",
  } as unknown as BoardHandle;
}

/** Records what it was asked to read and answers with the point count. */
function spyRecognizer(): InkRecognizer & { seen: InkStroke[][] } {
  const seen: InkStroke[][] = [];
  return {
    name: "spy",
    seen,
    available: async () => true,
    recognize: async (strokes) => {
      seen.push(strokes);
      return strokes.length > 0 ? `read ${strokes.length}` : "";
    },
  };
}

function stroke(...xs: number[]): InkStroke {
  return { points: xs.map((x) => ({ x, y: 0 })) };
}

describe("buildSnapshot handwriting", () => {
  it("reads the raster pen, not just freedraw elements", async () => {
    // The pen writes pixels on the ink layer and never produces a `freedraw`
    // element, so a pen-only board used to submit as blank.
    const recognizer = spyRecognizer();
    const snapshot = await buildSnapshot(
      board({ inkStrokes: [stroke(0, 10)] }),
      recognizer,
    );
    expect(recognizer.seen[0]).toHaveLength(1);
    expect(snapshot.board.recognized_text).toBe("read 1");
  });

  it("sends both stroke sources when the student used pen and freedraw", async () => {
    const recognizer = spyRecognizer();
    await buildSnapshot(
      board({ strokes: [stroke(0, 10)], inkStrokes: [stroke(20, 30), stroke(40, 50)] }),
      recognizer,
    );
    expect(recognizer.seen[0]).toHaveLength(3);
  });

  it("still ships typed text when the recognizer throws", async () => {
    const recognizer: InkRecognizer = {
      name: "broken",
      available: async () => true,
      recognize: async () => {
        throw new Error("ml kit unavailable");
      },
    };
    const elements: SceneElementLike[] = [
      { id: "t", type: "text", x: 0, y: 0, width: 10, height: 10, version: 1, text: "two pointers" },
    ];
    const snapshot = await buildSnapshot(board({ elements }), recognizer);
    expect(snapshot.board.recognized_text).toBe("two pointers");
  });
});

describe("buildSnapshot hasHandwriting", () => {
  it("reports handwriting the recognizer could not read", async () => {
    // Off Android there is no recognizer, so an unreadable board is the normal
    // case — the submit gate leans on this to let the PNG through anyway.
    const snapshot = await buildSnapshot(
      board({ inkStrokes: [stroke(0, 10)] }),
      new NoopRecognizer(),
    );
    expect(snapshot.board.recognized_text).toBe("");
    expect(snapshot.hasHandwriting).toBe(true);
  });

  it("stays false on a board with nothing drawn on it", async () => {
    const snapshot = await buildSnapshot(board({}), new NoopRecognizer());
    expect(snapshot.hasHandwriting).toBe(false);
  });
});
