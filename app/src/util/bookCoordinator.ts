import type { BookIdentity, PadKind } from "./syncState";

const localWriters = new Map<string, Promise<unknown>>();
let writerIdentity: string | null = null;

export function newBookToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function bookWriterIdentity(): string { return writerIdentity ??= newBookToken(); }
export function hasBookLocks(): boolean { return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function"; }

export async function withBookWrite<T>(kind: PadKind, id: string, work: () => Promise<T>): Promise<T> {
  const name = `book-write:${kind}:${id}`;
  if (hasBookLocks()) return await navigator.locks.request(name, work);
  // IDB serializes durable transactions. This only orders this window's calls;
  // localStorage fallback uses distinct writer keys instead of a shared lock.
  const previous = localWriters.get(name) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(work);
  localWriters.set(name, result);
  void result.finally(() => { if (localWriters.get(name) === result) localWriters.delete(name); }).catch(() => {});
  return result;
}

export async function withBookSync<T>(kind: PadKind, id: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!hasBookLocks()) return Promise.reject(new Error("This device cannot coordinate atomic sync. Local work was kept."));
  return signal ? await navigator.locks.request(`book-sync:${kind}:${id}`, { signal }, work)
    : await navigator.locks.request(`book-sync:${kind}:${id}`, work);
}

export function inkBookIdentity(docKey: string): BookIdentity | null {
  if (docKey.startsWith("md:") && docKey.length > 3) return { kind: "annotate", id: docKey.slice(3) };
  if (docKey.startsWith("wb:") && docKey.length > 3) return { kind: "whiteboard", id: docKey.slice(3) };
  if (docKey.startsWith("fnwb:")) {
    const separator = docKey.indexOf(":", 5);
    if (separator > 5 && separator < docKey.length - 1) return { kind: "annotate", id: docKey.slice(5, separator) };
  }
  return null;
}

export function resetBookCoordinatorForTests(): void { localWriters.clear(); writerIdentity = null; }
