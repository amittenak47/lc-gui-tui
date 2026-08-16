/**
 * Freeze a live document into HTML the pad can paint.
 *
 * Runs in two places: jsdom tests, and `eval` inside a hidden capture webview
 * after the page's own JS has assembled the DOM. No module imports inside
 * {@link serializeCurrentDocument} — `Function#toString` is the eval payload.
 */

export interface SerializedPage {
  url: string;
  html: string;
}

export async function serializeCurrentDocument(): Promise<SerializedPage> {
  const doc = document;
  const base = location.href;

  function absolutizeCssUrls(css: string, href: string): string {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, raw: string) => {
      const url = String(raw).trim();
      if (!url || /^(data:|https?:|blob:|#)/i.test(url)) return match;
      try {
        return `url(${quote}${new URL(url, href).href}${quote})`;
      } catch {
        return match;
      }
    });
  }

  function cssTextFromSheet(sheet: CSSStyleSheet): string | null {
    try {
      const rules = sheet.cssRules;
      const parts: string[] = [];
      for (let i = 0; i < rules.length; i += 1) {
        parts.push(rules[i].cssText);
      }
      return absolutizeCssUrls(parts.join("\n"), sheet.href || base);
    } catch {
      return null;
    }
  }

  const drop = doc.querySelectorAll(
    "script, iframe, object, embed, link[rel=preload], link[rel=modulepreload], link[rel=prefetch]",
  );
  for (const node of Array.from(drop)) node.remove();

  const sheets = Array.from(doc.styleSheets);
  for (const sheet of sheets) {
    const owner = sheet.ownerNode;
    if (!(owner instanceof Element)) continue;
    const href =
      sheet.href ||
      (owner.getAttribute("href") ? new URL(owner.getAttribute("href") || "", base).href : "");
    let css = cssTextFromSheet(sheet);
    if ((css == null || !css.trim()) && href) {
      try {
        const response = await fetch(href);
        if (!response.ok) throw new Error("css");
        css = absolutizeCssUrls(await response.text(), href);
      } catch {
        if (owner.tagName === "LINK") {
          owner.setAttribute("href", href);
        }
        continue;
      }
    }
    if (!css) continue;
    const style = doc.createElement("style");
    style.textContent = css;
    owner.replaceWith(style);
  }

  const leftoverLinks = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'));
  for (const link of leftoverLinks) {
    const hrefAttr = link.getAttribute("href");
    if (!hrefAttr) continue;
    let href = hrefAttr;
    try {
      href = new URL(hrefAttr, base).href;
    } catch {
      continue;
    }
    try {
      const response = await fetch(href);
      if (!response.ok) throw new Error("css");
      const style = doc.createElement("style");
      style.textContent = absolutizeCssUrls(await response.text(), href);
      link.replaceWith(style);
    } catch {
      link.setAttribute("href", href);
    }
  }

  const imgs = Array.from(doc.querySelectorAll("img[src]"));
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src || src.indexOf("data:") === 0) continue;
    let abs = src;
    try {
      abs = new URL(src, base).href;
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) {
      img.setAttribute("src", abs);
      continue;
    }
    try {
      const response = await fetch(abs);
      if (!response.ok) throw new Error("img");
      const blob = await response.blob();
      const data = await new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () {
          resolve(String(reader.result));
        };
        reader.onerror = function () {
          reject(reader.error);
        };
        reader.readAsDataURL(blob);
      });
      img.setAttribute("src", String(data));
    } catch {
      img.setAttribute("src", abs);
    }
  }

  const refs = Array.from(doc.querySelectorAll("[href], [src]"));
  for (const node of refs) {
    const attr = node.hasAttribute("href") ? "href" : "src";
    const raw = node.getAttribute(attr);
    if (!raw || /^(https?:|data:|mailto:|#|javascript:)/i.test(raw)) continue;
    try {
      node.setAttribute(attr, new URL(raw, base).href);
    } catch {
      /* leave */
    }
  }

  return { url: base, html: doc.documentElement.outerHTML };
}

/** Start serialize in the capture webview; poll {@link SERIALIZE_POLL_SCRIPT}. */
export const SERIALIZE_PAGE_SCRIPT = `(function(){if(window.__lcCaptureKick)return true;window.__lcCaptureKick=true;window.__lcCapture={done:false};(${serializeCurrentDocument.toString()})().then(function(result){window.__lcCapture={done:true,result:result};},function(err){window.__lcCapture={done:true,error:String(err)};});return true;})()`;

export const SERIALIZE_POLL_SCRIPT =
  "(function(){var c=window.__lcCapture;if(!c||!c.done)return null;return c;})()";

export const READY_STATE_SCRIPT = "document.readyState";
