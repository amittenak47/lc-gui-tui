/**
 * The article, not the page around it.
 *
 * A web pad used to be a photocopy: the site's own CSS, replayed inside our
 * document, so the paper would look like the page. That is an unbounded problem
 * and it loses slowly — a stylesheet that will not load, a layout baked at one
 * width and reopened at another, a script-built column that never arrives. It
 * also drags the furniture along. Indexing a Wikipedia article this way fed the
 * room "Jump to content", "Learn to edit", "Upload file", every language name
 * and the licence footer, because the document really did contain all of that.
 *
 * Extraction is the bounded version of the same job. Readability is the engine
 * behind Safari and Firefox Reader, and it runs here in a better position than
 * either: the capture webview has already executed the page's JavaScript, so
 * this reads the finished DOM rather than a server-rendered shell — which is the
 * usual reason Reader gives up on a phone.
 *
 * What comes out is plain semantic HTML with no site CSS at all. It reflows to
 * whatever the pane is, reads in the app's own typography beside notes and PDFs,
 * anchors cleanly, and indexes as the article it is.
 */

import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";

import { absolutizeUrl } from "./webPage";

export interface ReadArticle {
  title: string;
  html: string;
}

/**
 * Below this an "article" is a nav page wearing a paragraph.
 *
 * Readability scores generously and will hand back a search-results page or a
 * link directory if asked nicely. Those are exactly the pages the raw snapshot
 * is still the better answer for, so the floor is what decides between them.
 */
export const MIN_ARTICLE_CHARS = 500;

/**
 * Above this share of the text sitting inside links, it is a list of places to
 * go rather than something to read.
 *
 * Length alone cannot tell them apart — sixty search results are easily longer
 * than a short article, and they were being handed back as one. Prose has links
 * *in* it; a directory is made of them. This is also the reader's own objection
 * to what was reaching the index: a room full of "Learn to edit" and "Upload
 * file" is a room full of anchor text.
 */
export const MAX_LINK_DENSITY = 0.5;

/** Share of an element's text that lives inside anchors, 0..1. */
export function linkDensity(root: Element): number {
  const total = (root.textContent ?? "").replace(/\s+/g, " ").trim().length;
  if (total === 0) return 1;
  let linked = 0;
  for (const anchor of Array.from(root.querySelectorAll("a"))) {
    linked += (anchor.textContent ?? "").replace(/\s+/g, " ").trim().length;
  }
  return Math.min(1, linked / total);
}

/**
 * Attributes that pin a width, and so stop the article reflowing.
 *
 * The whole reason extraction fixes the layout bugs is that nothing in the
 * output carries a size from the machine it was captured on.
 */
const SIZE_ATTRS = ["width", "height"] as const;

function stripFixedSizes(root: Element): void {
  for (const node of Array.from(root.querySelectorAll("[style]"))) {
    const raw = node.getAttribute("style") ?? "";
    const kept = raw
      .split(";")
      .filter((rule) => !/^\s*(width|min-width|max-width|height|position)\s*:/i.test(rule))
      .join(";")
      .trim();
    if (kept) node.setAttribute("style", kept);
    else node.removeAttribute("style");
  }
  // `<img width=1200>` is the same pin by another spelling. The image keeps its
  // aspect through CSS; the number would have held it at the capture's width.
  for (const img of Array.from(root.querySelectorAll("img, figure, table, iframe"))) {
    for (const attr of SIZE_ATTRS) img.removeAttribute(attr);
  }
}

function absolutize(root: Element, baseUrl: string): void {
  for (const node of Array.from(root.querySelectorAll("[href], [src]"))) {
    const attr = node.hasAttribute("href") ? "href" : "src";
    const raw = node.getAttribute(attr);
    if (!raw || /^(https?:|data:|mailto:|#)/i.test(raw)) continue;
    node.setAttribute(attr, absolutizeUrl(baseUrl, raw));
  }
}

/**
 * Pull the article out of a captured page, or decline.
 *
 * `null` means "this is not an article" — a dashboard, a forum index, a search
 * result — and the caller should keep the snapshot it already has. Declining is
 * a real answer here, not a failure: reproducing a dashboard is the thing this
 * module exists to stop attempting.
 */
export function extractArticle(html: string, url: string): ReadArticle | null {
  if (typeof DOMParser === "undefined") return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
  // Readability resolves relative links against the document's base; a parsed
  // string has none, so give it one or every href comes out pointing at us.
  if (!doc.querySelector("base")) {
    const base = doc.createElement("base");
    base.setAttribute("href", url);
    doc.head.appendChild(base);
  }

  let parsed: { title?: string | null; content?: string | null; textContent?: string | null } | null;
  try {
    parsed = new Readability(doc, { keepClasses: false }).parse();
  } catch {
    return null;
  }
  if (!parsed?.content) return null;
  if ((parsed.textContent ?? "").trim().length < MIN_ARTICLE_CHARS) return null;

  /*
   * Same sanitiser as the snapshot path, minus `style` and `link`.
   *
   * A reader page carries no site CSS by design — that is the point of it — so
   * anything that could reintroduce one is dropped rather than scoped.
   */
  const clean = DOMPurify.sanitize(parsed.content, {
    FORBID_TAGS: [
      "script",
      "style",
      "link",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
    ],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  });
  if (typeof document === "undefined") return { title: parsed.title?.trim() || url, html: clean };

  const holder = document.createElement("div");
  holder.innerHTML = clean;
  stripFixedSizes(holder);
  absolutize(holder, url);
  const text = (holder.textContent ?? "").trim();
  if (text.length < MIN_ARTICLE_CHARS) return null;
  if (linkDensity(holder) > MAX_LINK_DENSITY) return null;
  return { title: parsed.title?.trim() || url, html: holder.innerHTML };
}
