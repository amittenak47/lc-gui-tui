import { annotateDocLabel, listAnnotateDocs } from "./annotateStore";
import { listWhiteboardNotebooks } from "./whiteboardStore";
import { listEdges, nodeKey, type Edge, type NodeRef } from "./noteLinks";
import type { TabRecord } from "./tabs";

export interface ExploreGraphExport {
  format: "pen-island-graph";
  version: 1;
  exportedAt: string;
  nodes: NodeRef[];
  edges: Edge[];
}
export async function collectExploreGraph(tabs: readonly TabRecord[]): Promise<ExploreGraphExport> {
  const nodes = new Map<string, NodeRef>();
  const add = (node: NodeRef) => { if (!nodes.has(nodeKey(node))) nodes.set(nodeKey(node), node); };
  for (const doc of listAnnotateDocs()) add({ type: doc.docType === "web" ? "web" : "annotate", id: doc.id, title: annotateDocLabel(doc) });
  for (const book of listWhiteboardNotebooks()) add({ type: "whiteboard", id: book.id, title: book.title });
  for (const tab of tabs) if (tab.kind === "practice") add({ type: "practice", id: `${tab.dataset}/${tab.taskId}`, title: tab.title });
  const edges = await listEdges();
  for (const edge of edges) { add(edge.from); add(edge.to); }
  return { format: "pen-island-graph", version: 1, exportedAt: new Date().toISOString(),
    nodes: [...nodes.values()].sort((a, b) => nodeKey(a).localeCompare(nodeKey(b))),
    edges: [...edges].sort((a, b) => a.id.localeCompare(b.id)) };
}
export function exploreGraphFile(graph: ExploreGraphExport): { name: string; blob: Blob } {
  return { name: `pen-island-graph-${graph.exportedAt.slice(0, 10)}.json`,
    blob: new Blob([JSON.stringify(graph, null, 2) + "\n"], { type: "application/json" }) };
}
