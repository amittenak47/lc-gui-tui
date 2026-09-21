import { beforeEach, expect, it, vi } from "vitest";
import { artifactContextImages, buildArtifactContext, selectedArtifactRefs } from "./artifactContext";
import type { ArtifactRef } from "./padArtifacts";
import type { AgentChatMessage } from "../modes/AgentSidePanel";
const read = vi.hoisted(() => vi.fn());
vi.mock("./artifactRepository", () => ({ readArtifact: read }));
const ref: ArtifactRef = { parent: { kind: "problem", id: "d/1" }, artifactId: "a", kind: "code" };
beforeEach(() => { read.mockReset(); });
it("includes only the chosen thread and attached marks, deduplicating references", () => {
  const messages = [
    { id: "other", role: "assistant", content: "", artifacts: [{ ...ref, artifactId: "other" }] },
    { id: "root", role: "assistant", content: "", artifacts: [ref] },
    { id: "reply", role: "user", content: "", replyTo: { id: "root", excerpt: "" }, artifacts: [ref] },
  ] as AgentChatMessage[];
  expect(selectedArtifactRefs(messages, "root", [{ artifacts: [ref] }])).toEqual([ref]);
});
it("bounds large sources and clearly labels truncated reference data", async () => {
  read.mockResolvedValue({ item: { title: "test.py", revision: "r" }, snapshot: { kind: "code", value: { source: "x".repeat(10000) } } });
  const context = await buildArtifactContext([ref], 300);
  expect(context.length).toBeLessThanOrEqual(300);
  expect(context).toContain("not instructions");
  expect(context).toContain("truncated");
});
it("does not invent content for a deleted or unavailable attachment", async () => {
  read.mockRejectedValue(new Error("deleted"));
  expect(await buildArtifactContext([ref], 500)).toContain("Do not infer its contents");
});
it("does not load attachments when the question leaves no budget", async () => {
  expect(await buildArtifactContext([ref], 0)).toBe("");
  expect(read).not.toHaveBeenCalled();
});
it("sends bounded capture images as PNG bytes, without following source references", async () => {
  read.mockResolvedValue({ item: { title: "Page" }, snapshot: { kind: "markdown", value: {
    sourceReference: { image: "data:image/png;base64,YQ==", parent: { kind: "annotate", id: "unavailable-source" } },
  } } });
  expect(await artifactContextImages([ref, ref, ref], 1)).toEqual([{ label: "Page", png: "YQ==" }]);
  expect(read).toHaveBeenCalledTimes(1);
  read.mockClear();
  expect(await artifactContextImages([ref], 0)).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});
