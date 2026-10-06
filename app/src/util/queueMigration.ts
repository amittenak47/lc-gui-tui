import { recordAuthoredExtras } from "./recordAuthoredExtras";
/** Read-only legacy inputs become current state or immutable recovery, never retries. */
import {
  BOOK_STORES, STORE_BOOK_META, STORE_BYTES, STORE_CONTENT, STORE_INK_PAGES,
  STORE_PROBLEM_BOARDS, STORE_SNAPSHOTS,
  STORE_SYNC_RECOVERY, STORE_SYNC_STATE, transactionOn, abortTransaction,
} from "./idb";
import { seedSyncState, syncStateKey, type BookMeta, type PadKind, type SyncState } from "./syncStateTypes";
import { withBookWrite } from "./bookCoordinator";

export const LEGACY_QUEUE_STORE = "pad_sync_queue";
const LEGACY_OPS = new Set(["putAnnotate", "putWhiteboard", "putProblem", "putSnapshot", "putBytes", "deletePad", "tombstone", "restorePad"]);
export class MigrationError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) { super(message); this.name = "MigrationError"; this.cause = cause; }
}
export interface MigrationRow { key: IDBValidKey; value: unknown; fingerprint?:string }
export interface LegacyStorageCapture {
  values: Map<string,string>;
  metadata: BookMeta[];
  content: Map<string,unknown>;
  ambiguousContent: Set<string>;
  records: Map<string, {meta:BookMeta;payload:Record<string,unknown>}>;
}
export interface RecoveryCopy {
  id:string; type:"record"|"bytes"|"conflict"; kind?:PadKind; bookId?:string;
  claimedHash?:string; provenance:Record<string,unknown>;
  record?:{meta:BookMeta;payload:Record<string,unknown>;children?:Record<string,unknown>;wire?:Record<string,unknown>};
  bytes?:unknown; dependencies?:unknown; content?:unknown;
}
type ObjectValue = Record<string,unknown>;
interface LegacyJob extends ObjectValue { id:string;op:string;enqueuedAt?:number;seq?:number;kind?:PadKind;padId?:string;body?:ObjectValue;hash?:string;bytes?:unknown }
type RowsByStore = Map<string,MigrationRow[]>;

function object(value:unknown):value is ObjectValue { return !!value && typeof value === "object" && !Array.isArray(value); }
function identity(value:unknown):value is string {return typeof value === "string" && !!value && value.trim()===value && !/[\u0000-\u001f\u007f]/u.test(value);}
function padKind(value:unknown):value is PadKind {return value === "annotate" || value === "whiteboard" || value === "problem";}
function safeNumber(value:unknown):value is number {return typeof value === "number" && Number.isSafeInteger(value) && value>=0;}
function fail(message:string):never {throw new MigrationError(`${message}. The original library and pending copies have been retained.`);}
function ownerKey(kind:PadKind,id:string):string {return syncStateKey(kind,id);}
function guarded(failure:(cause:unknown)=>void, work:()=>void):void {try {work();} catch(cause) {failure(cause);}}

/** Captured before opening/upgrading; existing keys are never removed. */
export function captureLegacyStorage(storage?:Storage):LegacyStorageCapture {
  const capture:LegacyStorageCapture={values:new Map(),metadata:[],content:new Map(),ambiguousContent:new Set(),records:new Map()};
  const envelopeMetadata=new Map<string,BookMeta|null>();
  const source=storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  if (!source) return capture;
  const keys:string[]=[];
  try {for(let i=0;i<source.length;i++) {const key=source.key(i);if(key) keys.push(key);}} catch {return capture;}
  const metadataKeys:Record<string,PadKind>={
    "whiteboard.annotate.index.v1":"annotate","lc.md-ink.index.v1":"annotate",
    "whiteboard.notebook.index.v1":"whiteboard","lc.scratchpad.index.v1":"whiteboard",
  };
  const libraryKeys:Record<string,PadKind>={
    "whiteboard.annotate.library.v1":"annotate","lc.md-ink.library.v1":"annotate",
    "whiteboard.notebook.library.v1":"whiteboard","lc.scratchpad.library.v1":"whiteboard",
  };
  // Read legacy spellings first; modern spellings are retained too and take precedence.
  keys.sort((a,b)=>Number(a.startsWith("whiteboard."))-Number(b.startsWith("whiteboard.")) || a.localeCompare(b));
  for(const key of keys) {
    const kind=metadataKeys[key] ?? libraryKeys[key];
    const prefix=key.startsWith("whiteboard.content.v1.") ? "whiteboard.content.v1." : key.startsWith("lc.content.v1.") ? "lc.content.v1." : null;
    if(!kind && !prefix) continue;
    const raw=source.getItem(key);if(raw===null) continue;
    capture.values.set(key,raw);
    let parsed:unknown;
    try {parsed=JSON.parse(raw);} catch(cause) {throw new MigrationError(`Unreadable legacy library input ${key}`,cause);}
    if(prefix) {
      let id=key.slice(prefix.length);if(!identity(id) || !object(parsed)) fail(`Malformed content spill ${key}`);
      let payload:unknown=parsed;
      if(parsed.v===2 && "owner" in parsed) {
        if(!object(parsed.owner)||!padKind(parsed.owner.kind)||!identity(parsed.owner.id)||!identity(parsed.key)
          ||!identity(parsed.token)||!identity(parsed.writerId)||!object(parsed.state)
          ||(parsed.metadata!==null&&(!object(parsed.metadata)||parsed.metadata.kind!==parsed.owner.kind||parsed.metadata.id!==parsed.owner.id)))
          fail(`Malformed saved fallback envelope ${key}`);
        id=parsed.key;payload=parsed.payloadPresent===false?undefined:parsed.payload;
        if(id===parsed.owner.id) {
          const prior=envelopeMetadata.get(ownerKey(parsed.owner.kind,parsed.owner.id));
          const meta=parsed.metadata as BookMeta|null;
          if(envelopeMetadata.has(ownerKey(parsed.owner.kind,parsed.owner.id))&&!equalStored(prior,meta))capture.ambiguousContent.add(id);
          else envelopeMetadata.set(ownerKey(parsed.owner.kind,parsed.owner.id),meta);
        }
      } else if(object(parsed.payload)&&typeof parsed.token==="string")payload=parsed.payload;
      if(capture.content.has(id)&&!equalStored(capture.content.get(id),payload))capture.ambiguousContent.add(id);
      if(!capture.ambiguousContent.has(id))capture.content.set(id,payload);
      else capture.content.delete(id);
      continue;
    }
    if(!Array.isArray(parsed)) fail(`Malformed library index ${key}`);
    for(const entry of parsed) {
      if(!object(entry) || !identity(entry.id)) fail(`Malformed library identity in ${key}`);
      if(kind === "annotate" && (!identity(entry.hash) || typeof entry.name !== "string")) fail(`Malformed annotation metadata in ${key}`);
      if(kind === "whiteboard" && typeof entry.title !== "string") fail(`Malformed notebook metadata in ${key}`);
      const meta={...entry,kind,id:entry.id} as BookMeta;
      if(libraryKeys[key]) {
        const {board,agent,source,footnotes,artifacts,...small}=entry;
        const metadata={...small,kind,id:entry.id} as BookMeta;
        const payload={board,agent,...(source!==undefined?{source}:{}),...(footnotes!==undefined?{footnotes}:{}),...(artifacts!==undefined?{artifacts}:{} )};
        capture.metadata.push(metadata);
        capture.records.set(ownerKey(kind,entry.id),{meta:metadata,payload});
      } else {capture.metadata.push(meta);}
    }
  }
  for(const meta of envelopeMetadata.values())if(meta&&!capture.ambiguousContent.has(meta.id))capture.metadata.push(meta);
  return capture;
}

export function equalStored(a:unknown,b:unknown):boolean {
  if(a===b) return true;
  if(a instanceof ArrayBuffer || ArrayBuffer.isView(a)) {
    if(!(b instanceof ArrayBuffer || ArrayBuffer.isView(b))) return false;
    const left=a instanceof ArrayBuffer?new Uint8Array(a):new Uint8Array(a.buffer,a.byteOffset,a.byteLength);
    const right=b instanceof ArrayBuffer?new Uint8Array(b):new Uint8Array(b.buffer,b.byteOffset,b.byteLength);
    return left.length===right.length && left.every((byte,index)=>byte===right[index]);
  }
  if(typeof Blob!=="undefined" && (a instanceof Blob || b instanceof Blob)) return false;
  if(Array.isArray(a)) return Array.isArray(b) && a.length===b.length && a.every((value,index)=>equalStored(value,b[index]));
  if(object(a) && object(b)) {
    const keys=Object.keys(a);return keys.length===Object.keys(b).length && keys.every(key=>Object.hasOwn(b,key)&&equalStored(a[key],b[key]));
  }
  return false;
}

function keyIdentity(key:IDBValidKey):unknown {
  if(key instanceof Date) return {date:key.toISOString()};
  if(key instanceof ArrayBuffer || ArrayBuffer.isView(key)) {
    const bytes=key instanceof ArrayBuffer?new Uint8Array(key):new Uint8Array(key.buffer,key.byteOffset,key.byteLength);
    return {bytes:Array.from(bytes)};
  }
  return Array.isArray(key)?key.map(keyIdentity):key;
}
export function recoveryId(source:string,store:string,key:IDBValidKey,owner?:string):string {
  return `recovery:${JSON.stringify([source,store,keyIdentity(key),owner??null])}`;
}
export function recoveredSnapshotKey(kind:string,key:string,tier:string,source:string,id:string):string {
  return `recovered:${JSON.stringify([kind,key,tier,source,id])}`;
}

function addRecovery(tx:IDBTransaction,copy:RecoveryCopy,failure:(cause:unknown)=>void):void {
  const store=tx.objectStore(STORE_SYNC_RECOVERY);
  const request=store.get(copy.id);
  request.onsuccess=()=>guarded(failure,()=>{
    if(request.result===undefined) store.add(copy,copy.id);
    else if(!equalStored(request.result,copy)) fail(`A recovered copy changed identity ${copy.id}`);
  });
}

function inkOwner(row:unknown,key:IDBValidKey):{kind:PadKind;id:string}|null {
  const docKey=object(row)&&typeof row.docKey === "string"?row.docKey:typeof key === "string"?key.split("\u001f")[0]:"";
  if(docKey.startsWith("md:")) return {kind:"annotate",id:docKey.slice(3)};
  if(docKey.startsWith("wb:")) return {kind:"whiteboard",id:docKey.slice(3)};
  if(docKey.startsWith("fnwb:")) {const rest=docKey.slice(5);const separator=rest.indexOf(":");if(separator>0)return {kind:"annotate",id:rest.slice(0,separator)};}
  return null;
}

function currentReadable(kind:PadKind,meta:BookMeta|undefined,payload:unknown):boolean {
  if(!meta || !object(payload) || !object(payload.board) || payload.board.v!==1 || !Array.isArray(payload.board.elements)) return false;
  // Compressed inline content cannot be verified synchronously in an upgrade.
  if(payload.board.inkC!==undefined) return false;
  if(payload.agent!==undefined && !Array.isArray(payload.agent)) return false;
  if(kind === "annotate") return identity(meta.hash) && typeof meta.name === "string"
    && (meta.docType === "pdf" || meta.docType === "epub" || typeof payload.source === "string")
    && (payload.footnotes===undefined || Array.isArray(payload.footnotes));
  if(kind === "whiteboard") return typeof meta.title === "string" && safeNumber(meta.pageCount) && meta.pageCount>0;
  return identity(meta.dataset) && identity(meta.taskId);
}

function translatedRecord(kind:PadKind,body:ObjectValue):NonNullable<RecoveryCopy["record"]> {
  if(!identity(body.id)||!object(body.board)||body.board.v!==1||!Array.isArray(body.board.elements)) fail("Unsupported pending record body");
  if(body.agent!==undefined && !Array.isArray(body.agent)) fail("Malformed pending transcript");
  const extras=recordAuthoredExtras(body);
  let meta:BookMeta;
  if(kind === "annotate") {
    if(!identity(body.hash)||typeof body.name!=="string"||typeof body.source!=="string"
      || (body.footnotes!==undefined && !Array.isArray(body.footnotes))
      || (body.footnote_boards!==undefined && !object(body.footnote_boards))) fail("Unsupported pending annotation body");
    meta={kind,id:body.id,name:body.name,hash:body.hash,docType:body.doc_type??"markdown",label:body.label??"",updatedAt:body.updated_at};
  } else if(kind === "whiteboard") {
    if(typeof body.title!=="string"||!safeNumber(body.page_count)||body.page_count===0) fail("Unsupported pending notebook body");
    meta={kind,id:body.id,title:body.title,pageCount:body.page_count,updatedAt:body.updated_at};
  } else {
    if(!identity(body.dataset)||!identity(body.task_id)||body.id!==`${body.dataset}/${body.task_id}`) fail("Unsupported pending problem body");
    meta={kind,id:body.id,dataset:body.dataset,taskId:body.task_id,updatedAt:body.updated_at};
  }
  if(!safeNumber(body.updated_at)) fail("Invalid pending record display timestamp");
  if(body.sync_seq!==undefined && !safeNumber(body.sync_seq)) fail("Invalid pending lifecycle sequence");
  if(body.deleted_at!==undefined && body.deleted_at!==null && !safeNumber(body.deleted_at)) fail("Invalid pending trash timestamp");
  meta={...meta,syncSeq:body.sync_seq??0,...(body.deleted_at!=null?{deletedAt:body.deleted_at}:{}),authoredExtras:extras};
  const payload={board:body.board,agent:body.agent??[],...(body.source!==undefined?{source:body.source}:{}),
    ...(body.footnotes!==undefined?{footnotes:body.footnotes}:{}),...(body.artifacts!==undefined?{artifacts:body.artifacts}:{})};
  return {meta,payload,...(object(body.footnote_boards)?{children:body.footnote_boards}:{}),wire:{...body}};
}

function validateJob(value:unknown,key:IDBValidKey):LegacyJob {
  if(!object(value)||!identity(value.id)||!identity(value.op)||!LEGACY_OPS.has(value.op)) fail(`Unknown or malformed pending operation ${String(key)}`);
  const job=value as LegacyJob;
  if(job.enqueuedAt!==undefined&&!safeNumber(job.enqueuedAt)) fail(`Invalid pending chronology ${job.id}`);
  if(job.op.startsWith("put") && job.op!=="putBytes" && !object(job.body)) fail(`Missing pending body ${job.id}`);
  if(["deletePad","restorePad","tombstone"].includes(job.op)) {
    if(!padKind(job.kind)||!identity(job.padId)||(job.seq!==undefined&&!safeNumber(job.seq))) fail(`Invalid pending lifecycle ${job.id}`);
  }
  if(job.op === "putBytes" && (!identity(job.hash)||!(job.bytes instanceof ArrayBuffer || ArrayBuffer.isView(job.bytes) || typeof Blob!=="undefined"&&job.bytes instanceof Blob))) fail(`Invalid pending bytes ${job.id}`);
  return job;
}

function chronology(job:LegacyJob):number|null {
  if(job.enqueuedAt!==undefined) return job.enqueuedAt;
  const match=/^q-([0-9a-z]+)-/u.exec(job.id);
  const value=match?parseInt(match[1],36):NaN;
  return Number.isSafeInteger(value)&&value>0?value:null;
}
function lifecycleCompare(a:LegacyJob,b:LegacyJob):number {
  if(a.seq!==undefined && b.seq!==undefined && a.seq!==b.seq) return a.seq-b.seq;
  const left=chronology(a),right=chronology(b);
  if(left===null||right===null) {
    if(a.op===b.op && a.seq===b.seq) return a.id.localeCompare(b.id);
    fail("The order of pending delete/restore choices cannot be established");
  }
  return left-right || a.id.localeCompare(b.id);
}

function convertSnapshot(body:ObjectValue):ObjectValue {
  if(!identity(body.kind)||!identity(body.key)||!object(body.payload)||!safeNumber(body.written_at)
    || !["annotate","whiteboard"].includes(body.kind)||!["2h","24h","7d"].includes(String(body.tier))
    || !object(body.payload.board)) fail("Unsupported pending backup body");
  return {...body.payload,kind:body.kind,key:body.key,tier:body.tier,writtenAt:body.written_at};
}

const pendingSnapshots=new WeakMap<IDBTransaction,Map<string,unknown>>();
function writeSnapshot(tx:IDBTransaction,value:ObjectValue,source:string,id:string,failure:(cause:unknown)=>void):void {
  const store=tx.objectStore(STORE_SNAPSHOTS);
  const key=`${value.kind}:${value.key}:${value.tier}`;
  const request=store.get(key);
  request.onsuccess=()=>guarded(failure,()=>{
    const pending=pendingSnapshots.get(tx)??new Map<string,unknown>();pendingSnapshots.set(tx,pending);
    const existing=pending.has(key)?pending.get(key):request.result;
    if(existing===undefined) {store.put(value,key);pending.set(key,value);}
    else if(!equalStored(existing,value)) {
      const recovered=recoveredSnapshotKey(String(value.kind),String(value.key),String(value.tier),source,id);
      const copy={...value,snapshotId:recovered};
      const read=store.get(recovered);
      read.onsuccess=()=>guarded(failure,()=>{
        if(read.result===undefined) store.add(copy,recovered);
        else if(!equalStored(read.result,copy)) fail("A recovered backup changed identity");
      });
    }
  });
}

const pendingBytes=new WeakMap<IDBTransaction,Map<string,unknown>>();
function writeBytes(tx:IDBTransaction,hash:string,bytes:unknown,source:string,id:IDBValidKey,failure:(cause:unknown)=>void):void {
  const store=tx.objectStore(STORE_BYTES);
  const request=store.get(hash);
  request.onsuccess=()=>guarded(failure,()=>{
    const pending=pendingBytes.get(tx)??new Map<string,unknown>();pendingBytes.set(tx,pending);
    const existing=pending.has(hash)?pending.get(hash):request.result;
    if(existing===undefined) {store.put(bytes,hash);pending.set(hash,bytes);}
    else if(!equalStored(existing,bytes)) addRecovery(tx,{id:recoveryId(source,STORE_BYTES,id,hash),type:"bytes",claimedHash:hash,
      provenance:{source,store:STORE_BYTES,key:keyIdentity(id),collision:true},bytes},failure);
  });
}

function readRows(tx:IDBTransaction,name:string,ready:(rows:MigrationRow[])=>void,failure:(cause:unknown)=>void):void {
  const rows:MigrationRow[]=[];
  const cursor=tx.objectStore(name).openCursor();
  cursor.onsuccess=()=>guarded(failure,()=>{
    if(!cursor.result) {ready(rows);return;}
    rows.push({key:cursor.result.key,value:cursor.result.value});cursor.result.continue();
  });
}

function loadStores(tx:IDBTransaction,names:string[],ready:(rows:RowsByStore)=>void,failure:(cause:unknown)=>void):void {
  const rows:RowsByStore=new Map();let remaining=names.length;
  if(!remaining) {ready(rows);return;}
  for(const name of names) readRows(tx,name,values=>{rows.set(name,values);if(--remaining===0)ready(rows);},failure);
}

function bootstrapState(kind:PadKind,id:string,meta?:BookMeta):SyncState {
  const state=seedSyncState(kind,id);
  if(meta && (meta.deletedAt!=null||meta.purgedAt!=null))state.lifecycle={action:"delete",seq:Math.max(1,safeNumber(meta.syncSeq)?meta.syncSeq:0),
    token:recoveryId("bootstrap","lifecycle",ownerKey(kind,id)),baseBookRev:null,goneSeq:null};
  return state;
}

function seedParent(tx:IDBTransaction,kind:PadKind,id:string,failure:(cause:unknown)=>void,meta?:BookMeta):void {
  if(!identity(id)) fail("Invalid local book identity");
  const store=tx.objectStore(STORE_SYNC_STATE),key=ownerKey(kind,id),read=store.get(key);
  read.onsuccess=()=>guarded(failure,()=>{if(read.result===undefined)store.put(bootstrapState(kind,id,meta),key);});
}

function seedInk(tx:IDBTransaction,row:MigrationRow,failure:(cause:unknown)=>void,forceBootstrap=false):void {
  const owner=inkOwner(row.value,row.key);
  if(!object(row.value)||!owner||!safeNumber(row.value.pageId)) fail(`Malformed local ink ${String(row.key)}`);
  const value=row.value;
  if(forceBootstrap||value.changeSeq===undefined) tx.objectStore(STORE_INK_PAGES).put({...value,changeSeq:1,syncedChangeSeq:0,
    syncedRev:0,baseWireHash:null,baseLocalHash:null,bootstrap:true},row.key);
  seedParent(tx,owner.kind,owner.id,failure);
}

function seedCounter(tx:IDBTransaction,failure:(cause:unknown)=>void):void {
  const store=tx.objectStore(STORE_SYNC_STATE),read=store.getAll();
  read.onsuccess=()=>guarded(failure,()=>{
    let maximum=1;
    for(const value of read.result as unknown[]) {
      if(typeof value === "number") {if(!safeNumber(value))fail("Invalid local sequence counter");maximum=Math.max(maximum,value);}
      else if(object(value)) {
        const candidates=[value.value,value.changeSeq,value.syncedChangeSeq].filter(candidate=>candidate!==undefined);
        for(const candidate of candidates){if(!safeNumber(candidate))fail("Invalid local sequence counter");maximum=Math.max(maximum,candidate);}
      }
    }
    store.put({value:maximum},"__seq");
  });
}

function effectiveMetas(capture:LegacyStorageCapture,rows:RowsByStore):Map<string,BookMeta> {
  const metas=new Map<string,BookMeta>();
  for(const meta of capture.metadata) metas.set(ownerKey(meta.kind,meta.id),meta);
  for(const row of rows.get(STORE_BOOK_META)??[]) {
    if(!object(row.value)||!padKind(row.value.kind)||!identity(row.value.id)) fail("Malformed authoritative book metadata");
    metas.set(ownerKey(row.value.kind,row.value.id),row.value as BookMeta);
  }
  return metas;
}

function bootstrapRows(tx:IDBTransaction,capture:LegacyStorageCapture,rows:RowsByStore,failure:(cause:unknown)=>void):Map<string,BookMeta> {
  const metas=effectiveMetas(capture,rows);
  const existing=new Set((rows.get(STORE_BOOK_META)??[]).map(row=>String(row.key)));
  for(const [key,meta] of metas) {
    if(!existing.has(key)) tx.objectStore(STORE_BOOK_META).put(meta,key);
    seedParent(tx,meta.kind,meta.id,failure,meta);
  }
  for(const [key,record] of capture.records) {
    const read=tx.objectStore(STORE_CONTENT).get(record.meta.id);
    read.onsuccess=()=>guarded(failure,()=>{if(read.result===undefined)tx.objectStore(STORE_CONTENT).put(record.payload,record.meta.id);
      else if(!equalStored(read.result,record.payload))addRecovery(tx,{id:recoveryId("localStorage","library",key),type:"record",kind:record.meta.kind,bookId:record.meta.id,
        provenance:{source:"localStorage",key},record},failure);});
  }
  for(const row of rows.get(STORE_PROBLEM_BOARDS)??[]) {
    if(!object(row.value)||!identity(row.value.id)||!identity(row.value.dataset)||!identity(row.value.taskId)) fail("Malformed local problem record");
    const {board,agent,artifacts,...small}=row.value;
    const meta={...small,kind:"problem",id:row.value.id} as BookMeta;
    if(!existing.has(ownerKey("problem",meta.id))) {tx.objectStore(STORE_BOOK_META).put(meta,ownerKey("problem",meta.id));metas.set(ownerKey("problem",meta.id),meta);}
    seedParent(tx,"problem",meta.id,failure,meta);
  }
  for(const row of rows.get(STORE_INK_PAGES)??[]) seedInk(tx,row,failure);
  for(const row of rows.get(STORE_CONTENT)??[]) {
    if(typeof row.key==="string"&&row.key.startsWith("fnwb:")) {
      const rest=row.key.slice(5),end=rest.indexOf(":");if(end>0)seedParent(tx,"annotate",rest.slice(0,end),failure);
    } else if(typeof row.key==="string") {
      const matching=[...metas.values()].find(meta=>meta.id===row.key);
      if(matching)seedParent(tx,matching.kind,matching.id,failure);
    }
  }
  seedCounter(tx,failure);
  return metas;
}

/** Called only while the upgrade/import transaction is live. No async work. */
export function foldLegacyRows(tx:IDBTransaction,jobs:MigrationRow[],capture:LegacyStorageCapture,rows:RowsByStore,
  source:string,failure:(cause:unknown)=>void):void {
  const parsed=jobs.map(row=>validateJob(row.value,row.key));
  const metas=effectiveMetas(capture,rows);
  const contents=new Map((rows.get(STORE_CONTENT)??[]).map(row=>[String(row.key),row.value]));
  const problems=new Map((rows.get(STORE_PROBLEM_BOARDS)??[]).map(row=>[String(row.key),row.value]));
  const lifecycles=new Map<string,LegacyJob[]>();
  for(const job of parsed) {
    if(["deletePad","restorePad","tombstone"].includes(job.op)) {
      const key=ownerKey(job.kind!,job.padId!);const list=lifecycles.get(key)??[];list.push(job);lifecycles.set(key,list);continue;
    }
    if(job.op==="putBytes") {writeBytes(tx,job.hash!,job.bytes,source,job.id,failure);continue;}
    if(job.op==="putSnapshot") {writeSnapshot(tx,convertSnapshot(job.body!),source,job.id,failure);continue;}
    const kind:PadKind=job.op==="putAnnotate"?"annotate":job.op==="putWhiteboard"?"whiteboard":"problem";
    const recovered=translatedRecord(kind,job.body!);
    const key=ownerKey(kind,recovered.meta.id);
    const full=capture.records.get(key);
    const meta=metas.get(key)??full?.meta;
    const payload=kind==="problem"?problems.get(recovered.meta.id):capture.content.get(recovered.meta.id)??contents.get(recovered.meta.id)??full?.payload;
    if(capture.ambiguousContent.has(recovered.meta.id)||!currentReadable(kind,meta,payload)) addRecovery(tx,{id:recoveryId(source,LEGACY_QUEUE_STORE,job.id,key),type:"record",kind,bookId:recovered.meta.id,
      provenance:{source,sourceId:job.id,originalMetadata:Object.fromEntries(Object.entries(job).filter(([field])=>field!=="body"&&field!=="op"))},record:recovered,
      dependencies:{sourceHash:recovered.meta.hash??null,children:Object.keys(recovered.children??{})}},failure);
  }
  for(const [key,list] of lifecycles) {
    list.sort(lifecycleCompare);const winner=list[list.length-1],kind=winner.kind!,id=winner.padId!;
    const meta=metas.get(key),currentSeq=safeNumber(meta?.syncSeq)?meta.syncSeq:0;
    if(winner.seq!==undefined&&currentSeq>winner.seq) continue;
    if(winner.seq!==undefined&&currentSeq===winner.seq&&meta && (meta.deletedAt!=null||meta.purgedAt!=null) && winner.op==="restorePad") fail("A pending restore contradicts current trash at the same sequence");
    const action=winner.op==="restorePad"?"restore":"delete";
    const store=tx.objectStore(STORE_SYNC_STATE),read=store.get(key);
    read.onsuccess=()=>guarded(failure,()=>{
      const state=(read.result??seedSyncState(kind,id)) as SyncState;
      const seq=Math.max(1,currentSeq,winner.seq??0);
      store.put({...state,lifecycle:{action,seq,token:recoveryId(source,"lifecycle",winner.id,key),baseBookRev:null,goneSeq:null}},key);
      if(meta)tx.objectStore(STORE_BOOK_META).put({...meta,syncSeq:seq,...(action==="delete"?{deletedAt:meta.deletedAt??chronology(winner)??1}:{deletedAt:undefined,purgedAt:undefined,deleteAcked:false})},key);
    });
  }
}

export function migrateLegacyUpgrade(db:IDBDatabase,tx:IDBTransaction,capture:LegacyStorageCapture,failure:(cause:unknown)=>void):void {
  const names=[STORE_BOOK_META,STORE_CONTENT,STORE_PROBLEM_BOARDS,STORE_INK_PAGES];
  if(db.objectStoreNames.contains(LEGACY_QUEUE_STORE))names.push(LEGACY_QUEUE_STORE);
  loadStores(tx,names,rows=>guarded(failure,()=>{
    const metas=bootstrapRows(tx,capture,rows,failure);
    const represented=new Map(rows);represented.set(STORE_BOOK_META,[...metas].map(([key,value])=>({key,value})));
    foldLegacyRows(tx,rows.get(LEGACY_QUEUE_STORE)??[],capture,represented,"queue",failure);
    if(db.objectStoreNames.contains(LEGACY_QUEUE_STORE)) db.deleteObjectStore(LEGACY_QUEUE_STORE);
  }),failure);
}

/** Detect a v7 tab's edits while an upgrade waited, before exposing authority. */
export async function revalidateLegacyStorage(db:IDBDatabase,captured:LegacyStorageCapture):Promise<void> {
  const current=captureLegacyStorage();
  const changed=[...current.values].some(([key,value])=>captured.values.get(key)!==value)
    || [...captured.values.keys()].some(key=>!current.values.has(key));
  if(!changed)return;
  const identities=[...new Map(current.metadata.map(meta=>[ownerKey(meta.kind,meta.id),meta])).values()]
    .sort((a,b)=>ownerKey(a.kind,a.id).localeCompare(ownerKey(b.kind,b.id)));
  const publish=()=>transactionOn<void>(db,BOOK_STORES,"readwrite",(tx,setResult)=>{
    let original:unknown;
    const failure=(cause:unknown)=>{original??=cause;abortTransaction(tx,cause);};
    loadStores(tx,[STORE_BOOK_META,STORE_CONTENT,STORE_PROBLEM_BOARDS,STORE_INK_PAGES],rows=>guarded(failure,()=>{
      for(const meta of current.metadata) {
        const before=captured.metadata.filter(entry=>entry.kind===meta.kind&&entry.id===meta.id).at(-1);
        if(equalStored(before,meta))continue;
        const key=ownerKey(meta.kind,meta.id);
        const authoritative=rows.get(STORE_BOOK_META)?.find(row=>row.key===key)?.value;
        if(authoritative!==undefined&&!equalStored(authoritative,meta))addRecovery(tx,{id:recoveryId("blocked-upgrade","metadata",[key,JSON.stringify(authoritative)]),type:"conflict",kind:meta.kind,bookId:meta.id,
          provenance:{source:"blocked-upgrade",alternative:"pre-upgrade metadata"},content:authoritative},failure);
        tx.objectStore(STORE_BOOK_META).put(meta,key);
        seedParent(tx,meta.kind,meta.id,failure);
      }
      // Keep changed spill envelopes readable; promotion owns their token/CAS later.
      setResult(undefined);
    }),failure);
    tx.addEventListener("abort",()=>{if(original) { /* transactionOn retains abort; inputs still intact */ }});
  });
  const locked=(index:number):Promise<void>=>index===identities.length?publish():
    withBookWrite(identities[index].kind,identities[index].id,()=>locked(index+1));
  await locked(0);
}

export function recognizedLegacyStores():ReadonlySet<string> {return new Set([...BOOK_STORES,LEGACY_QUEUE_STORE]);}

/** Shared by restartable lc.docs imports; preserves divergent destination rows. */
export function importLegacyRows(tx:IDBTransaction,storeName:string,rows:MigrationRow[],capture:LegacyStorageCapture,
  source:string,failure:(cause:unknown)=>void):void {
  if(!recognizedLegacyStores().has(storeName))fail(`Unknown legacy store ${storeName}`);
  if(storeName===LEGACY_QUEUE_STORE) {
    loadStores(tx,[STORE_BOOK_META,STORE_CONTENT,STORE_PROBLEM_BOARDS],current=>guarded(failure,()=>foldLegacyRows(tx,rows,capture,current,source,failure)),failure);return;
  }
  for(const row of rows) {
    const rowSource=row.fingerprint===undefined?source:`${source}:${row.fingerprint}`;
    if(storeName===STORE_BYTES) {if(typeof row.key!=="string")fail("Invalid imported source hash");writeBytes(tx,row.key,row.value,rowSource,row.key,failure);continue;}
    if(storeName===STORE_SNAPSHOTS) {
      if(!object(row.value))fail("Unsupported imported backup");
      const normalized=row.value.kind==="md-ink"?{...row.value,kind:"annotate"}:row.value;
      if(!identity(normalized.kind)||!identity(normalized.key))fail("Invalid imported backup owner");
      writeSnapshot(tx,normalized,rowSource,String(row.key),failure);continue;
    }
    if(storeName===STORE_SYNC_STATE) {
      if(row.key==="__seq")continue;
      if(!object(row.value)||!padKind(row.value.kind)||!identity(row.value.id))fail("Invalid imported tracking owner");
      const value=row.value,kind=value.kind as PadKind,id=value.id as string;
      const store=tx.objectStore(STORE_SYNC_STATE),key=ownerKey(kind,id),read=store.get(key);
      read.onsuccess=()=>guarded(failure,()=>{
        if(read.result!==undefined)return;
        const state=seedSyncState(kind,id);
        if(value.lifecycle!=null) {
          if(!object(value.lifecycle)||!["delete","restore"].includes(String(value.lifecycle.action))||!safeNumber(value.lifecycle.seq))fail("Invalid imported lifecycle intent");
          state.lifecycle={action:value.lifecycle.action as "delete"|"restore",seq:Math.max(1,value.lifecycle.seq),
            token:recoveryId(rowSource,"lifecycle",row.key),baseBookRev:null,goneSeq:null};
        }
        store.put(state,key);
      });
      continue;
    }
    const store=tx.objectStore(storeName),read=store.get(row.key);
    read.onsuccess=()=>guarded(failure,()=>{
      if(read.result===undefined) {
        store.put(row.value,row.key);
        if(storeName===STORE_INK_PAGES)seedInk(tx,row,failure,true);
        else if(storeName===STORE_BOOK_META) {
          if(!object(row.value)||!padKind(row.value.kind)||!identity(row.value.id))fail("Invalid imported metadata identity");
          seedParent(tx,row.value.kind,row.value.id,failure,row.value as BookMeta);
        }
        else if(storeName===STORE_PROBLEM_BOARDS) {
          if(!object(row.value)||!identity(row.value.id))fail("Invalid imported problem identity");
          const {board,agent,artifacts,...small}=row.value;
          const meta={...small,kind:"problem",id:row.value.id} as BookMeta;
          const m=tx.objectStore(STORE_BOOK_META),prior=m.get(ownerKey("problem",meta.id));
          prior.onsuccess=()=>{if(prior.result===undefined)m.put(meta,ownerKey("problem",meta.id));};
          seedParent(tx,"problem",meta.id,failure,meta);
        } else if(storeName===STORE_CONTENT&&typeof row.key==="string") {
          const meta=capture.metadata.filter(entry=>entry.id===row.key).at(-1);
          if(meta) {
            const m=tx.objectStore(STORE_BOOK_META),prior=m.get(ownerKey(meta.kind,meta.id));
            prior.onsuccess=()=>{if(prior.result===undefined)m.put(meta,ownerKey(meta.kind,meta.id));};
            seedParent(tx,meta.kind,meta.id,failure,meta);
          } else if(row.key.startsWith("fnwb:")) {const rest=row.key.slice(5),end=rest.indexOf(":");if(end>0)seedParent(tx,"annotate",rest.slice(0,end),failure);}
        }
      } else if(!equalStored(read.result,row.value))addRecovery(tx,{id:recoveryId(rowSource,storeName,row.key),type:"conflict",
        provenance:{source,store:storeName,key:keyIdentity(row.key),fingerprint:row.fingerprint??null},content:row.value},failure);
    });
  }
  seedCounter(tx,failure);
}
