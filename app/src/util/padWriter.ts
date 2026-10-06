const writers = new Map<string, Promise<unknown>>();

export function resetPadWritersForTests(): void { writers.clear(); }

/** Serialize a book's transfer and acknowledgement across Save, Sync and drain. */
export async function withPadWriter<T>(kind: string, id: string, work: () => Promise<T>): Promise<T> {
  const key = `${kind}:${id}`;
  const previous = writers.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(work);
  writers.set(key, pending);
  try { return await pending; }
  finally { if (writers.get(key) === pending) writers.delete(key); }
}
