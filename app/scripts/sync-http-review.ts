import { putProblemBoard, getProblemBoard } from "../src/util/problemBoardStore";
import { LcClient } from "../src/api/client";
import { setHostLoopback } from "../src/util/padHub";
import { saveAnnotateDoc, getAnnotateDoc, trashAnnotateDoc, restoreAnnotateFromTrash } from "../src/util/annotateStore";
import { syncBook } from "../src/util/bookSync";
import { syncBookPass } from "../src/util/bookSyncPass";
import { captureBook } from "../src/util/bookSnapshot";
import { listRecoveryCopies } from "../src/util/syncRecovery";
import { getBookSyncState } from "../src/util/syncState";
import { LOCAL_VIEW_KEYS, recordHash } from "../src/util/syncContent";
import { hydrateBookMetadata } from "../src/util/localBookStore";
import { putInkPages, getInkPage, getInkPageRecords, annotateDocKey, footnoteWhiteboardDocKey } from "../src/util/inkPageStore";

import { putFootnoteWhiteboard, getFootnoteWhiteboard, deleteFootnoteWhiteboard } from "../src/util/footnoteWhiteboardStore";
import { encodeInkOps } from "../src/canvas/inkCodec";
import type { DocFootnote } from "../src/util/docFootnotes";
import { restoreAgentMessages } from "../src/modes/agentTranscript";
import { listSessions } from "../src/modes/coachSessions";
import { withStore, STORE_INK_PAGES } from "../src/util/idb";
import { inkPageKey } from "../src/util/inkPageStore";
import { createArtifact, readArtifact, readArtifactCatalog, saveArtifact, mutateArtifacts } from "../src/util/artifactRepository";
import { artifactProposalSnapshot } from "../src/util/agentArtifacts";

setHostLoopback({url:"http://127.0.0.1:1458",token:"sync-review"});
const client = new LcClient();
const id = "http-sync-document", scratch = "scratch";
const board = {v:1 as const,elements:[],appState:{scrollX:0,scrollY:0,zoom:1},inkPages:{v:1 as const,pageIds:Array.from({length:40},(_,i)=>i+1)}};
const notes: DocFootnote[] = [{id:"mark",kind:"coach",anchor:{kind:"text",start:0,end:8,scope:"p1"},excerpt:"Selected",createdAt:1,
  threads:[{rootId:"q",title:"Thread",createdAt:1}],threadRootId:"q",
  whiteboards:[{id:scratch,title:"Sketch",createdAt:1,updatedAt:1}],
  bands:[{left:90,top:112,width:350,height:38}]}];
const ink = (page:number,color="#111111") => encodeInkOps(Array.from({length:12},(_,s)=>({kind:"draw" as const,color,baseWidth:2,maxFullness:0.8,
  pressureClip:0.6,pressureSensitive:true,points:Array.from({length:80},(_,p)=>({x:50+s*9+p,y:page*1300+20+p,pressure:0.5}))})));

const nativeFetch = window.fetch.bind(window);
let failedPage:number|null=null;
let corruptPage:number|null=null;
let failAssets=false;
let requests:string[]=[];
let commitBodies:string[]=[];
let loseReceipt=false;
// Clock-skew checks: this "device" stamps edits with its own (skewed) clock,
// and can sync the way the app does, with the hub's last ping time as since.
let skewMs=0;

// Network faults on one ink page's upload: a hub error, a reply lost after
// the hub saved the page, or a request that never answers.
type Fault={kind:"error500"|"lostAck"|"hang";page:number};
let fault:Fault|null=null;
const hung:Array<()=>void>=[];
let pending:Promise<string>|null=null;
let cancelSync:AbortController|null=null;
function inkPageOf(url:string,init?:RequestInit):number|null {
  const get=url.match(new RegExp(`/pads/(?:ink|stage/[^/]+)/annotate/${id}/(\\d+)(?:\\?|$)`));
  if(get) return Number(get[1]);
  if(url.endsWith("/pads/ink")&&typeof init?.body==="string") {
    try {const body=JSON.parse(init.body); if(body.key===id) return Number(body.page_id);} catch { /* not ink */ }
  }
  return null;
}
let heldBarrier: { point: string; entered: boolean; promise: Promise<void>; release():void } | null = null;
async function barrier(point: string) {const held=heldBarrier;if(held?.point===point) {held.entered=true;await held.promise;}}
window.fetch = async (input,init) => {
  const url=String(input); requests.push(url);
  if(url.endsWith("/pads/commit")&&init?.method==="POST")await barrier("commit");
  if(url.includes("/pads/ink/")&&(init?.method??"GET")==="GET")await barrier("read");
  if (url.endsWith("/pads/commit") && typeof init?.body === "string") commitBodies.push(init.body);
  if (loseReceipt && url.includes("/pads/commits/")) return new Response("Simulated lost receipt", { status: 500 });
  if(failAssets && url.endsWith("/pads/artifact-assets/lookup")) throw new Error("Simulated attachment connection loss");
  if (failedPage != null && new URL(url).pathname.endsWith(`/pads/ink/annotate/${id}/${failedPage}`)) throw new Error("Simulated connection loss");
  if (corruptPage != null && new URL(url).pathname.endsWith(`/pads/ink/annotate/${id}/${corruptPage}`)) {
    const response=await nativeFetch(input,init);
    return new Response(JSON.stringify({...await response.json(),gz:"YQ=="}),{headers:{"Content-Type":"application/json"}});
  }
  if(fault?.kind === "lostAck" && url.endsWith("/pads/commit") && init?.method === "POST") { await nativeFetch(input,init); throw new Error("Simulated reply lost after atomic commit"); }
  if(fault && fault.kind !== "lostAck" && (init?.method??"GET")==="PUT"&&inkPageOf(url,init)===fault.page) {
    if(fault.kind==="error500") return new Response("Simulated hub error",{status:500});
    await new Promise<void>(resolve=>hung.push(resolve));
  }
  return nativeFetch(input,init);
};
const syncOptions = { timeoutMs: 1500, wait: async () => {} };
async function current(choice?: "local" | "server" | "merged" | "none", timeoutMs = 1500) {
  let choices=0;
  return syncBook(client, "annotate", id, undefined, { ...syncOptions, timeoutMs, manual: !!choice, beforePublish: async () => barrier("publish"),
    requestChoice: choice ? async (conflict, lifecycle) => { lifecycle.onMounted(); if(++choices>4)throw new Error(`Repeated choice ${JSON.stringify({record:conflict.record, pages:conflict.pages,local:conflict.capture.record?.footnotes,remote:conflict.remote.record?.footnotes})}`); return {
      ...(conflict.record ? { record: choice === "none" ? "local" : choice } : {}),
      ...(conflict.lifecycle ? { lifecycle: "local" } : {}),
      pages: conflict.pages.map(page => ({ key: page.key, pageId: page.page_id, choice })),
    }; } : undefined });
}
const api = {
  async discover() { const result=await syncBookPass(client,{...syncOptions,libraryPull:true});
    const failure=result.books.find(book=>book.status==="failed"||book.status==="needs_choice"); if(failure)throw failure.error; return api.inspect(); },
  async hasDocument() { return Boolean(await getAnnotateDoc(id)); },
  async problemSeed() {
    await putProblemBoard({id:"review/task",dataset:"review",taskId:"task",updatedAt:Date.now(),board:{v:1,elements:[],appState:board.appState,inkC:ink(0)}});
    const result=await syncBook(client,"problem","review/task",undefined,syncOptions);if(result.status!=="synced")throw result.error;
    return client.getBookState("problem","review/task");
  },
  async problemPull() {
    const result=await syncBook(client,"problem","review/task",undefined,{...syncOptions,allowCreate:true});if(result.status!=="synced")throw result.error;
    return getProblemBoard("review/task");
  },
  async seed() {
    await putFootnoteWhiteboard(id,scratch,{board:{...board,inkPages:{v:1,pageIds:[1]}},pageCount:1});
    await saveAnnotateDoc({id,name:"Sync check.md",hash:"sync-check",docType:"markdown",source:"Selected passage\n\n".repeat(300),board,footnotes:notes,
      agent:[{id:"q",role:"user",content:"Explain",at:1,sessionId:"activity",future:{kept:true}},
        {id:"a",role:"assistant",content:"Answer",at:2,sessionId:"activity",replyTo:{id:"q",role:"user",excerpt:"Explain"}},
        {id:"q2",role:"user",content:"Separate thread",at:3,sessionId:"activity"}]});
    await putInkPages(annotateDocKey(id),Array.from({length:40},(_,i)=>[i+1,ink(i+1)] as const),{now:100});
    await putInkPages(annotateDocKey(id),[[113,encodeInkOps([])]],{now:100});
    await putInkPages(footnoteWhiteboardDocKey(id,scratch),[[1,ink(0,"#008888")]],{now:100});
    const doc=(await getAnnotateDoc(id))!;
    await createArtifact({kind:"annotate",id},"Saved conversation",[{kind:"file"}],
      artifactProposalSnapshot({kind:"markdown",title:"Conversation.md",source:"Question and answer",messages:doc.agent},false));
    await createArtifact({kind:"annotate",id},"Owned drawing",[{kind:"footnote",footnoteId:"mark"}],{
      kind:"whiteboard",value:{board:{...board,inkPages:{v:1,pageIds:[1]}},programs:[],pageCount:1,ink:new Map([[1,ink(0,"#550055")]])}});
    await createArtifact({kind:"annotate",id},"Owned code.py",[{kind:"thread",rootId:"q"}],
      artifactProposalSnapshot({kind:"code",title:"Owned code.py",source:"def catalog_check():\n    return 'complete code payload'\n"},false));
    return api.push();
  },
  async push() { const result=await current(); if(result.status==="failed"||result.status==="needs_choice") {
    const paths:string[]=[]; const scan=(value:unknown,path:string)=>{if(value===undefined)paths.push(path);else if(value&&typeof value==="object")for(const [key,child] of Object.entries(value))scan(child,`${path}.${key}`);};
    scan((await captureBook({kind:"annotate",id})).record,"record");throw new Error(`${result.error?.message} paths:${paths.join(",")} cause:${JSON.stringify(result.error?.cause)} pages:${JSON.stringify(result.error?.pages)}`);
    } return api.inspect(); },
  async pull() { const result=await current(); if(result.status==="failed")throw result.error;
    return {conflicts:result.status==="needs_choice"?[result.error]:[],result,state:await api.inspect()}; },
  async modern(choice?: "local" | "server" | "merged" | "none", timeoutMs=1500) {
    const result=await current(choice,timeoutMs); return {...result,error:result.error?{kind:result.error.kind,pages:result.error.pages,message:result.error.message,cause:String(result.error.cause)}:null}; },
  async barrier(point: string) {let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});heldBarrier={point,entered:false,promise,release};},
  async barrierState() {return heldBarrier?.entered??false;},
  async releaseBarrier() {const held=heldBarrier;heldBarrier=null;held?.release();},
  async head() {return client.getBookState("annotate",id);},
  async tracking() {return getBookSyncState("annotate",id);},
  async retained() {return (await listRecoveryCopies("annotate",id)).map(copy=>({id:copy.id,type:copy.type,provenance:copy.provenance,pages:copy.record?.ink?.map(row=>row.pageId)}));},
  async capture() {const value=await captureBook({kind:"annotate",id}); return {record:value.record,hash:value.record?await recordHash(value.record):null,pages:value.pages.map(row=>({key:row.docKey,pageId:row.pageId,changeSeq:row.changeSeq,syncedRev:row.syncedRev,baseWireHash:row.baseWireHash})),state:value.state};},
  async inspect() {
    const doc=(await getAnnotateDoc(id))!;
    const rows=await getInkPageRecords(annotateDocKey(id),{metadataOnly:true,strict:true});
    const catalog=await readArtifactCatalog({kind:"annotate",id});
    const attachments=[];
    for(const item of catalog?.artifacts??[]) {
      if(item.deletedAt)continue;
      const saved=await readArtifact({parent:{kind:"annotate",id},artifactId:item.id,kind:item.content.kind});
      attachments.push({title:item.title,kind:saved.snapshot.kind,...saved.snapshot.value,ink:[...saved.snapshot.value.ink]});
    }
    const scratchBoard = await getFootnoteWhiteboard(id,scratch);
    if (scratchBoard) for (const field of LOCAL_VIEW_KEYS) delete (scratchBoard.board.appState as Record<string,unknown>)[field];
    return {footnotes:doc.footnotes,agent:doc.agent,sessions:listSessions(restoreAgentMessages(doc.agent??[])),attachments,
      pages:rows.map(row=>row.pageId).sort((a,b)=>a-b),metadataHasPayload:rows.some(row=>row.inkC||row.gz),
      page17:await getInkPage(annotateDocKey(id),17),scratch:scratchBoard,
      scratchInk:await getInkPage(footnoteWhiteboardDocKey(id,scratch),1)};
  },
  async cancellable() {cancelSync=new AbortController();return syncBook(client,"annotate",id,undefined,{...syncOptions,signal:cancelSync.signal});},
  async cancel() {cancelSync?.abort();},
  async removeScratch() {
    const doc=(await getAnnotateDoc(id))!;
    await saveAnnotateDoc({...doc,footnotes:doc.footnotes.map(note=>({...note,whiteboards:note.whiteboards?.filter(ref=>ref.id!==scratch)}))});
    await deleteFootnoteWhiteboard(id,scratch);
  },
  async referenceScratch() {
    const doc=(await getAnnotateDoc(id))!;
    await putFootnoteWhiteboard(id,scratch,{board:{...board,inkPages:{v:1,pageIds:[1]}},pageCount:1});
    await saveAnnotateDoc({...doc,footnotes:[...doc.footnotes,{...notes[0]!,id:"scratch-race",threads:[],threadRootId:undefined}]});
    return current();
  },
  async scratchPage(page:number,color:string) {await putInkPages(footnoteWhiteboardDocKey(id,scratch),[[page,ink(page,color)]]);},
  async scratchState(page:number) {
    const doc=(await getAnnotateDoc(id))!;
    return {referenced:doc.footnotes.some(note=>note.whiteboards?.some(ref=>ref.id===scratch)),ink:await getInkPage(footnoteWhiteboardDocKey(id,scratch),page)};
  },
  async editPage(page:number,color:string) {await putInkPages(annotateDocKey(id),[[page,ink(page,color)]],{now:Date.now()+skewMs});},
  async trash() {await trashAnnotateDoc(id);return current();},
  async restore() {await restoreAnnotateFromTrash(id);return current("local");},
  async setClock(skew:number,_hubSinceMode:boolean) {skewMs=skew;},
  async setFault(kind:Fault["kind"]|null,page=0) {fault=kind?{kind,page}:null;},
  async loseReceipt(value: boolean) {loseReceipt=value;},
  /** Push, but report back after `ms` even if the walk is still waiting. */
  async pushWithin(ms:number) {
    pending=api.push().then(()=>"done",(error)=>`error: ${error instanceof Error?error.message:String(error)}`);
    return Promise.race([pending,new Promise<string>(resolve=>setTimeout(()=>resolve("still waiting"),ms))]);
  },
  async releaseHung() {fault=null;const count=hung.length;hung.splice(0).forEach(resolve=>resolve());return {count,result:await pending};},
  async pageState(page:number) {
    const row=(await getInkPageRecords(annotateDocKey(id),{metadataOnly:true,strict:true})).find(r=>r.pageId===page);
    return row?{dirty:Boolean(row.dirty),synced:row.changeSeq===row.syncedChangeSeq,rev:row.syncedRev,wireHash:row.baseWireHash,localHash:row.baseLocalHash}:null;
  },
  async pageColor(page:number) {
    const row=await getInkPage(annotateDocKey(id),page);
    // Encoded ops keep their colour under `c`.
    return row?.ops?.[0]?.c??null;
  },
  async mergePage(_page:number) { const result=await current("merged"); if(result.status==="failed"||result.status==="needs_choice")throw result.error; return api.inspect(); },
  async keepServer(_page:number) { const result=await current("server"); if(result.status==="failed"||result.status==="needs_choice")throw result.error; return api.inspect(); },
  async corruptPage(page:number|null) {corruptPage=page;},
  async deleteThread() {
    const doc=(await getAnnotateDoc(id))!;
    await saveAnnotateDoc({...doc,agent:(doc.agent as Array<Record<string,unknown>>).map(message=>["q","a"].includes(String(message.id))?{...message,deletedAt:Date.now()}:message)});
    return api.push();
  },
  async staleThreadWrite() {
    const remote=(await client.getAnnotatePad(id))!;
    const agent=(remote.agent as Array<Record<string,unknown>>).map(({deletedAt: _deleted, ...message})=>message);
    await client.putAnnotatePad(id,{...remote,updated_at:remote.updated_at+1,base_updated_at:remote.updated_at,footnotes:notes,agent});
    return api.pull();
  },
  async failPage(page:number|null) {failedPage=page;},
  async failAttachments(value:boolean) {failAssets=value;},
  async editConversationLocal(source:string) {
    const catalog=(await readArtifactCatalog({kind:"annotate",id}))!;
    const item=catalog.artifacts.find(item=>item.title==="Saved conversation")!;
    const ref={parent:{kind:"annotate" as const,id},artifactId:item.id,kind:item.content.kind};
    const saved=await readArtifact(ref);
    if(saved.snapshot.kind==="whiteboard")throw new Error("Wrong saved conversation type");
    await saveArtifact(ref,item.revision,item.title,{...saved.snapshot,value:{...saved.snapshot.value,source}});
  },
  async editCatalogAttachment(kind: "code" | "whiteboard", authored: string) {
    const parent = {kind:"annotate" as const,id};
    const catalog=(await readArtifactCatalog(parent))!;
    const item=catalog.artifacts.find(item=>item.title===(kind==="code"?"Owned code.py":"Owned drawing"))!;
    const ref={parent,artifactId:item.id,kind:item.content.kind};
    const saved=await readArtifact(ref);
    if(saved.snapshot.kind==="whiteboard") {
      await saveArtifact(ref,item.revision,item.title,{kind:"whiteboard",value:{...saved.snapshot.value,ink:new Map([[1,ink(0,authored)]])}});
    } else {
      await saveArtifact(ref,item.revision,item.title,{...saved.snapshot,value:{...saved.snapshot.value,source:authored}});
    }
  },
  async catalog() {return readArtifactCatalog({kind:"annotate",id});},
  async catalogLifecycle(type: "delete" | "restore") {
    const parent={kind:"annotate" as const,id};
    let catalog=(await readArtifactCatalog(parent))!;
    const ids=catalog.artifacts.filter(item=>type==="delete"?item.deletedAt===undefined:item.deletedAt!==undefined).map(item=>item.id);
    for(const artifactId of ids) {
      const item=catalog.artifacts.find(item=>item.id===artifactId)!;
      catalog=await mutateArtifacts(parent,catalog.revision,{type,id:item.id,expectedRevision:item.revision});
    }
    return api.push();
  },
  async editConversation() {
    await api.editConversationLocal("Edited saved conversation");return api.push();
  },
  async traffic(reset=false) {const result=requests; if(reset) {requests=[];commitBodies=[];} return result;},
  async commitRequests() {return commitBodies;},
  async selectedRead() {
    // An unrelated malformed record must not be decoded or retained when a
    // preview requests a specific page from the real IndexedDB store.
    await withStore(STORE_INK_PAGES,"readwrite",store=>{store.put({unrelated:true},inkPageKey(annotateDocKey(id),999));});
    const openCursor=IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openCursor=()=>{throw new Error("Selected-page read scanned the whole store");};
    try {
      const rows=await getInkPageRecords(annotateDocKey(id),{pageIds:[17,17,700],strict:true});
      return rows.map(row=>row.pageId);
    } finally {IDBObjectStore.prototype.openCursor=openCursor; await withStore(STORE_INK_PAGES,"readwrite",store=>{store.delete(inkPageKey(annotateDocKey(id),999));});}
  },
};
void hydrateBookMetadata().then(() => { (window as unknown as {artifactChecks:typeof api}).artifactChecks=api; });
