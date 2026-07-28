/** SHA-256 hex digest for code skeleton / solution fingerprints. */
export async function sha256Hex(text: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest !== "function") {
    // Tests / very old environments — stable enough for equality checks only.
    return `plain:${text.length}:${text.slice(0, 64)}`;
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
