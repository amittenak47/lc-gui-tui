import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { LcClient, BookStateDto, CommitRequestDto, CommitResultDto } from "../api/client";
import { syncBook } from "./bookSync";
import { captureBook, acknowledgeBook } from "./bookSnapshot";
import { saveAnnotateDoc, getAnnotateDoc } from "./annotateStore";
import { closeDbForTests } from "./idb";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { recordHash } from "./syncContent";
import { mergeAgentMessages } from "../modes/coachSessions";
const board={v:1 as const,elements:[],appState:{scrollX:0,scrollY:0,zoom:1}};
const owner={kind:"annotate" as const,id:"receipt-book"};
beforeEach(async()=>{await closeDbForTests();resetBookCoordinatorForTests();resetLocalBookStoreForTests();
  vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("IDBKeyRange",IDBKeyRange);
  const values=new Map<string,string>();vi.stubGlobal("localStorage",{get length(){return values.size},key:(i:number)=>[...values.keys()][i]??null,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});
  vi.stubGlobal("navigator",{locks:{request:(_key:string,options:unknown,fn?:()=>Promise<unknown>)=>typeof options==="function"?options():fn!()}});
});
afterEach(async()=>{await closeDbForTests();vi.unstubAllGlobals();});
it.each([false,true])("retains a newer autosave and avoids a repeated conflict after DTO normalization (authored=%s)",async authored=>{
  let head:BookStateDto={...owner,state:"absent",book_rev:0,record_rev:0,record_hash:null,record:null,pages:[],gone_seq:null};
  let duringCommit:(()=>Promise<void>)|undefined;
  const api={getBookState:vi.fn(async()=>structuredClone(head)),checkBookHead:vi.fn(async()=>({unchanged:true,book_rev:head.book_rev})),
    commitPad:vi.fn(async(body:CommitRequestDto)=>{const record=structuredClone(body.record!.value);
      // Rust AnnotatePad omits an empty child map; transcript updates preserve
      // the stored order while updating the same message IDs.
      if(Object.keys(record.footnote_boards as object??{}).length===0)delete record.footnote_boards;
      record.agent=mergeAgentMessages((head.record?.agent??[]) as unknown[],record.agent as unknown[],false);
      head={...head,state:"live",record,record_hash:await recordHash(record),record_rev:head.record_rev+1,book_rev:head.book_rev+1};
      const result={status:"committed",upload_id:body.upload_id,record_rev:head.record_rev,page_revs:[],book:structuredClone(head)} as CommitResultDto;
      const work=duringCommit;duringCommit=undefined;await work?.();return result;})} as unknown as LcClient;
  await saveAnnotateDoc({id:owner.id,name:"Fixture",hash:"fixture-source",docType:"markdown",source:"original",board,footnotes:[],agent:[{id:"a",role:"assistant",at:2,content:"Answer",future:{kept:true}},{id:"q",role:"user",at:1,content:"Question"}]});
  const options={timeoutMs:1000,wait:async()=>{}};
  expect((await syncBook(api,owner.kind,owner.id,undefined,options)).status).toBe("synced");
  head={...head,record:{...head.record!,agent:[...(head.record!.agent as unknown[])].reverse()},record_rev:head.record_rev+1,book_rev:head.book_rev+1};head.record_hash=await recordHash(head.record);
  expect((await syncBook(api,owner.kind,owner.id,undefined,options)).status).toBe("synced");
  const doc=(await getAnnotateDoc(owner.id))!;await saveAnnotateDoc({...doc,name:"Renamed fixture",metadataIntent:"rename"});
  duringCommit=async()=>{const current=(await getAnnotateDoc(owner.id))!;await saveAnnotateDoc({...current,...(authored?{source:"Newer authored text"}:{})});};
  const result=await syncBook(api,owner.kind,owner.id,undefined,options);
  expect(result.status).toBe("synced");expect((await getAnnotateDoc(owner.id))!.source).toBe(authored?"Newer authored text":"original");
  expect(head.record!.source).toBe(authored?"Newer authored text":"original");
  expect((await captureBook(owner)).state.recordRev).toBe(head.record_rev);
  expect((head.record!.agent as unknown[]).map((m:any)=>m.id)).toEqual(["q","a"]);
  expect((head.record!.agent as any[]).find(m=>m.id==="a").future).toEqual({kept:true});
});


it.each(["changed source", "missing unknown field", "message tombstone", "incorrect receipt hash"])(
  "does not acknowledge a normalized receipt with %s", async difference => {
    await saveAnnotateDoc({id:owner.id,name:"Fixture",hash:"fixture-source",docType:"markdown",
      source:"original",board,footnotes:[],agent:[{id:"answer",role:"assistant",at:2,content:"Answer"}]});
    const capture=await captureBook(owner);
    const submitted: Record<string, unknown>={...capture.record!,future:{kept:true}};
    const remote=structuredClone(submitted);
    delete remote.footnote_boards;
    if(difference==="changed source")remote.source="Unexpected replacement";
    if(difference==="missing unknown field")delete remote.future;
    if(difference==="message tombstone")(remote.agent as any[])[0].deletedAt=10;
    const hash=await recordHash(submitted);
    const attempt={uploadId:"receipt",requestHash:"request",record:{capturedSeq:capture.state.changeSeq,
      wireHash:hash,localHash:hash},pages:[],lifecycleToken:null};
    const receipt={status:"committed",upload_id:"receipt",record_rev:12,page_revs:[],book:{...owner,
      state:"live",book_rev:12,record_rev:12,record_hash:difference==="incorrect receipt hash"?"incorrect":await recordHash(remote),
      record:remote,pages:[],gone_seq:null}} as CommitResultDto;
    await acknowledgeBook(capture,attempt,receipt,submitted);
    const after=await captureBook(owner);
    expect(after.state.recordRev).toBe(capture.state.recordRev);
    expect(after.state.syncedChangeSeq).toBe(capture.state.syncedChangeSeq);
    expect(after.state.baseRecordLocalHash).toBe(capture.state.baseRecordLocalHash);
    expect(after.payload).toEqual(capture.payload);
  });
