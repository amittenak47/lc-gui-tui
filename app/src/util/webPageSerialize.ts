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

  const drop = doc.querySelectorAll("script, iframe, object, embed, link[rel=preload]");
  for (const node of Array.from(drop)) node.remove();

  const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'));
  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) continue;
    let abs = href;
    try {
      abs = new URL(href, base).href;
    } catch {
      continue;
    }
    try {
      const response = await fetch(abs);
      if (!response.ok) throw new Error("css");
      const css = await response.text();
      const style = doc.createElement("style");
      style.textContent = css;
      link.replaceWith(style);
    } catch {
      link.setAttribute("href", abs);
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
