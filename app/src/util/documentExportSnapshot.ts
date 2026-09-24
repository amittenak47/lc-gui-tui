import type { BoardBlob, BoardHandle } from "../canvas/BoardHandle";
import { decodeInkOps, inkOpsFrom } from "../canvas/inkCodec";
import { paintInkAtScale, type InkOp, type SceneBounds } from "../canvas/rasterInk";
import { paintSceneToExport, isDrawableSceneElement, type PaintSceneElement } from "../canvas/paintScene";
import { scrollHostLookupFromSlot } from "../canvas/scrollHost";
import { annotateDocKey, encodedFromRecord, getInkPageRecords } from "./inkPageStore";
import { rangeFromAnchor, textOf } from "./docAnchors";
import type { DocFootnote } from "./docFootnotes";
import type { DocType } from "./annotateStore";
import type { AgentChatMessage } from "../modes/AgentSidePanel";

export interface ExportSource { name: string; text: string; hash: string; docType: DocType; bytes?: ArrayBuffer | null }
export interface ExportScope { id: string; bounds: SceneBounds; page?: number; right?: boolean; spread?: boolean; blocks: {text: string; y: number}[] }
export interface ExportMark { note: DocFootnote; number: number; scope: string; rects: SceneBounds[] }
export interface ExportSnapshot {
  source: ExportSource; board: BoardBlob; scopes: ExportScope[]; marks: ExportMark[];
  messages: AgentChatMessage[]; pageIds: number[];
  readInk(pageId: number): Promise<InkOp[]>;
  hosts: ReturnType<typeof scrollHostLookupFromSlot>; zoom: number;
}

/** Capture current layout and dirty ink without changing the reader's scroll position. */
export async function snapshotDocumentExport(board: BoardHandle, source: ExportSource, docId: string,
  notes: readonly DocFootnote[], messages: readonly AgentChatMessage[]): Promise<ExportSnapshot> {
  if(board.isInking())throw new Error("Finish the current pen stroke before exporting.");
  const root = board.getDocumentExportRoot();
  const origin = board.sceneToClient(0, 0), unit = board.sceneToClient(1, 1);
  if (!root || !origin || !unit) throw new Error("Wait for the document to finish opening, then export again.");
  const zoom = unit.x - origin.x;
  if (!(zoom > 0)) throw new Error("The document layout is not ready to export.");
  const bounds = (r: {left:number;top:number;right:number;bottom:number}): SceneBounds => ({
    minX:(r.left-origin.x)/zoom, minY:(r.top-origin.y)/zoom,
    maxX:(r.right-origin.x)/zoom, maxY:(r.bottom-origin.y)/zoom,
  });
  const bodyBounds=bounds((root.querySelector<HTMLElement>(".lc-doc-selectable-body")??root).getBoundingClientRect());
  let nodes = [...root.querySelectorAll<HTMLElement>("[data-doc-scope]")];
  if (!nodes.length) nodes = [root.querySelector<HTMLElement>(".lc-md-ink-doc,.lc-code-doc,.lc-web-doc") ?? root];
  const scopes = nodes.map(node => ({
    id:node.dataset.docScope ?? "", bounds:bounds(node.getBoundingClientRect()),
    page:node.dataset.pdfPage ? Number(node.dataset.pdfPage) : undefined,
    right:node.dataset.pdfHalf === "right", spread:node.dataset.pdfHalf === "left" || node.dataset.pdfHalf === "right",
    blocks:[...node.querySelectorAll<HTMLElement>("p,li,pre,h1,h2,h3,blockquote")]
      .map(el => ({text:textOf(el).trim(),y:bounds(el.getBoundingClientRect()).minY})).filter(row=>row.text),
  }));
  if (scopes.some(scope=>scope.bounds.maxX<=scope.bounds.minX || scope.bounds.maxY<=scope.bounds.minY)) {
    throw new Error("Wait for the document layout to finish before exporting.");
  }
  const marks = notes.map((note,index) => {
    const i=nodes.findIndex(node => (node.dataset.docScope ?? "") === (note.anchor.scope ?? ""));
    const node=nodes[i], scope=scopes[i];
    let rects:SceneBounds[]=[];
    if (node && scope) {
      if (note.anchor.kind === "region") {
        const saved=Boolean(note.bands?.length);
        const bands=saved ? note.bands! : [{left:note.anchor.x,top:note.anchor.y,width:note.anchor.w,height:note.anchor.h}];
        const origin=saved ? bodyBounds:scope.bounds;
        rects=bands.map(r=>({minX:origin.minX+r.left,minY:origin.minY+r.top,maxX:origin.minX+r.left+r.width,maxY:origin.minY+r.top+r.height}));
      } else {
        const range=rangeFromAnchor(node,note.anchor);
        rects=range ? [...range.getClientRects()].filter(r=>r.width>0 && r.height>0).map(bounds) : [];
        // PDF text layers are virtualized. Stored bands retain the mark on pages
        // the reader hasn't visited, without forcing every page to render.
        if(!rects.length && source.docType==="pdf" && note.bands?.length) {
          rects=note.bands.map(r=>({minX:bodyBounds.minX+r.left,minY:bodyBounds.minY+r.top,maxX:bodyBounds.minX+r.left+r.width,maxY:bodyBounds.minY+r.top+r.height}));
        }
      }
    }
    return {note:structuredClone(note),number:index+1,scope:note.anchor.scope ?? "",rects};
  });
  const scene=board.saveBoard({assembleInk:false});
  const live=board.snapshotInkPages();
  const revision=board.getInkRevision();
  const records=await getInkPageRecords(annotateDocKey(docId),{metadataOnly:true,strict:true});
  if (board.getInkRevision()!==revision) throw new Error("The handwriting changed while preparing export. Try again.");
  const clocks=new Map(records.map(row=>[row.pageId,row.updatedAt]));
  const pageIds=[...new Set([...clocks.keys(),...live.keys(),...(scene.inkPages?.pageIds ?? [])])];
  const fallback=pageIds.length ? [] : inkOpsFrom(scene);
  if (fallback.length) pageIds.push(1);
  return {source,board:structuredClone(scene),scopes,marks,messages:structuredClone([...messages]),pageIds,
    hosts:scrollHostLookupFromSlot(root,bounds(root.getBoundingClientRect())),zoom,
    async readInk(pageId) {
      if (live.has(pageId)) return decodeInkOps(live.get(pageId)!);
      if (fallback.length) return fallback;
      const [row]=await getInkPageRecords(annotateDocKey(docId),{pageIds:[pageId],strict:true});
      if (!row || row.updatedAt!==clocks.get(pageId)) throw new Error("Saved handwriting changed during export. Try again.");
      const ink=await encodedFromRecord(row);
      if (!ink) throw new Error(`Handwriting on page ${pageId} could not be read. Export stopped.`);
      return decodeInkOps(ink);
    },
  };
}

export async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array<ArrayBuffer>> {
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob ? resolve(blob) : reject(new Error("Could not encode annotation image")),"image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function rasterAnnotation(bounds: SceneBounds, ops: readonly InkOp[], scene: BoardBlob,
  snapshot?: Pick<ExportSnapshot,"hosts"|"zoom">, marks: readonly ExportMark[] = []): Promise<Uint8Array<ArrayBuffer>> {
  const w=bounds.maxX-bounds.minX,h=bounds.maxY-bounds.minY;
  if(!(w>0 && h>0 && Number.isFinite(w+h)))throw new Error("Invalid annotation bounds");
  const scale=Math.min(2,4096/Math.max(w,h),Math.sqrt(8_000_000/(w*h)));
  const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.ceil(w*scale));canvas.height=Math.max(1,Math.ceil(h*scale));
  const ctx=canvas.getContext("2d");if(!ctx)throw new Error("Could not create export canvas");
  const images:Record<string,CanvasImageSource>={};
  try {
    for (const [id,file] of Object.entries(scene.files ?? {})) {
      const image=new Image();image.src=file.dataURL;await image.decode();images[id]=image;
    }
    paintInkAtScale(ctx,ops,{x:bounds.minX,y:bounds.minY},scale,snapshot?.hosts,snapshot?.zoom);
    paintSceneToExport(ctx,scene.elements,{minX:bounds.minX,minY:bounds.minY,padding:0,exportScale:scale,files:scene.files,images});
    ctx.setTransform(scale,0,0,scale,-bounds.minX*scale,-bounds.minY*scale);
    for(const mark of marks) {
      ctx.fillStyle=mark.note.color ?? "#7651c5";
      ctx.globalAlpha=.18;
      for(const r of mark.rects)ctx.fillRect(r.minX,r.minY,r.maxX-r.minX,r.maxY-r.minY);
      ctx.globalAlpha=1;
      const r=mark.rects[0];if(!r)continue;
      ctx.font="bold 11px sans-serif";ctx.fillText(String(mark.number),Math.min(bounds.maxX-15,r.maxX+3),r.minY+11);
    }
    return await canvasPng(canvas);
  } finally { canvas.width=0;canvas.height=0; }
}

export function sceneBounds(elements: readonly unknown[]): SceneBounds | null {
  const rows=(elements as PaintSceneElement[]).filter(el=>isDrawableSceneElement(el) && Number.isFinite(el.x) && Number.isFinite(el.y));
  if(!rows.length)return null;
  const bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
  for(const el of rows) {
    const w=el.width??1,h=el.height??1,cx=el.x+w/2,cy=el.y+h/2;
    const cos=Math.cos(el.angle??0),sin=Math.sin(el.angle??0),pad=(el.strokeWidth??1)/2+4;
    const points=el.points?.length ? el.points:[[0,0],[w,0],[w,h],[0,h]];
    for(const [dx,dy] of points) {
      const x=cx+(dx-w/2)*cos-(dy-h/2)*sin,y=cy+(dx-w/2)*sin+(dy-h/2)*cos;
      bounds.minX=Math.min(bounds.minX,x-pad);bounds.maxX=Math.max(bounds.maxX,x+pad);
      bounds.minY=Math.min(bounds.minY,y-pad);bounds.maxY=Math.max(bounds.maxY,y+pad);
    }
  }
  return bounds;
}
