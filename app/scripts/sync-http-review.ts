import { LcClient } from "../src/api/client";
import { setHostLoopback } from "../src/util/padHub";
import { saveAnnotateDoc, getAnnotateDoc } from "../src/util/annotateStore";
import { applyHubAnnotate, pushAnnotatePad } from "../src/util/padSync";
import { putInkPages, getInkPage, getInkPageRecords, annotateDocKey, footnoteWhiteboardDocKey } from "../src/util/inkPageStore";
import { syncInkPages, footnoteInkHubKey, applyInkChoicesByPage, fetchHubInkPages } from "../src/util/inkSync";
import { putFootnoteWhiteboard, getFootnoteWhiteboard } from "../src/util/footnoteWhiteboardStore";
import { encodeInkOps } from "../src/canvas/inkCodec";
import type { DocFootnote } from "../src/util/docFootnotes";
import { restoreAgentMessages } from "../src/modes/agentTranscript";
import { listSessions } from "../src/modes/coachSessions";
import { withStore, STORE_INK_PAGES } from "../src/util/idb";
import { inkPageKey } from "../src/util/inkPageStore";
import { createArtifact, readArtifact, readArtifactCatalog, saveArtifact } from "../src/util/artifactRepository";
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
const pads = [{kind:"annotate" as const,key:id},{kind:"annotate" as const,key:footnoteInkHubKey(id,scratch)}];
const nativeFetch = window.fetch.bind(window);
let failedPage:number|null=null;
let failAssets=false;
let requests:string[]=[];
window.fetch = async (input,init) => {
  const url=String(input); requests.push(url);
  if(failAssets && url.endsWith("/pads/artifact-assets/lookup")) throw new Error("Simulated attachment connection loss");
  if (failedPage != null && url.endsWith(`/pads/ink/annotate/${id}/${failedPage}`)) throw new Error("Simulated connection loss");
  return nativeFetch(input,init);
};
async function exchangeInk() {
  const ping=await client.pingPadSync(0);
  return syncInkPages(client,ping.ink,pads,0,{strict:true});
}
const api = {
  async seed() {
    await putFootnoteWhiteboard(id,scratch,{board:{...board,inkPages:{v:1,pageIds:[1]}},pageCount:1});
    await saveAnnotateDoc({id,name:"Sync check.md",hash:"sync-check",docType:"markdown",source:"Selected passage\n\n".repeat(300),board,footnotes:notes,
      agent:[{id:"q",role:"user",content:"Explain",at:1,sessionId:"activity",future:{kept:true}},
        {id:"a",role:"assistant",content:"Answer",at:2,sessionId:"activity",replyTo:{id:"q",role:"user",excerpt:"Explain"}},
        {id:"q2",role:"user",content:"Separate thread",at:3,sessionId:"activity"}]});
    await putInkPages(annotateDocKey(id),Array.from({length:40},(_,i)=>[i+1,ink(i+1)] as const),{now:100});
    await putInkPages(footnoteWhiteboardDocKey(id,scratch),[[1,ink(0,"#008888")]],{now:100});
    const doc=(await getAnnotateDoc(id))!;
    await createArtifact({kind:"annotate",id},"Saved conversation",[{kind:"file"}],
      artifactProposalSnapshot({kind:"markdown",title:"Conversation.md",source:"Question and answer",messages:doc.agent},false));
    await createArtifact({kind:"annotate",id},"Owned drawing",[{kind:"footnote",footnoteId:"mark"}],{
      kind:"whiteboard",value:{board:{...board,inkPages:{v:1,pageIds:[1]}},programs:[],pageCount:1,ink:new Map([[1,ink(0,"#550055")]])}});
    return api.push();
  },
  async push() {
    const doc=(await getAnnotateDoc(id))!;
    if (!await pushAnnotatePad(client,doc)) throw new Error("Parent push failed");
    const conflicts=await exchangeInk();
    if(conflicts.length) throw new Error("Unexpected ink conflict");
    return api.inspect();
  },
  async pull() {
    const remote=await client.getAnnotatePad(id);
    if(!remote) throw new Error("Missing server document");
    await applyHubAnnotate(remote,{emitReload:false,client});
    const conflicts=await exchangeInk();
    return {conflicts,state:await api.inspect()};
  },
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
    return {footnotes:doc.footnotes,agent:doc.agent,sessions:listSessions(restoreAgentMessages(doc.agent??[])),attachments,
      pages:rows.map(row=>row.pageId).sort((a,b)=>a-b),metadataHasPayload:rows.some(row=>row.inkC||row.gz),
      page17:await getInkPage(annotateDocKey(id),17),scratch:await getFootnoteWhiteboard(id,scratch),
      scratchInk:await getInkPage(footnoteWhiteboardDocKey(id,scratch),1)};
  },
  async editPage(page:number,color:string) {await putInkPages(annotateDocKey(id),[[page,ink(page,color)]],{now:Date.now()});},
  async mergePage(page:number) {
    await applyInkChoicesByPage(client,"annotate",id,[{pageId:page,choice:"merged"}],null,
      {hubPageIds:[page],fetchHubPages:ids=>fetchHubInkPages(client,"annotate",id,ids,{strict:true})});
    return api.inspect();
  },
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
  async editConversation() {
    const catalog=(await readArtifactCatalog({kind:"annotate",id}))!;
    const item=catalog.artifacts.find(item=>item.title==="Saved conversation")!;
    const ref={parent:{kind:"annotate" as const,id},artifactId:item.id,kind:item.content.kind};
    const saved=await readArtifact(ref);
    if(saved.snapshot.kind==="whiteboard")throw new Error("Wrong saved conversation type");
    await saveArtifact(ref,item.revision,item.title,{...saved.snapshot,value:{...saved.snapshot.value,source:"Edited saved conversation"}});
    return api.push();
  },
  async traffic(reset=false) {const result=requests; if(reset) requests=[]; return result;},
  async selectedRead() {
    // An unrelated malformed record must not be decoded or retained when a
    // preview requests a specific page from the real IndexedDB store.
    await withStore(STORE_INK_PAGES,"readwrite",store=>{store.put({unrelated:true},inkPageKey(annotateDocKey(id),999));});
    const openCursor=IDBObjectStore.prototype.openCursor;
    IDBObjectStore.prototype.openCursor=()=>{throw new Error("Selected-page read scanned the whole store");};
    try {
      const rows=await getInkPageRecords(annotateDocKey(id),{pageIds:[17,17,700],strict:true});
      return rows.map(row=>row.pageId);
    } finally {IDBObjectStore.prototype.openCursor=openCursor;}
  },
};
(window as unknown as {artifactChecks:typeof api}).artifactChecks=api;
