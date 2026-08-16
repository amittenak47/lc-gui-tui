/**
 * Capture a web page as the annotate paper — same contract as EPUB.
 *
 * Tauri: hidden webview runs the page, then we serialize the post-JS DOM.
 * Vite preview: HTTP GET of the server body (JS apps stay a shell there).
 * Scripts never re-run in our origin.
 */

import DOMPurify from "dompurify";

import { isSafeExternalUrl, normalizeExternalUrl } from "./openExternal";

/** Inlined CSS/images after capture; keep in sync with Rust `PAGE_MAX_BYTES`. */
export const PAGE_MAX_BYTES = 8_000_000;

export const WEB_HOME = "https://www.google.com/";

export interface FetchedWebPage {
  url: string;
  title: string;
  html: string;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

let invokeLoader: Promise<Invoke | null> | null = null;

function loadInvoke(): Promise<Invoke | null> {
  if (!isTauriRuntime()) return Promise.resolve(null);
  if (!invokeLoader) {
    invokeLoader = import("@tauri-apps/api/core")
      .then((mod) => mod.invoke as Invoke)
      .catch(() => null);
  }
  return invokeLoader;
}

export function titleFromHtml(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)/i);
  const title = match?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  return title;
}

export function absolutizeUrl(base: string, href: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/**
 * Executable bits out. Styles stay so a snapshot can lay out; a wrapper-only
 * DOM is flattened so marquee hits real blocks, not one 17k-px shell.
 */
export function sanitizeWebHtml(html: string, baseUrl: string): string {
  const cleaned = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
    ADD_TAGS: ["style", "link"],
    ADD_ATTR: ["style"],
  });
  if (typeof document === "undefined") return cleaned;
  const holder = document.createElement("div");
  holder.innerHTML = cleaned;
  for (const node of Array.from(holder.querySelectorAll("[hidden], [aria-hidden='true']"))) {
    node.remove();
  }
  flattenWebSnapshot(holder);
  for (const node of Array.from(holder.querySelectorAll("[style]"))) {
    const raw = node.getAttribute("style");
    if (!raw) continue;
    node.setAttribute(
      "style",
      raw.replace(/position\s*:\s*(fixed|sticky)/gi, "position:static"),
    );
  }
  for (const node of Array.from(holder.querySelectorAll("[href], [src]"))) {
    const attr = node.hasAttribute("href") ? "href" : "src";
    const raw = node.getAttribute(attr);
    if (!raw || /^(https?:|data:|mailto:|#)/i.test(raw)) continue;
    node.setAttribute(attr, absolutizeUrl(baseUrl, raw));
  }
  return holder.innerHTML;
}

const FLATTEN_ONCE = new Set(["HTML", "BODY", "DIV", "SPAN", "CENTER", "MAIN", "ARTICLE"]);

/** Unwrap single generic shells so `.lc-md-ink-doc > *` are real blocks. */
export function flattenWebSnapshot(holder: HTMLElement): void {
  for (let step = 0; step < 24; step += 1) {
    if (holder.children.length !== 1) return;
    const only = holder.children[0];
    if (!(only instanceof HTMLElement)) return;
    if (!FLATTEN_ONCE.has(only.tagName)) return;
    holder.replaceChildren(...Array.from(only.childNodes));
  }
}

async function fetchViaViteProxy(url: string): Promise<{ url: string; html: string }> {
  const response = await fetch(`./__lc-web-fetch?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(detail || `the page returned HTTP ${response.status}`);
  }
  const finalUrl = response.headers.get("x-lc-final-url") || url;
  const html = await response.text();
  return { url: finalUrl, html };
}

export async function fetchWebPage(raw: string): Promise<FetchedWebPage> {
  const url = normalizeExternalUrl(raw);
  if (!url || !isSafeExternalUrl(url)) {
    throw new Error("that does not look like an http(s) address");
  }

  let fetched: { url: string; html: string };
  if (isTauriRuntime()) {
    try {
      const { captureRenderedPage } = await import("./webPageCapture");
      fetched = await captureRenderedPage(url);
    } catch {
      const invoke = await loadInvoke();
      if (invoke) {
        fetched = await invoke<{ url: string; html: string }>("fetch_html", { url });
      } else {
        fetched = await fetchViaViteProxy(url);
      }
    }
  } else {
    fetched = await fetchViaViteProxy(url);
  }

  if (fetched.html.length > PAGE_MAX_BYTES) {
    throw new Error("this page is too large to annotate here");
  }

  const html = sanitizeWebHtml(fetched.html, fetched.url);
  const title = titleFromHtml(fetched.html) || fetched.url;
  return { url: fetched.url, title, html };
}
