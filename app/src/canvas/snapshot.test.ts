import { describe, expect, it } from "vitest";

import type { BoardHandle } from "./BoardHandle";
import type { InkStroke, SceneElementLike } from "./capture";
import { NoopRecognizer, type InkRecognizer } from "./ink";
import { buildSnapshot, structureBaselineFromBoard } from "./snapshot";
import { sha256Hex } from "../util/codeHash";

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

/** A board big enough that a full structure dump is worth avoiding. */
function busyBoard(count: number): SceneElementLike[] {
  // Ids must differ inside CAPTURE_ID_LEN — the delta keys off the truncated
  // id, so `element-0`/`element-1` would collide the way real Excalidraw
  // ids (random, 20+ chars) never do.
  return Array.from({ length: count }, (_, i) => ({
    id: `el-${String(i).padStart(2, "0")}-node`,
    type: i % 2 === 0 ? "rectangle" : "text",
    x: i * 40,
    y: i * 25,
    width: 120,
    height: 60,
    version: 3,
    text: i % 2 === 0 ? undefined : `step ${i}: advance the slower pointer`,
    customData: { lcRegion: "approach" },
  }));
}

const SOLUTION = [
  "class Solution:",
  "    def twoSum(self, nums, target):",
  "        seen = {}",
  "        for i, n in enumerate(nums):",
  "            if target - n in seen:",
  "                return [seen[target - n], i]",
  "            seen[n] = i",
  "        return []",
].join("\n");

/** What the review actually puts on the wire. */
function wireBytes(snapshot: { board: unknown }): number {
  return JSON.stringify(snapshot.board).length;
}

describe("review wire size", () => {
  const elements = busyBoard(12);
  const handle = board({ elements });

  /** The first review of a session: no server baseline to diff against. */
  const first = () =>
    buildSnapshot(handle, new NoopRecognizer(), {
      pseudocode: SOLUTION,
      skeletonHash: "sha256:starter",
      turnIndex: 0,
    });

  /** A later review, once the server has acknowledged a baseline. */
  const later = async (parts: { elements: SceneElementLike[] }) =>
    buildSnapshot(board(parts), new NoopRecognizer(), {
      pseudocode: SOLUTION,
      skeletonHash: "sha256:starter",
      turnIndex: 1,
      structureBaseline: structureBaselineFromBoard(elements),
      lastPseudocodeHash: await sha256Hex(SOLUTION.trim()),
    });

  it("carries the whole board and the whole solution on the first review", () => {
    return first().then((snapshot) => {
      expect(snapshot.board.scene_structure).toHaveLength(12);
      expect(snapshot.board.board_ops).toBeUndefined();
      expect(snapshot.board.code_mode).toBe("full");
      expect(snapshot.board.pseudocode).toBe(SOLUTION);
    });
  });

  it("sends fewer bytes on an unchanged second review", async () => {
    // The whole point of Phase 3: a student who re-asks without touching the
    // board should not pay for a second full dump of it.
    const before = wireBytes(await first());
    const after = wireBytes(await later({ elements }));
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(before / 2);
  });

  it("drops the structure and the solution text once both are unchanged", async () => {
    const snapshot = await later({ elements });
    expect(snapshot.board.board_ops).toEqual([]);
    expect(snapshot.board.scene_structure).toBeUndefined();
    expect(snapshot.board.code_mode).toBe("unchanged");
    expect(snapshot.board.pseudocode).toBeUndefined();
    expect(snapshot.board.pseudocode_delta).toBeUndefined();
  });

  it("still beats a full dump when the student drew one more thing", async () => {
    const grown = [
      ...elements,
      { id: "fresh", type: "ellipse", x: 900, y: 40, width: 80, height: 80, version: 1 },
    ];
    const before = wireBytes(await first());
    const after = wireBytes(await later({ elements: grown }));
    expect(after).toBeLessThan(before);
    expect(snapshotOps(await later({ elements: grown }))).toEqual([
      { op: "add", element: { id: "fresh", type: "ellipse", x: 900, y: 40, w: 80, h: 80 } },
    ]);
  });

  it("falls back to a full dump when the delta would be the bigger payload", async () => {
    // Every element moved — ops would repeat the whole board plus op wrappers.
    const moved = elements.map((el) => ({ ...el, x: el.x + 7, version: el.version + 1 }));
    const snapshot = await later({ elements: moved });
    expect(snapshot.board.scene_structure).toHaveLength(12);
    expect(snapshot.board.board_ops).toBeUndefined();
  });
});

function snapshotOps(snapshot: { board: { board_ops?: unknown } }): unknown {
  return snapshot.board.board_ops;
}
