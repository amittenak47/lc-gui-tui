import { conversationMarkdown, conversationMessages } from "../modes/coachThreads";
import { getFootnoteWhiteboard } from "./footnoteWhiteboardStore";
import { footnoteWhiteboardDocKey, getInkPageRecords, encodedFromRecord } from "./inkPageStore";
import { decodeInkOps, inkOpsFrom } from "../canvas/inkCodec";
import { inkOpsBounds } from "../canvas/rasterInk";
import { rasterAnnotation, sceneBounds, type ExportMark, type ExportSnapshot } from "./documentExportSnapshot";
import { readArtifact } from "./artifactRepository";
import type { BoardBlob } from "../canvas/BoardHandle";
import type { InkOp } from "../canvas/rasterInk";
import type { AgentChatMessage } from "../modes/AgentSidePanel";

export function noteText(mark:ExportMark,snapshot:Pick<ExportSnapshot,"messages">,threads:boolean):string {
  const n=mark.note;
  const parts=[`${mark.number}. ${n.title || "Footnote"}`,n.anchor.scope ? `Location: ${n.anchor.scope}`:"",
    n.blockText || n.excerpt,...(n.notes??[]).map(note=>note.text),n.query ?? "",n.url ?? "",
    ...(n.userLinks??[]).map(link=>`${link.title ? link.title+": ":""}${link.url}`)];
  if(threads) {
    const ids=new Set([n.threadRootId,...(n.threads??[]).map(t=>t.rootId)].filter((id):id is string=>Boolean(id)));
    for(const id of ids) {
      const messages=conversationMessages(snapshot.messages,id).filter(m=>!m.deletedAt);
      if(messages.length)parts.push(conversationMarkdown(messages));
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Read scratch-board ink strictly: a missing referenced sketch fails export. */
export async function noteAttachments(docId:string,mark:ExportMark,signal:AbortSignal,threads=false,seen=new Set<string>()) {
  const images:Array<{name:string;bytes:Uint8Array<ArrayBuffer>}>=[];
  const text:string[]=[];
  const draw=async(name:string,board:BoardBlob,ops:InkOp[])=>{
    // Owned text attachments have no mounted scrollers during export.
    ops=ops.map(op=>op.hostKey===undefined ? op : {...op,hostKey:undefined,points:op.points.map(p=>({...p,x:p.x+(op.scrollLeftAtDraw??0),y:p.y+(op.scrollTopAtDraw??0)}))});
    const inkBounds=inkOpsBounds(ops),elements=sceneBounds(board.elements);
    const bounds=inkBounds ?? elements;
    if(!bounds)return;
    if(inkBounds && elements) { bounds.minX=Math.min(bounds.minX,elements.minX);bounds.minY=Math.min(bounds.minY,elements.minY);bounds.maxX=Math.max(bounds.maxX,elements.maxX);bounds.maxY=Math.max(bounds.maxY,elements.maxY); }
    for(let y=bounds.minY-8;y<bounds.maxY+8;y+=1200) {
      signal.throwIfAborted();
      images.push({name,bytes:await rasterAnnotation({...bounds,minX:bounds.minX-8,maxX:bounds.maxX+8,minY:y,maxY:Math.min(bounds.maxY+8,y+1200)},ops,board)});
    }
  };
  if(mark.note.png) {
    const data=mark.note.png.startsWith("data:") ? mark.note.png : `data:image/png;base64,${mark.note.png}`;
    if(!data.startsWith("data:image/png;base64,"))throw new Error("A footnote capture could not be exported");
    images.push({name:"Selected region",bytes:new Uint8Array(await (await fetch(data)).arrayBuffer())});
  }
  for(const ref of mark.note.whiteboards??[]) {
    signal.throwIfAborted();
    const content=await getFootnoteWhiteboard(docId,ref.id);
    if(!content)throw new Error(`Footnote sketch “${ref.title || ref.id}” is unavailable`);
    const rows=await getInkPageRecords(footnoteWhiteboardDocKey(docId,ref.id),{strict:true});
    const ops=rows.length ? [] : inkOpsFrom(content.board);
    for(const row of rows) { const ink=await encodedFromRecord(row);if(!ink)throw new Error("Footnote handwriting could not be read");ops.push(...decodeInkOps(ink)); }
    if(content.board.inkPages?.pageIds.some(id=>!rows.some(row=>row.pageId===id)))throw new Error("Footnote handwriting is incomplete. Sync or restore the sketch before exporting.");
    await draw(ref.title||"Footnote sketch",content.board,ops);
  }
  for(const ref of mark.note.artifacts??[]) {
    signal.throwIfAborted();
    const key=`${ref.parent.kind}:${ref.parent.id}:${ref.artifactId}`;
    if(seen.has(key))continue;
    if(seen.size>=100)throw new Error("Too many nested attachments to export at once");
    seen.add(key);
    const {item,snapshot}=await readArtifact(ref);
    const value=snapshot.value;
    const ops:InkOp[]=value.ink.size ? []:inkOpsFrom(value.board);
    for(const encoded of value.ink.values())ops.push(...decodeInkOps(encoded));
    await draw(item.title || "Attached sketch",value.board,ops);
    if(snapshot.kind!=="whiteboard") {
      text.push(`${item.title}\n\n${snapshot.value.source}`);
      for(const [index,note] of snapshot.value.footnotes.entries()) {
        const nested={note,number:index+1,scope:note.anchor.scope??"",rects:[]};
        text.push(noteText(nested,{messages:snapshot.value.agent as AgentChatMessage[]},threads));
        const attachments=await noteAttachments(ref.parent.id,nested,signal,threads,seen);
        images.push(...attachments.images);text.push(...attachments.text);
      }
    }
  }
  return {images,text};
}
