import type { ArtifactAssociation, ArtifactParent, ArtifactRef } from "./padArtifacts";
import { createArtifact, type ArtifactSnapshot } from "./artifactRepository";
import { buildWhiteboardTemplate } from "../templates/whiteboard";
import { buildAnnotateTemplate } from "../templates/annotate";
import { convertToExcalidrawElements } from "../canvas/convertSkeletons";
import { applyViz, type VizSceneElement } from "../viz/apply";
import { parseVizProgram } from "../viz/schema";

export interface AgentArtifactProposal { kind: "whiteboard" | "code" | "markdown"; title: string; source?: string; programs?: unknown[]; messages?: unknown[] }

export function sanitizeArtifactProposals(raw: unknown): AgentArtifactProposal[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result = raw.slice(0, 8).filter((entry): entry is AgentArtifactProposal => entry &&
    ["whiteboard", "code", "markdown"].includes(entry.kind) && typeof entry.title === "string" && entry.title.trim() && entry.title.length <= 256 &&
    (entry.source === undefined || typeof entry.source === "string" && entry.source.length <= 512_000) &&
    (entry.programs === undefined || Array.isArray(entry.programs) && entry.programs.length <= 8 && entry.programs.every((program: unknown) => parseVizProgram(program))));
  return result.length ? result : undefined;
}

export function artifactProposalSnapshot(proposal: AgentArtifactProposal, dark: boolean): ArtifactSnapshot {
  if (!proposal || !["whiteboard", "code", "markdown"].includes(proposal.kind) || typeof proposal.title !== "string" || !proposal.title.trim() || proposal.title.length > 256) throw new Error("Invalid attachment proposal.");
  const source = proposal.source ?? "";
  const rawPrograms = proposal.programs ?? [];
  if (typeof source !== "string" || new TextEncoder().encode(source).length > 512_000 || !Array.isArray(rawPrograms) || rawPrograms.length > 8) throw new Error("Attachment proposal exceeds its limit.");
  if (proposal.kind !== "whiteboard" && rawPrograms.length || proposal.kind === "whiteboard" && source.length) throw new Error("Attachment content does not match its kind.");
  const board = { v: 1 as const, elements: convertToExcalidrawElements(proposal.kind === "whiteboard" ? buildWhiteboardTemplate(1, dark) : buildAnnotateTemplate(1600, dark)) as unknown[], appState: { scrollX: 0, scrollY: 0, zoom: 1 } };
  if (proposal.kind !== "whiteboard") return { kind: proposal.kind, value: { owned: true, docType: proposal.kind,
    name: proposal.title, source, board, footnotes: [], agent: proposal.messages ?? [], ink: new Map() } };
  const programs = rawPrograms.map(program => { const parsed = parseVizProgram(program); if (!parsed) throw new Error("Invalid attachment drawing."); return parsed; });
  if (new Set(programs.map(program => program.id)).size !== programs.length) throw new Error("Duplicate drawing identity.");
  for (const program of programs) applyViz({ getSceneElements: () => board.elements as VizSceneElement[], updateScene: ({ elements }) => { board.elements = elements; },
    getViewportBounds: () => ({ x: 160, y: 180 + programs.indexOf(program) * 480, width: 2400, height: 460, zoom: 1 }),
  }, convertToExcalidrawElements, program, 0);
  return { kind: "whiteboard", value: { board, programs, pageCount: 1, ink: new Map() } };
}

/** Sequential publication; report each link as soon as its parent commit succeeds. */
export async function saveAgentArtifacts(parent: ArtifactParent, proposals: AgentArtifactProposal[], associations: ArtifactAssociation[], dark: boolean, saved: (ref: ArtifactRef) => void) {
  if (!Array.isArray(proposals) || proposals.length > 8) throw new Error("Too many attachment proposals.");
  const snapshots = proposals.map(proposal => artifactProposalSnapshot(proposal, dark));
  for (let i = 0; i < proposals.length; i++) {
    const ref = await createArtifact(parent, proposals[i].title, associations, snapshots[i]);
    saved(ref);
  }
}
