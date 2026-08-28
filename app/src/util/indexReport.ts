/**
 * Search-index diagnose dump for Settings.
 *
 * This device's `docs.db` is not the hub's. Counts here are local unless the
 * caller also passed hub digests.
 */

import type { DocChunkDigest } from "../api/client";
import type { SettingsFact } from "./settingsFacts";

function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 8)}…`;
}

function digestKey(row: DocChunkDigest): string {
  return `${row.embed_model}\0${row.chunks_total}\0${row.chunks_embedded}`;
}

export function summarizeDigests(digests: readonly DocChunkDigest[]): {
  documents: number;
  chunks: number;
  embedded: number;
  models: string[];
} {
  const models = [
    ...new Set(digests.map((row) => row.embed_model).filter((model) => Boolean(model))),
  ];
  return {
    documents: digests.length,
    chunks: digests.reduce((n, row) => n + row.chunks_total, 0),
    embedded: digests.reduce((n, row) => n + row.chunks_embedded, 0),
    models,
  };
}

export function indexFacts(
  digests: readonly DocChunkDigest[],
  source: string,
  opts?: { perDocument?: boolean },
): SettingsFact[] {
  const summary = summarizeDigests(digests);
  const facts: SettingsFact[] = [
    { label: "Index", value: source },
    {
      label: "Documents",
      value: String(summary.documents),
    },
    {
      label: "Chunks",
      value:
        summary.chunks === 0
          ? "none"
          : `${summary.chunks} (${summary.embedded} with vectors)`,
      tone: summary.chunks > 0 && summary.embedded < summary.chunks ? "warn" : "ok",
    },
  ];
  if (summary.models.length > 0) {
    facts.push({ label: "Embedding model", value: summary.models.join(", ") });
  }
  if (opts?.perDocument === false) return facts;
  for (const row of digests) {
    const incomplete = row.chunks_embedded < row.chunks_total;
    facts.push({
      label: shortHash(row.hash),
      value: `${row.chunks_total} chunks, ${row.chunks_embedded} embedded${
        row.embed_model ? ` · ${row.embed_model}` : ""
      }`,
      tone: incomplete ? "warn" : "ok",
    });
  }
  return facts;
}

/** Local facts, then hub facts, then whether the two disagree. */
export function compareIndexFacts(
  local: readonly DocChunkDigest[],
  hub: readonly DocChunkDigest[] | null,
): SettingsFact[] {
  const facts = indexFacts(local, "this device");
  if (!hub) return facts;
  facts.push(...indexFacts(hub, "hub"));
  const localBy = new Map(local.map((row) => [row.hash, row]));
  const hubBy = new Map(hub.map((row) => [row.hash, row]));
  const hashes = new Set([...localBy.keys(), ...hubBy.keys()]);
  let disagree = 0;
  for (const hash of hashes) {
    const here = localBy.get(hash);
    const there = hubBy.get(hash);
    if (!here || !there || digestKey(here) !== digestKey(there)) disagree += 1;
  }
  if (hashes.size > 0) {
    facts.push({
      label: "This device vs hub",
      value:
        disagree === 0
          ? "same document counts and models"
          : `${disagree} ${disagree === 1 ? "document differs" : "documents differ"}`,
      tone: disagree === 0 ? "ok" : "warn",
    });
  }
  return facts;
}

export function formatIndexReport(
  digests: readonly DocChunkDigest[],
  source: string,
): string {
  return indexFacts(digests, source)
    .map((fact) => (fact.label ? `${fact.label}: ${fact.value}` : fact.value))
    .join("\n");
}
