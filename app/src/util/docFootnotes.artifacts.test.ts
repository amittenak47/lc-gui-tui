import { describe, expect, it } from "vitest";
import { footnoteRevision, sanitizeFootnotes, type DocFootnote } from "./docFootnotes";
import type { ArtifactRef } from "./padArtifacts";

const artifact: ArtifactRef = {
  parent: { kind: "annotate", id: "set-1" }, artifactId: "code-1", kind: "code",
};
const mark: DocFootnote = {
  id: "f1", kind: "note", anchor: { kind: "text", start: 0, end: 4 },
  excerpt: "test", createdAt: 1,
  whiteboards: [{ id: "legacy-board", createdAt: 1, updatedAt: 1 }],
};

describe("artifact links on footnotes", () => {
  it("round-trips new references beside old scratch-board pointers", () => {
    const [restored] = sanitizeFootnotes([{ ...mark, artifacts: [artifact] }]);
    expect(restored!.artifacts).toEqual([artifact]);
    expect(restored!.whiteboards).toEqual(mark.whiteboards);
  });

  it("includes linking and unlinking in the autosave signature", () => {
    const linked = { ...mark, artifacts: [artifact] };
    expect(footnoteRevision([linked])).not.toBe(footnoteRevision([mark]));
    expect(footnoteRevision([linked])).not.toBe(footnoteRevision([
      { ...linked, artifacts: [{ ...artifact, artifactId: "code-2" }] },
    ]));
  });

  it("deduplicates valid references and does not pass malformed values through the spread", () => {
    const [restored] = sanitizeFootnotes([{ ...mark, artifacts: [artifact, artifact, {}] }]);
    expect(restored!.artifacts).toEqual([artifact]);
    expect(sanitizeFootnotes([{ ...mark, artifacts: { unsafe: true } }])[0]!.artifacts).toBeUndefined();
  });
});
