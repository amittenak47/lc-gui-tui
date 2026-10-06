/** Minimal multi-store transaction for isolated writer contract tests.
 * Writes remain invisible until every queued request succeeds and commit runs.
 */
export async function memoryBookTransaction<T>(
  stores: Map<string, Map<IDBValidKey, unknown>>, work: (tx: IDBTransaction, result: (value: T) => void) => void,
  beforeCommit?: (tx: IDBTransaction) => void,
): Promise<T> {
  const queued: Array<{ onsuccess?: (() => void) | null }> = [];
  const writes = new Map<string, Map<IDBValidKey, unknown>>();
  const deleted = Symbol("deleted");
  let aborted = false;
  let result!: T;
  const request = (value: unknown) => {
    const req = { result: structuredClone(value), onsuccess: null as (() => void) | null };
    queued.push(req); return req;
  };
  const tx = {
    abort: () => { aborted = true; },
    objectStore(name: string) {
      let rows = stores.get(name); if (!rows) { rows = new Map(); stores.set(name, rows); }
      let staged = writes.get(name); if (!staged) { staged = new Map(); writes.set(name, staged); }
      const read = (key: IDBValidKey) => staged!.has(key) ? staged!.get(key) : rows!.get(key);
      return {
        transaction: tx,
        get: (key: IDBValidKey) => request(read(key) === deleted ? undefined : read(key)),
        put: (value: unknown, key: IDBValidKey) => { staged!.set(key, structuredClone(value)); return request(key); },
        delete: (key: IDBValidKey | IDBKeyRange) => {
          if (typeof key === "object" && key !== null && "lower" in key && "upper" in key) {
            for (const storedKey of new Set([...rows!.keys(), ...staged!.keys()])) {
              if (typeof storedKey === "string" && storedKey >= key.lower && storedKey <= key.upper) staged!.set(storedKey, deleted);
            }
          } else staged!.set(key as IDBValidKey, deleted);
          return request(undefined);
        },
        getAll: () => request([...rows!.values()]),
      };
    },
  };
  work(tx as unknown as IDBTransaction, value => { result = value; });
  for (let index = 0; index < queued.length && !aborted; index++) queued[index]!.onsuccess?.();
  beforeCommit?.(tx as unknown as IDBTransaction);
  if (aborted) throw new Error("transaction aborted");
  for (const [name, staged] of writes) for (const [key, value] of staged) {
    if (value === deleted) stores.get(name)!.delete(key); else stores.get(name)!.set(key, value);
  }
  return result;
}
