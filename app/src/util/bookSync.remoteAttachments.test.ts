import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { LcClient, BookStateDto, CommitRequestDto, CommitResultDto } from "../api/client";
import { syncBook } from "./bookSync";
import { captureBook } from "./bookSnapshot";
import { saveWhiteboardNotebook } from "./whiteboardStore";
import { closeDbForTests } from "./idb";
import { resetBookCoordinatorForTests } from "./bookCoordinator";
import { resetLocalBookStoreForTests } from "./localBookStore";
import { encodeInkOps, packEncodedInk } from "../canvas/inkCodec";
import { recordHash } from "./syncContent";
import { bytesToB64 } from "../api/nativeHttp";
import { artifactAssetKey, type ArtifactAsset } from "./artifactAssets";
import { getArtifactAsset } from "./artifactAssetStore";
import type { ArtifactCatalog } from "./padArtifacts";
const board = {v:1 as const,elements:[],appState:{scrollX:0,scrollY:0,zoom:1}};
const parent = {kind:"whiteboard" as const,id:"attachment-book"};
const scene: ArtifactAsset = {parent,dependency:{kind:"scene",id:"drawing",revision:"new-scene"},
  payload:JSON.stringify({v:1,board:{...board,inkPages:{v:1,pageIds:[1]}},pageCount:1,programs:[]})};
const ink: ArtifactAsset = {parent,dependency:{kind:"ink",id:"drawing",revision:"new-scene",pageId:1},
  payload:JSON.stringify({v:1,packed:bytesToB64(packEncodedInk(encodeInkOps([{kind:"draw",color:"#123456",baseWidth:2,maxFullness:1,pressureClip:1,pressureSensitive:false,points:[{x:10,y:20,pressure:0.5},{x:30,y:40,pressure:0.5}]}])))})};
const catalog: ArtifactCatalog = {v:1,parent,revision:"catalog-rev",artifacts:[{id:"attachment",title:"Remote drawing",revision:"item-rev",createdAt:1,updatedAt:2,associations:[{kind:"file"}],content:{kind:"whiteboard",boardId:"drawing",sceneRevision:"new-scene",ink:[{pageId:1,revision:"new-scene"}]}}]};
beforeEach(async()=>{await closeDbForTests();resetBookCoordinatorForTests();resetLocalBookStoreForTests();
  vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("IDBKeyRange",IDBKeyRange);
  const values=new Map<string,string>();vi.stubGlobal("localStorage",{get length(){return values.size},key:(i:number)=>[...values.keys()][i]??null,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});
  vi.stubGlobal("navigator",{locks:{request:(_key:string,options:unknown,fn?:()=>Promise<unknown>)=>typeof options==="function"?options():fn!()}});
});
afterEach(async()=>{await closeDbForTests();vi.unstubAllGlobals();});
it.each([false,true])("acquires remote attachment dependencies before inline conversion writes (missing=%s)",async missing=>{
  let head:BookStateDto={...parent,state:"absent",book_rev:0,record_rev:0,record_hash:null,record:null,pages:[],gone_seq:null};
  const assets=new Map([scene,ink].map(a=>[artifactAssetKey(a),a]));
  const api={getBookState:vi.fn(async()=>structuredClone(head)),checkBookHead:vi.fn(async()=>({unchanged:true,book_rev:head.book_rev})),
    getArtifactAsset:vi.fn(async(locator:ArtifactAsset)=>missing?null:assets.get(artifactAssetKey(locator))??null),putArtifactAsset:vi.fn(async(a:ArtifactAsset)=>a),
    commitPad:vi.fn(async(body:CommitRequestDto)=>{const record=body.record?.value??head.record;head={...head,state:"live",record,record_hash:record?await recordHash(record):null,record_rev:head.record_rev+1,book_rev:head.book_rev+1};return {status:"committed",upload_id:body.upload_id,record_rev:head.record_rev,page_revs:[],book:structuredClone(head)} as CommitResultDto;})} as unknown as LcClient;
  const save=(inline=false)=>saveWhiteboardNotebook({id:parent.id,title:"Fixture",pageCount:1,board:{...board,...(inline?{inkC:encodeInkOps([])}:{})}});
  await save();const options={timeoutMs:1000,wait:async()=>{}};
  expect((await syncBook(api,parent.kind,parent.id,undefined,options)).status).toBe("synced");
  head={...head,record:{...head.record!,artifacts:catalog},record_rev:head.record_rev+1,book_rev:head.book_rev+1};head.record_hash=await recordHash(head.record);
  await save(true);const before=await captureBook(parent);vi.mocked(api.commitPad).mockClear();
  const result=await syncBook(api,parent.kind,parent.id,undefined,options);
  if(missing){expect(result.error?.kind).toBe("dependency");expect(api.commitPad).not.toHaveBeenCalled();expect(await captureBook(parent)).toEqual(before);return;}
  expect(result.status).toBe("synced");expect(api.getArtifactAsset).toHaveBeenCalledTimes(2);
  expect((await captureBook(parent)).record?.artifacts).toEqual(catalog);
  expect(await getArtifactAsset(scene)).toEqual(scene);expect(await getArtifactAsset(ink)).toEqual(ink);
  expect(api.putArtifactAsset).not.toHaveBeenCalled();
});
