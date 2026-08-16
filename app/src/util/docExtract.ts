/**
 * Extract page text for the daemon document index.
 *
 * Uploads extracted text, never the raw PDF/EPUB bytes.
 */

import type { DocType } from "./annotateStore";
import { readEpub } from "./epub";
import { loadPdfJs } from "../modes/PdfDocument";

export interface ExtractedPage {
  page: number;
  text: string;
  heading?: string;
  scope?: string;
}

const PAGE_TEXT_ASK_CHARS = 2000;

let pageCache: { hash: string; pages: ExtractedPage[] } | null = null;

export function rememberExtractedPages(hash: string, pages: ExtractedPage[]): void {
  pageCache = { hash, pages };
}

export function extractedPagesFor(hash: string): ExtractedPage[] | null {
  return pageCache && pageCache.hash === hash ? pageCache.pages : null;
}

export function pageTextForAsk(hash: string, page: number | null | undefined): string {
  const pages = extractedPagesFor(hash);
  if (!pages || pages.length === 0) return "";
  const wanted = page && page > 0 ? page : 1;
  const match = pages.find((entry) => entry.page === wanted) ?? pages[0];
  const text = match.text.trim();
  if (text.length <= PAGE_TEXT_ASK_CHARS) return text;
  return `${text.slice(0, PAGE_TEXT_ASK_CHARS)}\n…`;
}

export async function extractDocumentPages(input: {
  docType: DocType;
  name: string;
  text: string;
  bytes?: ArrayBuffer | null;
}): Promise<ExtractedPage[]> {
  if (input.docType === "pdf") {
    if (!input.bytes) return [];
    return extractPdfPages(input.bytes);
  }
  if (input.docType === "epub") {
    if (!input.bytes) return [];
    return extractEpubPages(input.bytes);
  }
  if (input.docType === "web") {
    const text = htmlToText(input.text).trim();
    if (!text) return [];
    return [
      {
        page: 1,
        text,
        heading: headingFrom(text) ?? input.name,
        scope: input.name,
      },
    ];
  }
  const text = input.text.trim();
  if (!text) return [];
  return [
    {
      page: 1,
      text,
      heading: headingFrom(text) ?? input.name,
    },
  ];
}

async function extractPdfPages(bytes: ArrayBuffer): Promise<ExtractedPage[]> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: bytes.slice(0) });
  const pages: ExtractedPage[] = [];
  try {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? String(item.str) : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      pages.push({
        page: n,
        text,
        heading: headingFrom(text),
        scope: `p${n}`,
      });
    }
  } finally {
    void task.destroy();
  }
  return pages;
}

function extractEpubPages(bytes: ArrayBuffer): ExtractedPage[] {
  const book = readEpub(bytes);
  return book.chapters.flatMap((chapter, index) => {
    const text = htmlToText(chapter.html).trim();
    if (!text) return [];
    return [
      {
        page: index + 1,
        text,
        heading: headingFrom(text) ?? chapter.href,
        scope: chapter.href,
      },
    ];
  });
}

function htmlToText(html: string): string {
  if (typeof document === "undefined") {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return (holder.innerText || holder.textContent || "").replace(/\s+\n/g, "\n").trim();
}

function headingFrom(text: string): string | undefined {
  for (const line of text.split(/\n/).slice(0, 8)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const title = trimmed.replace(/^#+\s*/, "").trim();
      if (title) return title;
    }
  }
  const first = text.trim().split(/\n/)[0]?.trim();
  if (first && first.length > 0 && first.length < 80) return first;
  return undefined;
}
