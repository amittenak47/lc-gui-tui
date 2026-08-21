import { describe, expect, it } from "vitest";

import {
  inkPageToSnapshot,
  padNodeRef,
  parseSnapshotEdges,
  parseSnapshotInk,
  parseSnapshotSource,
  snapshotInkToBytes,
} from "./padSnapshotPayload";

describe("padNodeRef", () => {
  it("names a web pad as web, not annotate", () => {
    expect(padNodeRef("annotate", "a1", "web")).toEqual({ type: "web", id: "a1" });
    expect(padNodeRef("annotate", "a1", "pdf")).toEqual({ type: "annotate", id: "a1" });
    expect(padNodeRef("whiteboard", "w1")).toEqual({ type: "whiteboard", id: "w1" });
  });
});

describe("snapshot ink round-trip", () => {
  it("encodes gzip bytes as base64 and back", () => {
    const gz = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
    const page = inkPageToSnapshot({ pageId: 4, updatedAt: 99, gz });
    expect(page.pageId).toBe(4);
    expect(page.gz.length).toBeGreaterThan(0);
    const back = snapshotInkToBytes(page);
    expect(back?.pageId).toBe(4);
    expect(Array.from(back?.gz ?? [])).toEqual([0x1f, 0x8b, 1, 2, 3]);
  });
});

describe("parseSnapshotInk / edges / source", () => {
  it("keeps well-formed pages and drops junk", () => {
    expect(
      parseSnapshotInk([
        { pageId: 1, updatedAt: 2, gz: "YQ==" },
        { pageId: "nope", gz: "YQ==" },
        null,
      ]),
    ).toEqual([{ pageId: 1, updatedAt: 2, gz: "YQ==" }]);
  });

  it("keeps edges that name both ends", () => {
    const edges = parseSnapshotEdges([
      {
        id: "picker|annotate:a|annotate:b",
        from: { type: "annotate", id: "a" },
        to: { type: "annotate", id: "b" },
        kind: "picker",
        createdAt: 1,
      },
      { id: "missing-ends" },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe("picker|annotate:a|annotate:b");
  });

  it("reads source as a string only", () => {
    expect(parseSnapshotSource("# hi")).toBe("# hi");
    expect(parseSnapshotSource(12)).toBeUndefined();
  });
});
