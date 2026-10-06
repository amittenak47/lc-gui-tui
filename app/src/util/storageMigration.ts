/** Restartable, bounded imports. Sources and divergent versions remain retained. */
import {
  BOOK_STORES, LEGACY_DB_NAME, openDb, transactionOn, abortTransaction,
} from "./idb";
import {
  captureLegacyStorage, importLegacyRows, LEGACY_QUEUE_STORE, MigrationError,
  recognizedLegacyStores, type MigrationRow,
} from "./queueMigration";
import { MIGRATED_MARKER, remapLcKey } from "./storageKeys";
import { canonicalJson, hashBytes } from "./syncContent";
import { bytesToB64 } from "../api/nativeHttp";

const STORES_DONE_KEY = `${MIGRATED_MARKER}.stores`;
const COVERAGE_KEY = `${MIGRATED_MARKER}.v8.coverage`;
const BATCH_ROWS = 64;
const BATCH_BYTES = 8 * 1024 * 1024;

export function migrationBatchIsFull(rows:number,bytes:number):boolean {return rows>=BATCH_ROWS || bytes>=BATCH_BYTES;}
export function migrationRowSize(value:unknown):number {
  if(value instanceof ArrayBuffer || ArrayBuffer.isView(value))return value.byteLength;
  if(typeof Blob!=="undefined"&&value instanceof Blob)return value.size;
  if(typeof value==="string")return value.length*2;
  return 4096;
}
function yieldToPaint():Promise<void> {return new Promise(resolve=>setTimeout(resolve,0));}

export function migrateLocalStorageKeys(storage:Storage=localStorage):void {
  const keys=Array.from({length:storage.length},(_,index)=>storage.key(index)).filter((key):key is string=>!!key);
  for(const key of keys) {
    const next=remapLcKey(key);if(!next)continue;
    try {const value=storage.getItem(key);if(value!==null&&storage.getItem(next)===null)storage.setItem(next,value);} catch { /* retain both source and prior destination */ }
  }
}
export function remapCoachStorageKeys(storage:Storage=localStorage):void {
  const keys=Array.from({length:storage.length},(_,index)=>storage.key(index)).filter((key):key is string=>!!key);
  for(const key of keys) {
    if(!key.startsWith("whiteboard.coach."))continue;
    const next=`whiteboard.agent.${key.slice("whiteboard.coach.".length)}`;
    try {const value=storage.getItem(key);if(value!==null&&storage.getItem(next)===null)storage.setItem(next,value);} catch { /* original remains */ }
  }
}

/** Omit a version: an old source must never be upgraded by an importer. */
export async function openLegacyExisting(name:string=LEGACY_DB_NAME):Promise<IDBDatabase|null> {
  if(typeof indexedDB==="undefined")return null;
  if(typeof indexedDB.databases==="function") {
    const databases=await indexedDB.databases();
    if(!databases.some(database=>database.name===name))return null;
  }
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(name);
    let absent=false,settled=false;
    request.onupgradeneeded=()=>{absent=true;request.transaction?.abort();};
    request.onerror=()=>{if(settled)return;settled=true;if(absent)resolve(null);else reject(request.error??new MigrationError(`Could not read ${name}`));};
    request.onblocked=()=>{settled=true;reject(new MigrationError(`Another window is holding ${name}. The source has been retained.`));};
    request.onsuccess=()=>{
      if(settled){request.result.close();return;}
      settled=true;request.result.onversionchange=()=>request.result.close();resolve(request.result);
    };
  });
}

async function readBatch(source:IDBDatabase,name:string,after:IDBValidKey|undefined):Promise<MigrationRow[]> {
  return transactionOn<MigrationRow[]>(source,[name],"readonly",(tx,setResult)=>{
    const rows:MigrationRow[]=[];let bytes=0;
    const request=tx.objectStore(name).openCursor(after===undefined?undefined:IDBKeyRange.lowerBound(after,true));
    request.onsuccess=()=>{
      const cursor=request.result;
      if(!cursor){setResult(rows);return;}
      rows.push({key:cursor.key,value:cursor.value});bytes+=migrationRowSize(cursor.value);
      if(migrationBatchIsFull(rows.length,bytes)){setResult(rows);return;}
      cursor.continue();
    };
  });
}

async function importBatch(target:IDBDatabase,name:string,rows:MigrationRow[]):Promise<void> {
  const capture=captureLegacyStorage();
  if(name!==LEGACY_QUEUE_STORE)for(const row of rows)row.fingerprint=await storedFingerprint(row.value);
  await transactionOn<void>(target,BOOK_STORES,"readwrite",(tx,setResult)=>{
    importLegacyRows(tx,name,rows,capture,"lc.docs",cause=>abortTransaction(tx,cause));
    setResult(undefined);
  });
}

/** Hashing/Blob reads happen between batches, never in an IDB transaction. */
async function storedFingerprint(value:unknown):Promise<string> {
  const normalized=async(value:unknown):Promise<unknown>=>{
    if(value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes=value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
      return {$bytes:bytesToB64(bytes)};
    }
    if(typeof Blob!=="undefined"&&value instanceof Blob) {
      const bytes=await value.arrayBuffer();
      if(bytes.byteLength!==value.size)throw new MigrationError("A legacy byte copy could not be read completely; the source has been retained.");
      return {$bytes:bytesToB64(new Uint8Array(bytes)),$type:value.type};
    }
    if(Array.isArray(value))return Promise.all(value.map(normalized));
    if(value&&typeof value==="object") {
      const result:Record<string,unknown>={};
      for(const [key,child]of Object.entries(value)) {
        if(child===undefined)result[key]={$undefined:true};else result[key]=await normalized(child);
      }
      return result;
    }
    return value;
  };
  const serialized=canonicalJson(await normalized(value));
  // Local migration remains possible in environments without WebCrypto.
  if(typeof globalThis.crypto?.subtle?.digest!=="function")return serialized;
  return hashBytes(new TextEncoder().encode(serialized));
}

function markVerified(name:string):void {
  if(typeof localStorage==="undefined")return;
  try {
    const existing=JSON.parse(localStorage.getItem(COVERAGE_KEY)??"[]") as unknown;
    const done=new Set(Array.isArray(existing)?existing.filter((value):value is string=>typeof value==="string"):[]);
    done.add(name);localStorage.setItem(COVERAGE_KEY,JSON.stringify([...done]));
    // Retain old crash checkpoints; v8 coverage is an additional stronger claim.
    const old=JSON.parse(localStorage.getItem(STORES_DONE_KEY)??"[]") as unknown;
    const prior=new Set(Array.isArray(old)?old.filter((value):value is string=>typeof value==="string"):[]);
    prior.add(name);localStorage.setItem(STORES_DONE_KEY,JSON.stringify([...prior]));
  } catch { /* copy remains durable and is idempotent on the next launch */ }
}

/** Re-reading source rows verifies coverage, even if an old source changed. */
export async function migrateDocsDatabase():Promise<void> {
  const source=await openLegacyExisting();if(!source)return;
  try {
    const stores=Array.from(source.objectStoreNames);
    const allowed=recognizedLegacyStores();
    for(const name of stores)if(!allowed.has(name))throw new MigrationError(`Unknown source store ${name}; lc.docs has been retained.`);
    const target=await openDb();
    // Fold all lifecycle predecessors together after payload stores are imported.
    const ordered=stores.filter(name=>name!==LEGACY_QUEUE_STORE);
    if(stores.includes(LEGACY_QUEUE_STORE))ordered.push(LEGACY_QUEUE_STORE);
    for(const name of ordered) {
      let after:IDBValidKey|undefined;
      const jobs:MigrationRow[]=[];
      for(;;) {
        const rows=await readBatch(source,name,after);if(!rows.length)break;
        if(name===LEGACY_QUEUE_STORE)jobs.push(...rows);
        else await importBatch(target,name,rows);
        after=rows[rows.length-1]!.key;
        await yieldToPaint();
      }
      if(jobs.length)await importBatch(target,name,jobs);
      // Each represented row committed, or a failure prevented this checkpoint.
      markVerified(name);
    }
    // Keeping the source avoids deleting data written by a still-running old app.
    // It is never opened at v8 or mutated, even after all target coverage commits.
  } finally {source.close();}
}

/** Every boot initializes v8, independent of the old key-rename marker. */
export async function migrateWhiteboardStorage():Promise<void> {
  if(typeof localStorage!=="undefined") {
    migrateLocalStorageKeys();remapCoachStorageKeys();
  }
  await openDb();
  await migrateDocsDatabase();
  if(typeof localStorage!=="undefined") {
    try {localStorage.setItem(MIGRATED_MARKER,"2");} catch { /* source keys remain */ }
  }
}

export function storageMigrationPending():boolean {
  if(typeof localStorage==="undefined")return true;
  try {return localStorage.getItem(MIGRATED_MARKER)!=="2";} catch {return true;}
}
