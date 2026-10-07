import { beforeEach, expect, it, vi } from "vitest";
import { collectExploreGraph, exploreGraphFile } from "./exploreGraphExport";
import { listAnnotateDocs, annotateDocLabel } from "./annotateStore";
import { listWhiteboardNotebooks } from "./whiteboardStore";
import { listEdges, type Edge, type NodeRef } from "./noteLinks";
import type { TabRecord } from "./tabs";
vi.mock("./annotateStore", () => ({ listAnnotateDocs:vi.fn(), annotateDocLabel:vi.fn() }));
vi.mock("./whiteboardStore", () => ({ listWhiteboardNotebooks:vi.fn() }));
vi.mock("./noteLinks", async original => ({ ...await original<typeof import("./noteLinks")>(), listEdges:vi.fn() }));
beforeEach(() => {
  vi.mocked(listAnnotateDocs).mockReturnValue([{id:"pdf",docType:"pdf",name:"Current title"},{id:"web",docType:"web",name:"Saved page"}] as ReturnType<typeof listAnnotateDocs>);
  vi.mocked(annotateDocLabel).mockImplementation(doc => doc.name);
  vi.mocked(listWhiteboardNotebooks).mockReturnValue([{id:"board",title:"Unlinked board"}] as ReturnType<typeof listWhiteboardNotebooks>);
});
it("exports the whole library, unlinked nodes and edge-only threads without duplicate nodes", async () => {
  const from:NodeRef = {type:"annotate",id:"pdf",title:"Stale title"};
  const to:NodeRef = {type:"thread",id:"thread",parent:{type:"annotate",id:"pdf"},title:"Discussion"};
  const edges:Edge[] = [{id:"z",from,to,kind:"footnote-thread",createdAt:1},
    {id:"a",from,to:{type:"annotate",id:"unresolved:missing",title:"Missing"},kind:"wiki",createdAt:2}];
  vi.mocked(listEdges).mockResolvedValue(edges);
  const graph = await collectExploreGraph([{kind:"practice",id:"practice",dataset:"set",taskId:"7",title:"Problem"}] as TabRecord[]);
  expect(graph.nodes).toHaveLength(6);
  expect(graph.nodes.find(node => node.id === "pdf")?.title).toBe("Current title");
  expect(graph.nodes).toContainEqual(to);
  expect(graph.nodes.some(node => node.id === "board")).toBe(true);
  expect(graph.nodes.some(node => node.id === "set/7")).toBe(true);
  expect(graph.edges.map(edge => edge.id)).toEqual(["a","z"]);
  const file = exploreGraphFile(graph);
  expect(file.blob.type).toBe("application/json");
  expect(file.name).toMatch(/^pen-island-graph-\d{4}-\d{2}-\d{2}\.json$/);
  expect(JSON.parse(await file.blob.text())).toEqual(graph);
});
it("surfaces an unavailable graph store instead of exporting an incomplete graph", async () => {
  vi.mocked(listEdges).mockRejectedValue(new Error("Storage unavailable"));
  await expect(collectExploreGraph([])).rejects.toThrow("Storage unavailable");
});
