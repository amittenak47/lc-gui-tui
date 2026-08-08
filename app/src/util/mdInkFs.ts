/**
 * Getting a document file into the app, and an annotation set back out.
 *
 * Deliberately not a Tauri filesystem plugin in v1. The app runs in a WebView on
 * the tablet as well as on the desktop, and a hidden `<input type="file">` is
 * the one path that works in both without a Rust dependency, a capability
 * grant, or a permission prompt. Annotations live in `mdInkStore` keyed by the
 * document's content hash, so reopening the same file finds its ink again
 * without ever knowing where on disk the file came from.
 *
 * {@link exportMdInkSidecar} is the escape hatch: it hands back a `.lc-ink.json`
 * the writer can keep beside the source, so an annotation set is not trapped in
 * one browser's storage. Reading one back is {@link readMdInkSidecar}.
 */

import type { BoardBlob } from "../canvas/BoardHandle";
import { codeAcceptExtensions, isCodeName } from "./codeLanguages";
import type { DocType } from "./mdInkStore";

export { CODE_SOURCE_MAX_CHARS, languageForName } from "./codeLanguages";

/** Extensions the picker offers, and what we accept when one is dropped in. */
export const MARKDOWN_ACCEPT = ".md,.markdown,.mdown,.mkd,text/markdown";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];

const CODE_ACCEPT = codeAcceptExtensions().join(",");

/** Everything the document pad will open. */
export const DOCUMENT_ACCEPT = [
  MARKDOWN_ACCEPT,
  ".pdf,application/pdf",
  ".epub,application/epub+zip",
  CODE_ACCEPT,
  "text/plain",
].join(",");

export interface OpenedMarkdown {
  name: string;
  source: string;
}

/**
 * A file the pad has read, in whichever form its type needs.
 *
 * Markdown and code arrive as text because that is what gets rendered and
 * stored; PDF and EPUB arrive as bytes because that is what their renderers
 * parse and what goes into IndexedDB. One shape rather than two so the open
 * path does not fork before it has to.
 */
export interface OpenedDocument {
  name: string;
  docType: DocType;
  /** Markdown and code. */
  text?: string;
  /** PDF and EPUB only. */
  bytes?: ArrayBuffer;
}

export function isMarkdownName(name: string): boolean {
  const lower = name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * What kind of document a file is, by name.
 *
 * Extension rather than MIME type: a WebView file picker on Android hands back
 * an empty or wrong `type` often enough that trusting it means refusing files
 * the user can plainly see are PDFs. Anything unrecognised opens as code
 * (escaped plaintext) — safer than feeding unknown bytes through a markdown
 * parser, and refusing to open is a dead end.
 */
export function docTypeForName(name: string): DocType {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".epub")) return "epub";
  if (isMarkdownName(name)) return "markdown";
  if (isCodeName(name)) return "code";
  return "code";
}

/** True when the pad stores this type as a string in the library entry. */
export function isTextDocType(docType: DocType): boolean {
  return docType === "markdown" || docType === "code";
}

/**
 * Ask for a markdown file and read it as text.
 *
 * Resolves `null` when the picker is dismissed. There is no reliable cancel
 * event on a file input — browsers fire `cancel` inconsistently and some never
 * fire anything — so the caller gets `null` only on an explicit cancel it can
 * observe, and otherwise the promise settles when a file arrives. The input is
 * removed either way once it resolves.
 */
export function pickMarkdownFile(): Promise<OpenedMarkdown | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = MARKDOWN_ACCEPT;
    // Off-screen rather than `display: none`: a hidden input is ignored by
    // some WebViews when `click()` is called programmatically.
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.opacity = "0";

    let settled = false;
    const finish = (value: OpenedMarkdown | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener("cancel", () => finish(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      file
        .text()
        .then((source) => finish({ name: file.name, source }))
        .catch((cause) => {
          if (settled) return;
          settled = true;
          input.remove();
          reject(cause);
        });
    });

    document.body.append(input);
    input.click();
  });
}

/**
 * Ask for a `.lc-ink.json` sidecar and read it.
 *
 * Same shape as {@link pickMarkdownFile} — see the note there about why cancel
 * resolves rather than rejects.
 */
export function pickSidecarFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.opacity = "0";

    let settled = false;
    const finish = (value: { name: string; text: string } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener("cancel", () => finish(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      file
        .text()
        .then((text) => finish({ name: file.name, text }))
        .catch((cause) => {
          if (settled) return;
          settled = true;
          input.remove();
          reject(cause);
        });
    });

    document.body.append(input);
    input.click();
  });
}

export interface MdInkSidecar {
  v: 1;
  sourceName: string;
  contentHash: string;
  board: BoardBlob;
}

export function buildMdInkSidecar(input: {
  sourceName: string;
  contentHash: string;
  board: BoardBlob;
}): MdInkSidecar {
  return {
    v: 1,
    sourceName: input.sourceName,
    contentHash: input.contentHash,
    board: input.board,
  };
}

/** File name a sidecar should be saved under, beside its markdown. */
export function sidecarNameFor(sourceName: string): string {
  return `${sourceName}.lc-ink.json`;
}

/** Parse a sidecar, returning null for anything that is not one. */
export function readMdInkSidecar(raw: string): MdInkSidecar | null {
  try {
    const parsed = JSON.parse(raw) as MdInkSidecar;
    if (parsed?.v !== 1) return null;
    if (typeof parsed.sourceName !== "string") return null;
    if (parsed.board?.v !== 1 || !Array.isArray(parsed.board.elements)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Hand the annotation set to the writer as a file they can keep. */
export function exportMdInkSidecar(sidecar: MdInkSidecar): void {
  const blob = new Blob([JSON.stringify(sidecar)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sidecarNameFor(sidecar.sourceName);
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately races the download in some WebViews.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Ask for a document of any kind the pad understands, and read it.
 *
 * Same cancel contract as {@link pickMarkdownFile} — see the note there.
 */
export function pickDocumentFile(): Promise<OpenedDocument | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = DOCUMENT_ACCEPT;
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.style.opacity = "0";

    let settled = false;
    const finish = (value: OpenedDocument | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      input.remove();
      reject(cause);
    };

    input.addEventListener("cancel", () => finish(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      const docType = docTypeForName(file.name);
      if (isTextDocType(docType)) {
        file
          .text()
          .then((text) => finish({ name: file.name, docType, text }))
          .catch(fail);
        return;
      }
      file
        .arrayBuffer()
        .then((bytes) => finish({ name: file.name, docType, bytes }))
        .catch(fail);
    });

    document.body.append(input);
    input.click();
  });
}
