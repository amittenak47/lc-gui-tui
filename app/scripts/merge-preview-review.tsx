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
const bytes = reviewPdf();
const width = 1100, height = width * 800 / 600;
const frames = Array.from({length:100}, (_, i) => ({pageId:i+1,minY:i*(height+18),maxY:i*(height+18)+height}));
const notes = [1, 25, 50, 100].map(page => ({id:`note-${page}`,kind:"note" as const,
  anchor:{kind:"region" as const,x:80,y:100,w:380,h:60,scope:markdown ? undefined : `p${page}`},
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
  localInk:ink,serverInk:ink.map(row=>({...row,updated_at:2})),localInkPageIds:frames.map(f=>f.pageId),hubInkPageIds:frames.map(f=>f.pageId),
  localInkStamps:frames.map(f=>({pageId:f.pageId,updatedAt:1})),hubInkStamps:frames.map(f=>({pageId:f.pageId,updatedAt:2}))};

function Review() {
  const [open,setOpen] = useState(false);
  Object.assign(window,{setReviewMerge:setOpen,reviewReady:true});
  return <div className="lc-app"><main style={{height:"100vh",overflow:"auto",width:1100}}>
    {!markdown && <PdfDocument bytes={bytes} docHash="merge-review" filmScope="merge-reader" frameWidth={width} idleThumbs={false} />}
    {open && <HubConflictSplit conflict={conflict} onResolve={()=>{}} otherLabel="Tablet"
      docHash={markdown?undefined:"merge-review"} bytes={markdown?undefined:bytes} filmScopeBase="merge-test" sceneWidth={width} pageFrames={frames} />}
  </main></div>;
}
createRoot(document.getElementById("root")!).render(<Review/>);
