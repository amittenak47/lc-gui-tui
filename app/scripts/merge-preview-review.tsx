import { useState } from "react";
import { createRoot } from "react-dom/client";
import { HubConflictSplit } from "../src/components/HubConflictSplit";
import { PdfDocument } from "../src/modes/PdfDocument";
import { encodeInkOps, packEncodedInk } from "../src/canvas/inkCodec";
import type { InkOp } from "../src/canvas/rasterInk";
import { gzipBytes } from "../src/util/gzip";
import { bytesToB64 } from "../src/api/nativeHttp";
import type { AnnotatePadDto, InkPageDto } from "../src/api/client";
import type { HubPadConflict } from "../src/util/hubConflictStash";
import { reviewPdf } from "./reviewPdf";
import "../src/styles.css";

const markdown = new URLSearchParams(location.search).has("markdown");
const replicas = new URLSearchParams(location.search).has("replicas");
const filterReview = new URLSearchParams(location.search).has("filter");
const bytes = reviewPdf();
const width = 1100, height = Math.round(width * 800 / 600);
const frames = Array.from({length:100}, (_, i) => ({pageId:i+1,minY:18+i*(height+18),maxY:18+i*(height+18)+height}));
const notes = [1, 25, 50, 100].map(page => ({id:`note-${page}`,kind:"note" as const,
  anchor:{kind:"region" as const,x:80,y:100,w:380,h:60,scope:markdown ? undefined : `p${page}`},
  ...(markdown ? {} : {bands:[{left:96,top:frames[page-1].minY+112,width:350,height:38}]}),
  excerpt:`Annotated page ${page}`,createdAt:page,
  whiteboards:[{id:`pad-${page}`,title:"Scratch work",createdAt:page,updatedAt:page}]}));
const source = Array.from({length:100}, (_, i) => `## Section ${i+1}\n\n${"Review long Markdown annotations. ".repeat(40)}`).join("\n\n");
const body: AnnotatePadDto = {id:"merge-review",name:"Long annotated document",hash:"merge-review",doc_type:markdown?"md":"pdf",updated_at:1,source:markdown?source:undefined,footnotes:notes,board:null,agent:[]};
const ink: InkPageDto[] = [];
for (const frame of frames) {
  const ops: InkOp[] = Array.from({length:80}, (_, i) => ({kind:"draw",color:i%2?"#e32838":"#2981e2",baseWidth:5,
    maxFullness:1,pressureClip:1,pressureSensitive:false,
    points:Array.from({length:80}, (_, j) => ({x:80+j*6,y:frame.minY+150+i*10+Math.sin(j/6)*10,pressure:-1}))}));
  ink.push({kind:"annotate",key:body.id,page_id:frame.pageId,updated_at:1,gz:bytesToB64(await gzipBytes(packEncodedInk(encodeInkOps(ops))))});
}
const conflict: HubPadConflict = {kind:"annotate",id:body.id,stage:"ink",detail:"Review fixture",
  local:body,server:{...body,updated_at:2,footnotes:notes.map(note=>({...note,excerpt:`Tablet ${note.excerpt}`}))},
  localInk:markdown?ink:ink.slice(0,1),serverInk:(markdown?ink:ink.slice(0,1)).map(row=>({...row,updated_at:2})),localInkPageIds:frames.map(f=>f.pageId),hubInkPageIds:frames.map(f=>f.pageId),
  localInkStamps:frames.map(f=>({pageId:f.pageId,updatedAt:1})),hubInkStamps:frames.map(f=>({pageId:f.pageId,updatedAt:2}))};
// Same passages annotated independently at desktop/tablet scene widths.
let serverInk = ink.map(row=>({...row,updated_at:2}));
if (replicas) {
  for (const [side, sceneWidth] of [["local",1100],["server",780]] as const) {
    const pageHeight = Math.round(sceneWidth * 800 / 600);
    const replica = {...body, updated_at:side === "local" ? 1 : 2,
      board:{elements:[{width:sceneWidth,customData:{lcMdInkFrame:true}}]},
      footnotes:notes.map(note=>({...note, excerpt:`${side} ${note.excerpt}`,
        // Deliberately different from bands: verifies the stored bands are mapped,
        // rather than silently falling back to the region anchor.
        anchor:{...note.anchor,x:sceneWidth*.6,y:pageHeight*.6,w:sceneWidth*.1,h:30},
        bands:[{left:sceneWidth*.16,top:18+(note.createdAt-1)*(pageHeight+18)+pageHeight*.2,width:sceneWidth*.3,height:pageHeight*.03}]}))};
    conflict[side] = replica;
    const rows: InkPageDto[] = [];
    for (const frame of frames) {
      const y = 18+(frame.pageId-1)*(pageHeight+18)+pageHeight*.3;
      const ops: InkOp[] = [{kind:"draw",color:"#e32838",baseWidth:4,maxFullness:1,pressureClip:1,pressureSensitive:false,
        points:[{x:sceneWidth*.2,y,pressure:-1},{x:sceneWidth*.5,y,pressure:-1}]}];
      rows.push({kind:"annotate",key:body.id,page_id:frame.pageId,updated_at:replica.updated_at,gz:bytesToB64(await gzipBytes(packEncodedInk(encodeInkOps(ops))))});
    }
    if(side==="local") {ink.splice(0,ink.length,...rows);conflict.localInk=rows.slice(0,1);}
    else {serverInk=rows;conflict.serverInk=rows.slice(0,1);}
  }
}
const fetched: number[] = [];
if (filterReview) {
  const common = {...notes[0],id:"common",excerpt:"Matching footnote"};
  (conflict.local as AnnotatePadDto).footnotes = [...notes,common,{...common,id:"local-only",excerpt:"Only on Local"}];
  (conflict.server as AnnotatePadDto).footnotes = [...(conflict.server as AnnotatePadDto).footnotes as typeof notes,common,{...common,id:"server-only",excerpt:"Only on Tablet"}];
}
Object.assign(window,{reviewFetched:fetched});
const fetchPreviewInk = async (pageId: number) => {
  fetched.push(pageId);
  await new Promise(resolve=>setTimeout(resolve,100));
  const local=ink.filter(row=>row.page_id===pageId);
  return {local,server:serverInk.filter(row=>row.page_id===pageId)};
};

function Review() {
  const [open,setOpen] = useState(false);
  Object.assign(window,{setReviewMerge:setOpen,reviewReady:true});
  return <div className="lc-app"><main style={{height:"100vh",overflow:"auto",width:1100}}>
    {!markdown && <PdfDocument bytes={bytes} docHash="merge-review" filmScope="merge-reader" frameWidth={width} idleThumbs={false} />}
    {open && <HubConflictSplit conflict={conflict} onResolve={()=>{}} otherLabel="Tablet"
      fetchPreviewInk={fetchPreviewInk}
      docHash={markdown?undefined:"merge-review"} bytes={markdown?undefined:bytes} filmScopeBase="merge-test" sceneWidth={width} pageFrames={frames} />}
  </main></div>;
}
createRoot(document.getElementById("root")!).render(<Review/>);
