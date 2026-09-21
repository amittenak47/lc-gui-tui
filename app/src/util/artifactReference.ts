import { parseArtifactParent, type ArtifactParent } from "./padArtifacts";

/** A bounded read-only capture, with its source identity. Never a write-back path. */
export interface ArtifactSourceReference {
  v: 1;
  parent: ArtifactParent;
  revision: string;
  label: string;
  locator: string;
  capturedAt: number;
  truncated: boolean;
  image?: string;
}
export const REFERENCE_TEXT_LIMIT = 12000;
export const REFERENCE_IMAGE_LIMIT = 1500000;
export function parseArtifactSourceReference(raw: unknown): ArtifactSourceReference | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") throw new Error("Invalid attachment source reference.");
  const value = raw as ArtifactSourceReference;
  const parent = parseArtifactParent(value.parent);
  if (value.v !== 1 || !parent || typeof value.revision !== "string" || !value.revision || value.revision.length > 256 ||
      typeof value.label !== "string" || !value.label || value.label.length > 512 ||
      typeof value.locator !== "string" || !value.locator || value.locator.length > 256 ||
      !Number.isSafeInteger(value.capturedAt) || value.capturedAt < 0 || typeof value.truncated !== "boolean" ||
      (value.image !== undefined && (typeof value.image !== "string" || value.image.length > REFERENCE_IMAGE_LIMIT ||
        !/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value.image)))) {
    throw new Error("Invalid attachment source reference.");
  }
  return { v: 1, parent, revision: value.revision, label: value.label, locator: value.locator,
    capturedAt: value.capturedAt, truncated: value.truncated, ...(value.image ? { image: value.image } : {}) };
}
