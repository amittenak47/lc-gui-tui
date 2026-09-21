import { getAnnotateDoc, annotateDocLabel } from "./annotateStore";
import { getDocBytes } from "./docBytes";
import { REFERENCE_IMAGE_LIMIT, REFERENCE_TEXT_LIMIT, type ArtifactSourceReference } from "./artifactReference";
import type { ArtifactDocumentSnapshot } from "./artifactDocuments";

export interface ArtifactReferenceCapture {
  title: string;
  kind: "code" | "markdown";
  text: string;
  reference: ArtifactSourceReference;
}
export function referenceSnapshot(capture: ArtifactReferenceCapture, board: ArtifactDocumentSnapshot["board"]): ArtifactDocumentSnapshot {
  return { owned: true, docType: capture.kind, name: capture.title, source: capture.text.slice(0, REFERENCE_TEXT_LIMIT),
    sourceReference: capture.reference, board, footnotes: [], agent: [], ink: new Map() };
}

/** PDF page, EPUB chapter, or a 120-line text range; never extracts a whole PDF. */
export async function captureLibraryReference(id: string, page: number): Promise<ArtifactReferenceCapture> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Choose a page or section starting at 1.");
  const doc = await getAnnotateDoc(id);
  if (!doc || doc.deletedAt) throw new Error("This file is unavailable or in Trash.");
  let text = "", image: string | undefined, locator: string;
  const { htmlToText } = await import("./docExtract");
  if (doc.docType === "pdf") {
    const { loadPdfJs, pdfJsDataUrls, pdfWorker } = await import("../modes/PdfDocument");
    const { borrowPdfDocument } = await import("../modes/pdfOpenDocs");
    let pdf = borrowPdfDocument(doc.hash);
    let task: ReturnType<Awaited<ReturnType<typeof loadPdfJs>>["getDocument"]> | undefined;
    try {
      if (!pdf) {
        const bytes = await getDocBytes(doc.hash);
        if (!bytes) throw new Error("Download this PDF before attaching a page.");
        const pdfjs = await loadPdfJs();
        task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), worker: pdfWorker(pdfjs), ...pdfJsDataUrls(), cMapPacked: true });
        pdf = await task.promise;
      }
      if (page > pdf.numPages) throw new Error(`This PDF has ${pdf.numPages} pages.`);
      const selected = await pdf.getPage(page);
      const content = await selected.getTextContent();
      text = content.items.map(item => "str" in item ? String(item.str) : "").join(" ").trim();
      const natural = selected.getViewport({ scale: 1 });
      const viewport = selected.getViewport({ scale: Math.min(1.5, 1000 / Math.max(natural.width, natural.height)) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await selected.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
      image = canvas.toDataURL("image/png");
      while (image.length > REFERENCE_IMAGE_LIMIT && canvas.width > 100) {
        const smaller = document.createElement("canvas");
        smaller.width = Math.ceil(canvas.width * 0.7); smaller.height = Math.ceil(canvas.height * 0.7);
        smaller.getContext("2d")!.drawImage(canvas, 0, 0, smaller.width, smaller.height);
        canvas.width = smaller.width; canvas.height = smaller.height;
        canvas.getContext("2d")!.drawImage(smaller, 0, 0);
        image = canvas.toDataURL("image/png");
      }
      if (image.length > REFERENCE_IMAGE_LIMIT) throw new Error("This page is too large to attach.");
    } finally { if (task) await task.destroy(); }
    locator = `Page ${page}`;
  } else if (doc.docType === "epub") {
    const bytes = await getDocBytes(doc.hash);
    if (!bytes) throw new Error("Download this EPUB before attaching a chapter.");
    const { readEpub } = await import("./epub");
    const book = readEpub(bytes);
    const chapter = book.chapters[page - 1];
    if (!chapter) throw new Error(`This EPUB has ${book.chapters.length} chapters.`);
    text = htmlToText(chapter.html);
    locator = `Chapter ${page}`;
  } else {
    const source = doc.docType === "web" ? htmlToText(doc.source) : doc.source;
    const lines = source.split("\n"), start = (page - 1) * 120;
    if (start >= lines.length) throw new Error(`This file has ${Math.max(1, Math.ceil(lines.length / 120))} sections.`);
    text = lines.slice(start, start + 120).join("\n");
    locator = `Lines ${start + 1}–${Math.min(lines.length, start + 120)}`;
  }
  if (!text.trim() && !image) throw new Error("This selection has no readable content.");
  const label = annotateDocLabel(doc);
  return { title: `${label} · ${locator}`, kind: doc.docType === "code" ? "code" : "markdown", text: text.slice(0, REFERENCE_TEXT_LIMIT),
    reference: { v: 1, parent: { kind: "annotate", id }, revision: `${doc.hash.slice(0, 180)}:${doc.updatedAt}`,
      label: label.slice(0, 512), locator, capturedAt: Date.now(), truncated: text.length > REFERENCE_TEXT_LIMIT, ...(image ? { image } : {}) } };
}
