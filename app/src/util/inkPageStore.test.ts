import { describe, expect, it } from "vitest";

import {
  inkPageKey,
  mdInkDocKey,
  shouldPromoteToArchive,
  whiteboardDocKey,
  type InkPageRecord,
} from "./inkPageStore";
import { encodeInkOps } from "../canvas/inkCodec";
import { NO_PRESSURE, type InkDrawOp } from "../canvas/rasterInk";

describe("ink page keys", () => {
  it("scopes md-ink by content hash and whiteboard by notebook id", () => {
    expect(mdInkDocKey("abc")).toBe("md:abc");
    expect(whiteboardDocKey("n1")).toBe("wb:n1");
  });

  it("uses a separator so a hash prefix does not steal another document's pages", () => {
    const inside = inkPageKey("md:ab", 12);
    const neighbour = inkPageKey("md:abc", 1);
    expect(inside.startsWith("md:ab\u001f")).toBe(true);
    expect(neighbour.startsWith("md:ab\u001f")).toBe(false);
  });
});

function dirtyRow(updatedAt: number): InkPageRecord {
  const op: InkDrawOp = {
    kind: "draw",
    color: "#000",
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: [
      { x: 1, y: 1, pressure: NO_PRESSURE },
      { x: 2, y: 1, pressure: NO_PRESSURE },
    ],
  };
  return {
    v: 1,
    docKey: "md:ab",
    pageId: 3,
    inkC: encodeInkOps([op]),
    dirty: true,
    updatedAt,
  };
}

describe("shouldPromoteToArchive", () => {
  it("promotes the dirty row the worker listed", () => {
    expect(shouldPromoteToArchive(dirtyRow(100), 100)).toBe(true);
  });

  it("refuses a newer dirty write that landed while gzip ran", () => {
    expect(shouldPromoteToArchive(dirtyRow(200), 100)).toBe(false);
  });

  it("refuses a page already archived (dirty cleared, inkC gone)", () => {
    const archived: InkPageRecord = {
      v: 1,
      docKey: "md:ab",
      pageId: 3,
      gz: new Uint8Array([1]),
      dirty: false,
      updatedAt: 100,
    };
    expect(shouldPromoteToArchive(archived, 100)).toBe(false);
  });
});
