/**
 * What makes two web pads the same pad.
 *
 * A web pad's "content" is a frozen copy this app made of a page, so hashing it
 * was a bug with a long tail: every re-freeze minted a new identity — a second
 * row in Recent, a second document in `docs.db`, the previous index orphaned
 * with nothing to collect it, and the *"has changed since it was annotated —
 * starting a fresh set"* banner explaining a loss rather than preventing one.
 *
 * The address is the thing that did not change, so the address is the identity.
 *
 * Deliberately *not* the URL plus the marks: adding a mark would mint a new
 * identity, which is the same bug wearing different clothes. Nor a timestamp,
 * for the same reason.
 */

/**
 * Canonical form of an address, or null if it is not one.
 *
 * The fragment goes: `#introduction` is a place on a page, not another page.
 * The query stays: `?id=5` usually *is* another page. Host case is normalised
 * because DNS does not care and readers type both.
 */
export function webIdentityUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  // "example.com" and "example.com/" are one page; deeper paths keep their shape,
  // because a server may well treat /a and /a/ as different things.
  if (url.pathname === "/" && !url.search) return `${url.protocol}//${url.host}`;
  return url.toString();
}
