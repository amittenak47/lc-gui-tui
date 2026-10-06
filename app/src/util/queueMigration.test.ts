import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOK_STORES, DB_NAME, LEGACY_DB_NAME, STORE_BOOK_META, STORE_CONTENT, STORE_INK_PAGES,
  STORE_PROBLEM_BOARDS, STORE_SNAPSHOTS, STORE_BYTES, STORE_SYNC_STATE,
  abortTransaction, closeDbForTests, openDb, transactionOn, withTransaction } from "./idb";
import { LEGACY_QUEUE_STORE, MigrationError, captureLegacyStorage, recoveredSnapshotKey } from "./queueMigration";
import { migrateDocsDatabase } from "./storageMigration";
import { listRecoveryCopies, readRecoveryCopy, exportRecoveryCopy, restoreRecoveryRecord, assertBytesUnambiguous } from "./syncRecovery";
import { getBookSyncState, allocateChangeSeqRange } from "./syncState";

const oldStores=["bytes","content","snapshots","ink_pages","offline_boards","problem_boards","note_links",LEGACY_QUEUE_STORE];
let databases:IDBDatabase[]=[];
beforeEach(async()=>{
  await closeDbForTests();
  const values=new Map<string,string>();
  vi.stubGlobal("localStorage",{get length(){return values.size;},key:(index:number)=>[...values.keys()][index]??null,
    getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),
    removeItem:(key:string)=>values.delete(key),clear:()=>values.clear()});
  vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("IDBKeyRange",FakeKeyRange);
});
afterEach(async()=>{await closeDbForTests();for(const db of databases)db.close();databases=[];vi.unstubAllGlobals();});

async function fixture(name=DB_NAME,version=7,stores=oldStores):Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(name,version);
    request.onupgradeneeded=()=>{for(const name of stores)request.result.createObjectStore(name);};
    request.onsuccess=()=>{databases.push(request.result);resolve(request.result);};
    request.onerror=()=>reject(request.error);
  });
}
async function write(db:IDBDatabase,entries:Array<[string,IDBValidKey,unknown]>):Promise<void> {
  await transactionOn<void>(db,[...new Set(entries.map(([name])=>name))],"readwrite",(tx,setResult)=>{
    for(const [name,key,value]of entries)tx.objectStore(name).put(value,key);setResult(undefined);
  });
}
async function read(db:IDBDatabase,name:string,key?:IDBValidKey):Promise<unknown> {
  return transactionOn(db,[name],"readonly",(tx,setResult)=>{
    const request=key===undefined?tx.objectStore(name).getAll():tx.objectStore(name).get(key);
    request.onsuccess=()=>setResult(request.result);
  });
}
const board={v:1,elements:[],appState:{scrollX:0,scrollY:0,zoom:1}};
function wb(id:string,title="Saved"):Record<string,unknown>{return {id,title,updated_at:10,page_count:1,board,agent:[],future:{hash:"authored",rev:7}};}
function ann(id:string):Record<string,unknown>{return {id,name:"notes.md",hash:"source",doc_type:"markdown",updated_at:10,source:"# saved",board,agent:[],footnotes:[],footnote_boards:{scratch:{board,pageCount:1}},future:{keep:true}};}
function snapshot(name="Saved"):Record<string,unknown>{return {kind:"annotate",key:"missing",tier:"7d",written_at:17,payload:{name,board,source:"# Notes",footnotes:[],agent:[],footnoteBoards:{scratch:{board,pageCount:1}},unknown:{keep:true}}};}

describe("atomic v8 upgrade",()=>{
  it("seeds every primary/empty/footnote ink row and leaves index-less owners outside the active library",async()=>{
    localStorage.setItem("whiteboard.annotate.index.v1",JSON.stringify([{id:"a",name:"a.pdf",hash:"source",docType:"pdf",updatedAt:7,locked:true}]));
    const old=await fixture();
    await write(old,[
      [STORE_CONTENT,"a",{board,source:"",agent:[],footnotes:[]}],
      [STORE_INK_PAGES,"md:a\u001f113",{v:1,docKey:"md:a",pageId:113,dirty:false,updatedAt:7,inkC:{v:1,ops:[]}}],
      [STORE_INK_PAGES,"fnwb:a:scratch\u001f0",{v:1,docKey:"fnwb:a:scratch",pageId:0,dirty:false,updatedAt:7,inkC:{v:1,ops:[]}}],
      [STORE_INK_PAGES,"wb:orphan\u001f0",{v:1,docKey:"wb:orphan",pageId:0,dirty:false,updatedAt:7,inkC:{v:1,ops:[]}}],
    ]);old.close();
    const db=await openDb();expect(db.version).toBe(8);expect(db.objectStoreNames.contains(LEGACY_QUEUE_STORE)).toBe(false);
    for(const name of BOOK_STORES)expect(db.objectStoreNames.contains(name)).toBe(true);
    const rows=await read(db,STORE_INK_PAGES)as Array<Record<string,unknown>>;
    expect(rows).toHaveLength(3);for(const row of rows)expect(row).toMatchObject({changeSeq:1,syncedChangeSeq:0,syncedRev:0,bootstrap:true,baseWireHash:null,baseLocalHash:null});
    expect(await read(db,STORE_BOOK_META,"annotate:a")).toMatchObject({locked:true,name:"a.pdf"});
    expect(await read(db,STORE_BOOK_META,"whiteboard:orphan")).toBeUndefined();
    expect(await getBookSyncState("whiteboard","orphan")).toMatchObject({bootstrap:true,changeSeq:1,syncedChangeSeq:0});
    const next=await withTransaction<number>([STORE_SYNC_STATE],"readwrite",(tx,done)=>allocateChangeSeqRange(tx,1,done));
    expect(next).toBeGreaterThan(1);
    expect(localStorage.getItem("whiteboard.annotate.index.v1")).not.toBeNull();
  });

  it("represents all eight operations, retains queue-only records and preserves multiple backup/byte copies",async()=>{
    const old=await fixture();
    const pending=[
      {id:"q-1-a",op:"putAnnotate",body:ann("missing-a")},
      {id:"q-1-b",op:"putWhiteboard",body:wb("missing-w")},
      {id:"q-1-c",op:"putProblem",body:{id:"leetcode/42",dataset:"leetcode",task_id:"42",updated_at:10,board,agent:[],future:{keep:true}}},
      {id:"q-1-d",op:"putSnapshot",body:snapshot()},
      {id:"q-1-e",op:"putSnapshot",body:snapshot("Different saved version")},
      {id:"q-1-f",op:"putBytes",hash:"collision",bytes:new Uint8Array([2]).buffer},
      {id:"q-1-g",op:"deletePad",kind:"whiteboard",padId:"life",seq:5,enqueuedAt:1},
      {id:"q-1-z",op:"restorePad",kind:"whiteboard",padId:"life",seq:6,enqueuedAt:2},
      {id:"q-1-h",op:"tombstone",kind:"annotate",padId:"trash",enqueuedAt:3},
    ];
    await write(old,[[STORE_BYTES,"collision",new Uint8Array([1]).buffer],...pending.map(job=>[LEGACY_QUEUE_STORE,job.id,job]as [string,IDBValidKey,unknown])]);old.close();
    const db=await openDb();
    const recovered=await listRecoveryCopies();expect(recovered.filter(copy=>copy.type==="record")).toHaveLength(3);
    const annotation=recovered.find(copy=>copy.bookId==="missing-a")!;
    expect(annotation.record).toMatchObject({meta:{name:"notes.md",authoredExtras:{future:{keep:true}}},payload:{source:"# saved"},children:{scratch:{pageCount:1}},wire:{future:{keep:true}}});
    expect(await read(db,STORE_BOOK_META,"annotate:missing-a")).toBeUndefined();
    expect((await read(db,STORE_SNAPSHOTS)as unknown[])).toHaveLength(2);
    expect(await read(db,STORE_SNAPSHOTS,recoveredSnapshotKey("annotate","missing","7d","queue","q-1-e"))).toMatchObject({name:"Different saved version",unknown:{keep:true}});
    expect(new Uint8Array(await read(db,STORE_BYTES,"collision")as ArrayBuffer)).toEqual(new Uint8Array([1]));
    expect(recovered.find(copy=>copy.type==="bytes")).toMatchObject({claimedHash:"collision"});
    await expect(assertBytesUnambiguous("collision")).rejects.toThrow("Multiple retained byte copies");
    expect(await getBookSyncState("whiteboard","life")).toMatchObject({lifecycle:{action:"restore",seq:6,baseBookRev:null}});
    expect(await getBookSyncState("annotate","trash")).toMatchObject({lifecycle:{action:"delete",baseBookRev:null}});
    expect(await readRecoveryCopy(annotation.id)).toEqual(annotation);expect(await exportRecoveryCopy(annotation.id)).toEqual(annotation);
    const restore=vi.fn(async()=>{});await restoreRecoveryRecord(annotation.id,restore);expect(restore).toHaveBeenCalledWith(annotation.record);
    expect(await readRecoveryCopy(annotation.id)).toEqual(annotation);
  });

  it("preserves a 224-entry mixed backlog including removed parents and distinct same-tier snapshots", async () => {
    const old = await fixture();
    const jobs: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 94; index++) jobs.push({ id: `q-1-record-${index}`, op: "putWhiteboard", body: wb(`missing-${index}`) });
    for (let index = 0; index < 100; index++) jobs.push({ id: `q-1-snapshot-${index}`, op: "putSnapshot", body: snapshot(`Saved copy ${index}`) });
    for (let index = 0; index < 15; index++) jobs.push({ id: `q-1-bytes-${index}`, op: "putBytes", hash: `bytes-${index}`, bytes: new Uint8Array([index]).buffer });
    for (let index = 0; index < 15; index++) jobs.push({ id: `q-1-delete-${index}`, op: "deletePad", kind: "whiteboard", padId: `deleted-${index}`, seq: 2, enqueuedAt: 1 });
    expect(jobs).toHaveLength(224);
    await write(old, jobs.map(job => [LEGACY_QUEUE_STORE, String(job.id), job])); old.close();
    const db = await openDb();
    expect(db.objectStoreNames.contains(LEGACY_QUEUE_STORE)).toBe(false);
    expect((await listRecoveryCopies()).filter(copy => copy.type === "record")).toHaveLength(94);
    const snapshots = await read(db, STORE_SNAPSHOTS) as Array<{ name: string }>;
    expect(new Set(snapshots.map(row => row.name)).size).toBe(100);
    for (let index = 0; index < 15; index++) {
      expect(new Uint8Array(await read(db, STORE_BYTES, `bytes-${index}`) as ArrayBuffer)).toEqual(new Uint8Array([index]));
      expect((await getBookSyncState("whiteboard", `deleted-${index}`))?.lifecycle).toMatchObject({ action: "delete", seq: 2 });
    }
    expect(await read(db, STORE_BOOK_META)).toEqual([]);
  });

  it("does not discard full PUTs because only metadata or partial content exists",async()=>{
    localStorage.setItem("whiteboard.notebook.index.v1",JSON.stringify([{id:"incomplete",title:"Metadata",pageCount:1,updatedAt:5}]));
    const old=await fixture();
    const copies=[{id:"q-1-a",op:"putWhiteboard",body:wb("incomplete","First")},{id:"q-1-b",op:"putWhiteboard",body:wb("incomplete","Second")}];
    await write(old,[[STORE_CONTENT,"incomplete",{agent:[]}],...copies.map(job=>[LEGACY_QUEUE_STORE,job.id,job]as [string,IDBValidKey,unknown])]);old.close();
    await openDb();const rows=await listRecoveryCopies("whiteboard","incomplete");expect(rows).toHaveLength(2);
    expect(rows.map(row=>row.record?.meta.title).sort()).toEqual(["First","Second"]);
  });

  it("uses explicit sequence then chronology independently of lexical cursor order",async()=>{
    const old=await fixture();await write(old,[
      [LEGACY_QUEUE_STORE,"q-1-z",{id:"q-1-z",op:"deletePad",kind:"whiteboard",padId:"a",seq:2,enqueuedAt:20}],
      [LEGACY_QUEUE_STORE,"q-1-a",{id:"q-1-a",op:"restorePad",kind:"whiteboard",padId:"a",seq:3,enqueuedAt:10}],
    ]);old.close();await openDb();expect((await getBookSyncState("whiteboard","a"))?.lifecycle?.action).toBe("restore");
  });

  it("unknown/malformed operations abort schema, seeded fields and queue removal together",async()=>{
    const old=await fixture();const original={id:"q-1-a",op:"alienUpload",data:{must:"remain"}};
    await write(old,[[LEGACY_QUEUE_STORE,original.id,original],[STORE_CONTENT,"known",{board,agent:[]}]]);old.close();
    await expect(openDb()).rejects.toThrow("Unknown or malformed pending operation");
    const restored=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(DB_NAME);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});databases.push(restored);
    expect(restored.version).toBe(7);expect(restored.objectStoreNames.contains(STORE_SYNC_STATE)).toBe(false);
    expect(await read(restored,LEGACY_QUEUE_STORE,original.id)).toEqual(original);expect(await read(restored,STORE_CONTENT,"known")).toEqual({board,agent:[]});
  });

  it("a blocked request cannot later initialize or resolve after rejection",async()=>{
    const old=await fixture();old.onversionchange=()=>{};
    const opening=openDb();await expect(opening).rejects.toThrow("Another window");
    localStorage.setItem("whiteboard.notebook.index.v1",JSON.stringify([{id:"late",title:"Renamed while blocked",updatedAt:1,pageCount:1}]));
    old.close();await new Promise(resolve=>setTimeout(resolve,5));
    const db=await openDb();expect(await read(db,STORE_BOOK_META,"whiteboard:late")).toMatchObject({title:"Renamed while blocked"});
  });

  it("callback failures keep the original cause and roll back every store",async()=>{
    const db=await openDb();const original=new Error("injected quota after request success");
    await expect(withTransaction<void>([STORE_CONTENT,STORE_BOOK_META],"readwrite",tx=>{
      const request=tx.objectStore(STORE_CONTENT).put({board},"a");
      request.onsuccess=()=>{tx.objectStore(STORE_BOOK_META).put({kind:"whiteboard",id:"a"},"whiteboard:a");abortTransaction(tx,original);};
    })).rejects.toBe(original);
    expect(await read(db,STORE_CONTENT,"a")).toBeUndefined();expect(await read(db,STORE_BOOK_META,"whiteboard:a")).toBeUndefined();
  });
});

describe("legacy lc.docs imports",()=>{
  it.each([false,true])("imports all stores into a complete target (existing v8: %s), bootstraps rows and retains source",async(existing)=>{
    if(existing){const target=await openDb();await write(target,[[STORE_SYNC_STATE,"whiteboard:existing",{kind:"whiteboard",id:"existing",changeSeq:20,recordRev:99}]]);}
    const source=await fixture(LEGACY_DB_NAME);
    localStorage.setItem("whiteboard.notebook.index.v1",JSON.stringify([{id:"w",title:"Imported",updatedAt:3,pageCount:1}]));
    await write(source,[
      [STORE_CONTENT,"w",{board,agent:[]}],
      [STORE_INK_PAGES,"wb:w\u001f113",{v:1,docKey:"wb:w",pageId:113,dirty:false,updatedAt:3,inkC:{v:1,ops:[]}}],
      [STORE_PROBLEM_BOARDS,"leetcode/1",{id:"leetcode/1",dataset:"leetcode",taskId:"1",updatedAt:3,board,agent:[]}],
      ["note_links","edge",{id:"edge",from:{type:"whiteboard",id:"w"},to:{type:"practice",id:"leetcode/1"}}],
      ["offline_boards","leetcode\u001f2",{dataset:"leetcode",taskId:"2",updatedAt:3,board}],
      [LEGACY_QUEUE_STORE,"q-1-a",{id:"q-1-a",op:"putSnapshot",body:snapshot()}],
      [LEGACY_QUEUE_STORE,"q-1-b",{id:"q-1-b",op:"putWhiteboard",body:wb("queue-only")}],
    ]);
    await migrateDocsDatabase();const target=await openDb();expect(source.version).toBe(7);expect(source.objectStoreNames.contains(LEGACY_QUEUE_STORE)).toBe(true);
    for(const name of BOOK_STORES)expect(target.objectStoreNames.contains(name)).toBe(true);
    expect(await read(target,STORE_INK_PAGES,"wb:w\u001f113")).toMatchObject({changeSeq:1,bootstrap:true});
    expect(await getBookSyncState("whiteboard","w")).toMatchObject({bootstrap:true,changeSeq:1});
    expect(await getBookSyncState("problem","leetcode/1")).toMatchObject({bootstrap:true});
    expect(await read(target,"note_links","edge")).toMatchObject({id:"edge"});
    expect(await read(target,"offline_boards","leetcode\u001f2")).toMatchObject({taskId:"2"});
    expect(await listRecoveryCopies("whiteboard","queue-only")).toHaveLength(1);
    if(existing)expect(await read(target,STORE_SYNC_STATE,"whiteboard:existing")).toMatchObject({recordRev:99,changeSeq:20});
    await migrateDocsDatabase();expect(await listRecoveryCopies("whiteboard","queue-only")).toHaveLength(1);
  });

  it("unknown source stores stop before checkpoints or source mutation",async()=>{
    const source=await fixture(LEGACY_DB_NAME,7,[...oldStores,"unknown_user_store"]);
    await write(source,[["unknown_user_store","keep",{only:"copy"}]]);
    await expect(migrateDocsDatabase()).rejects.toBeInstanceOf(MigrationError);
    expect(await read(source,"unknown_user_store","keep")).toEqual({only:"copy"});
    expect(localStorage.getItem("whiteboard.migrated.v1.v8.coverage")).toBeNull();
  });

  it("malformed captured indexes fail before opening and never replace readable inputs",()=>{
    localStorage.setItem("whiteboard.annotate.index.v1","{bad index");
    expect(()=>captureLegacyStorage()).toThrow("Unreadable legacy library input");
    expect(localStorage.getItem("whiteboard.annotate.index.v1")).toBe("{bad index");
  });
});
