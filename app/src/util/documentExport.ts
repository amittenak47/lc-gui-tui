import { zip, unzip, strToU8, strFromU8, type AsyncZippable } from "fflate";
import { inkOpsBounds, isHostBoundOp, type InkOp, type SceneBounds } from "../canvas/rasterInk";
import { opfPathFrom } from "./epub";
import { rangeFromAnchor } from "./docAnchors";
import { canvasPng, rasterAnnotation, sceneBounds, type ExportSnapshot } from "./documentExportSnapshot";
import { noteText, noteAttachments } from "./documentExportNotes";

export interface DocumentExportOptions { ink:boolean; footnotes:boolean; threads:boolean; format?:"source"|"pdf" }
export interface ExportFile { name:string; blob:Blob }
type Progress=(message:string)=>void;
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const baseName=(name:string)=>name.replace(/\.[^.]+$/,"").replace(/[\\/:*?"<>|]/g,"_") || "Document";
const intersects=(a:SceneBounds|null,b:SceneBounds)=>a && a.minX<b.maxX && a.maxX>b.minX && a.minY<b.maxY && a.maxY>b.minY;
const htmlEscape=(text:string)=>text.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));

export async function exportAnnotatedDocument(snapshot:ExportSnapshot,docId:string,options:DocumentExportOptions,progress:Progress,signal:AbortSignal):Promise<ExportFile> {
  signal.throwIfAborted();
  return snapshot.source.docType==="pdf" || options.format==="pdf" ? exportPdf(snapshot,docId,options,progress,signal)
    : exportReflow(snapshot,docId,options,progress,signal);
}

async function exportPdf(s:ExportSnapshot,docId:string,o:DocumentExportOptions,progress:Progress,signal:AbortSignal):Promise<ExportFile> {
  const originalPdf=s.source.docType==="pdf";
  if(originalPdf && !s.source.bytes)throw new Error("The PDF source is unavailable");
  if(!s.scopes.length || (originalPdf && s.scopes.some(scope=>!scope.page)))throw new Error("Wait for the document layout to finish loading before exporting.");
  const pages=[...new Set(s.scopes.map(scope=>scope.page!))].sort((a,b)=>a-b);
  if(originalPdf && o.ink && s.pageIds.some(id=>id>0 && !pages.includes(id)))throw new Error("Some handwriting pages have no matching PDF page. Export stopped to avoid omitting them.");
  const worker=new Worker(new URL("./documentExport.worker.ts",import.meta.url),{type:"module"});
  let seq=0;
  const pending=new Map<number,{resolve:(bytes?:Uint8Array<ArrayBuffer>)=>void;reject:(error:Error)=>void}>();
  const fail=(error:Error)=>{for(const task of pending.values())task.reject(error);pending.clear();};
  worker.onmessage=({data})=>{const task=pending.get(data.id);pending.delete(data.id);if(data.error)task?.reject(new Error(data.error));else task?.resolve(data.bytes);};
  worker.onerror=event=>fail(new Error(event.message || "PDF export worker failed"));
  const abort=()=>{worker.terminate();fail(new DOMException("Export cancelled","AbortError"));};signal.addEventListener("abort",abort,{once:true});
  const send=(op:string,extra:Record<string,unknown>={},bytes?:Uint8Array<ArrayBuffer>)=>new Promise<Uint8Array<ArrayBuffer>|undefined>((resolve,reject)=>{
    signal.throwIfAborted();const id=++seq;pending.set(id,{resolve,reject});worker.postMessage({id,op,...extra,bytes},bytes ? [bytes.buffer]:[]);
  });
  try {
    progress("Preparing PDF…");
    if(originalPdf) await send("open",{pages},new Uint8Array(s.source.bytes!.slice(0)));
    else {
      await send("create");
      await exportRenderedPages(s,o,progress,signal,png=>send("appendix",{},png).then(()=>{}));
    }
    const shared=originalPdf && o.ink && s.pageIds.includes(0) ? await s.readInk(0):[];
    const legacy=originalPdf && o.ink && !s.pageIds.some(id=>id>1) && s.pageIds.includes(1) ? await s.readInk(1):null;
    const shapes=o.ink ? sceneBounds(s.board.elements):null;
    for(let i=0;originalPdf && i<s.scopes.length;i++) {
      signal.throwIfAborted();const scope=s.scopes[i];if(!scope.page)continue;
      progress(`Exporting page ${scope.page}…`);
      const ops:InkOp[]=o.ink ? [...shared,...(legacy ?? (s.pageIds.includes(scope.page) ? await s.readInk(scope.page):[]))]:[];
      const marks=o.footnotes ? s.marks.filter(mark=>mark.scope===scope.id):[];
      const placement={page:scope.page,right:scope.right,spread:scope.spread};
      if(intersects(inkOpsBounds(ops),scope.bounds) || intersects(shapes,scope.bounds) || marks.some(mark=>mark.rects.length)) {
        const png=await rasterAnnotation(scope.bounds,ops,o.ink?s.board:{...s.board,elements:[],files:{}},s,marks);
        await send("overlay",{placement},png);
      }
      await tick();
    }
    if(o.footnotes && s.marks.length) {
      const appendix=new NotesCanvas(async png=>{signal.throwIfAborted();await send("appendix",{},png);});
      try {
        await appendix.text("Footnotes",true);
        for(const mark of s.marks) {
          signal.throwIfAborted();progress(`Exporting footnote ${mark.number} of ${s.marks.length}…`);
          const attachments=await noteAttachments(docId,mark,signal,o.threads);
          const text=[noteText(mark,s,o.threads),...attachments.text].join("\n\n");
          const scope=s.scopes.find(scope=>scope.id===mark.scope);
          if(originalPdf && scope?.page) {
            const r=mark.rects[0];
            await send("note",{note:{page:scope.page,right:scope.right,spread:scope.spread,number:mark.number,text,
              x:r ? Math.max(0,Math.min(.97,(r.maxX-scope.bounds.minX)/(scope.bounds.maxX-scope.bounds.minX))):.97,
              y:r ? Math.max(0,Math.min(.97,(r.minY-scope.bounds.minY)/(scope.bounds.maxY-scope.bounds.minY))):.02+((mark.number-1)%20)*.025}});
          }
          await appendix.text(text);
          for(const image of attachments.images) {await appendix.text(image.name);await appendix.image(image.bytes);}
        }
        await appendix.finish();
      }finally {appendix.dispose();}
    }
    progress("Finishing PDF…");const bytes=await send("finish");if(!bytes)throw new Error("The PDF export returned no file");
    return {name:`${baseName(s.source.name)}.annotated.pdf`,blob:new Blob([bytes],{type:"application/pdf"})};
  }finally{signal.removeEventListener("abort",abort);worker.terminate();}
}

/** Paginate the frozen reading layout, keeping canvas memory bounded to one sheet. */
async function exportRenderedPages(s:ExportSnapshot,o:DocumentExportOptions,progress:Progress,signal:AbortSignal,write:(png:Uint8Array<ArrayBuffer>)=>Promise<void>) {
  if(!s.renderContent)throw new Error("The document preview is unavailable. Reopen the document before exporting.");
  let number=0;
  for(const scope of s.scopes) {
    const width=scope.bounds.maxX-scope.bounds.minX,scale=1080/width,height=1440/scale;
    for(let top=scope.bounds.minY;top<scope.bounds.maxY;top+=height) {
      signal.throwIfAborted();progress(`Exporting page ${++number}…`);
      const bounds={...scope.bounds,minY:top,maxY:Math.min(top+height,scope.bounds.maxY)};
      const canvas=document.createElement("canvas");canvas.width=1224;canvas.height=1584;
      const ctx=canvas.getContext("2d");if(!ctx)throw new Error("Could not create PDF page canvas");
      try {
        ctx.fillStyle="white";ctx.fillRect(0,0,1224,1584);ctx.translate(72,72);
        await s.renderContent(ctx,bounds,scale);
        const layer=async(ops:InkOp[],scene:ExportSnapshot["board"],marks:ExportSnapshot["marks"])=>{
          const bytes=await rasterAnnotation(bounds,ops,scene,s,marks);
          const image=await createImageBitmap(new Blob([bytes],{type:"image/png"}));
          try{ctx.drawImage(image,0,0,width*scale,(bounds.maxY-bounds.minY)*scale);}finally{image.close();}
        };
        const empty={...s.board,elements:[],files:{}};
        // Read one shard at a time; never assemble a large document's ink blob.
        if(o.ink)for(const id of s.pageIds) {
          signal.throwIfAborted();const ops=await s.readInk(id);
          if(intersects(inkOpsBounds(ops),bounds))await layer(ops,empty,[]);
        }
        if(o.ink || o.footnotes)await layer([],o.ink?s.board:empty,o.footnotes?s.marks.filter(mark=>mark.scope===scope.id):[]);
        await write(await canvasPng(canvas));
      }finally{canvas.width=0;canvas.height=0;}
      await tick();
    }
  }
}

/** Page-sized canvas only; footnote text also lives in Unicode PDF comments. */
class NotesCanvas {
  private canvas=document.createElement("canvas");private ctx:CanvasRenderingContext2D;private y=70;private used=false;
  constructor(private write:(png:Uint8Array<ArrayBuffer>)=>Promise<void>){this.canvas.width=1224;this.canvas.height=1584;const ctx=this.canvas.getContext("2d");if(!ctx)throw new Error("Could not create footnote export canvas");this.ctx=ctx;this.clear();}
  private clear(){this.ctx.fillStyle="white";this.ctx.fillRect(0,0,1224,1584);this.ctx.fillStyle="#222";this.y=70;this.used=false;}
  private async room(height:number){if(this.y+height>1510){await this.finish();this.clear();}}
  async text(text:string,title=false){
    this.ctx.font=title ? "bold 32px sans-serif":"22px sans-serif";
    for(const paragraph of text.split("\n")) {
      let line="";
      for(const char of paragraph) {
        if(this.ctx.measureText(line+char).width>1084){await this.room(32);this.ctx.fillText(line,70,this.y);this.y+=32;this.used=true;line="";}
        line+=char;
      }
      await this.room(32);this.ctx.fillText(line,70,this.y);this.y+=32;this.used=true;
    }
    this.y+=20;
  }
  async image(bytes:Uint8Array<ArrayBuffer>){
    const url=URL.createObjectURL(new Blob([bytes],{type:"image/png"}));
    try{const image=new Image();image.src=url;await image.decode();const scale=Math.min(1084/image.width,1360/image.height,1);const height=image.height*scale;
      await this.room(height+20);this.ctx.drawImage(image,70,this.y,image.width*scale,height);this.y+=height+20;this.used=true;
    }finally{URL.revokeObjectURL(url);}
  }
  async finish(){if(this.used){await this.write(await canvasPng(this.canvas));this.used=false;}}
  dispose(){this.canvas.width=0;this.canvas.height=0;}
}

interface InkImage {name:string;bytes:Uint8Array<ArrayBuffer>;scope:string;quote:string}
async function* reflowInk(s:ExportSnapshot,signal:AbortSignal):AsyncGenerator<InkImage> {
  let number=0;
  const ids=s.pageIds.length?s.pageIds:[-1];
  for(const id of ids) {
    const raw=id<0?[]:await s.readInk(id);
    const ops=raw.filter(op=>!isHostBoundOp(op));
    // Include hidden code-box ink too. A separate image per scroller removes
    // its viewport clipping and aligns strokes from different scroll positions.
    const groups=new Map<number,InkOp[]>();
    for(const op of raw)if(isHostBoundOp(op)) {
      const group=groups.get(op.hostKey!)??[];group.push(op);groups.set(op.hostKey!,group);
    }
    for(const group of groups.values()) {
      const original=inkOpsBounds(group);if(!original)continue;
      const scope=s.scopes.find(scope=>intersects(original,scope.bounds))??s.scopes[0];
      if(!scope)throw new Error("The handwriting's document layout is unavailable");
      const expanded=group.map(op=>({...op,hostKey:undefined,points:op.points.map(p=>({...p,x:p.x+(op.scrollLeftAtDraw??0),y:p.y+(op.scrollTopAtDraw??0)}))}));
      const box=inkOpsBounds(expanded);if(!box)continue;
      const block=scope.blocks.reduce<(typeof scope.blocks)[number]|undefined>((best,row)=>Math.abs(row.y-original.minY)<Math.abs((best?.y??Infinity)-original.minY)?row:best,undefined);
      for(let y=box.minY-8;y<box.maxY+8;y+=900) {
        signal.throwIfAborted();
        yield {name:`ink-${++number}.png`,bytes:await rasterAnnotation({...box,minX:box.minX-8,maxX:box.maxX+8,minY:y,maxY:Math.min(y+900,box.maxY+8)},expanded,{...s.board,elements:[],files:{}}),scope:scope.id,quote:block?.text??""};
        await tick();
      }
    }
    const scene=id===ids[0]?s.board:{...s.board,elements:[],files:{}};
    const a=inkOpsBounds(ops),b=sceneBounds(scene.elements);
    const box=a&&b ? {minX:Math.min(a.minX,b.minX),minY:Math.min(a.minY,b.minY),maxX:Math.max(a.maxX,b.maxX),maxY:Math.max(a.maxY,b.maxY)}:a??b;
    if(!box)continue;
    for(const scope of s.scopes) {
      if(!intersects(box,scope.bounds))continue;
      const start=Math.max(box.minY-8,scope.bounds.minY),end=Math.min(box.maxY+8,scope.bounds.maxY);
      for(let y=start;y<end;y+=900) {
        signal.throwIfAborted();
        const bounds={minX:Math.max(box.minX-8,scope.bounds.minX),maxX:Math.min(box.maxX+8,scope.bounds.maxX),minY:y,maxY:Math.min(y+900,end)};
        const block=scope.blocks.reduce<(typeof scope.blocks)[number]|undefined>((best,row)=>Math.abs(row.y-y)<Math.abs((best?.y??Infinity)-y)?row:best,undefined);
        yield {name:`ink-${++number}.png`,bytes:await rasterAnnotation(bounds,ops,scene,s),scope:scope.id,quote:block?.text??""};await tick();
      }
    }
  }
}

function insertAfterQuote(source:string,quote:string,addition:string):string {
  const exact=quote.trim();const at=exact?source.indexOf(exact):-1;
  // Never attach a mark to an arbitrary occurrence of repeated words.
  if(at<0 || source.indexOf(exact,at+exact.length)>=0)return `${source}\n\n${addition}`;
  const next=source.indexOf("\n\n",at+exact.length);const end=next<0?source.length:next;
  return source.slice(0,end)+`\n\n${addition}\n\n`+source.slice(end);
}

async function exportReflow(s:ExportSnapshot,docId:string,o:DocumentExportOptions,progress:Progress,signal:AbortSignal):Promise<ExportFile> {
  const epub=s.source.docType==="epub";
  if(epub && !s.source.bytes)throw new Error("The EPUB source is unavailable");
  const files:Record<string,Uint8Array>=epub?await unzipExport(new Uint8Array(s.source.bytes!),signal):{};
  const assets=`lc-annotations-${crypto.randomUUID().slice(0,8)}`;
  const chapters=new Map<string,Document>();
  let markdown=s.source.text;
  const additions:Array<{path:string;type:string}>=[];
  const chapter=(scope:string)=>{
    if(chapters.has(scope))return chapters.get(scope)!;
    if(!files[scope])throw new Error(`EPUB chapter “${scope}” could not be found`);
    const doc=new DOMParser().parseFromString(strFromU8(files[scope]),"application/xhtml+xml");
    if(doc.querySelector("parsererror"))throw new Error(`EPUB chapter “${scope}” is unreadable`);
    chapters.set(scope,doc);return doc;
  };
  const addHtml=(doc:Document,html:string)=>{
    const wrapper=doc.createElementNS("http://www.w3.org/1999/xhtml","section");
    const fragment=new DOMParser().parseFromString(`<div xmlns="http://www.w3.org/1999/xhtml">${html}</div>`,"application/xhtml+xml");
    if(fragment.querySelector("parsererror"))throw new Error("Could not create exported footnote");
    for(const child of [...fragment.documentElement.childNodes])wrapper.append(doc.importNode(child,true));
    return wrapper;
  };
  const relative=(from:string,to:string)=>"../".repeat(from.split("/").length-1)+to;
  const saveImage=(name:string,bytes:Uint8Array)=>{const path=`${assets}/${name}`;files[path]=bytes;additions.push({path,type:"image/png"});return path;};
  // Capture ranges before adding images, captions or other notes to the text stream.
  const noteRanges=new Map<number,Range|null>();
  if(epub && o.footnotes)for(const mark of s.marks) {
    const body=chapter(mark.scope || s.scopes[0]?.id).querySelector("body");
    if(!body)throw new Error("EPUB chapter has no body");
    noteRanges.set(mark.number,mark.note.anchor.kind==="text" ? rangeFromAnchor(body,mark.note.anchor):null);
  }
  if(o.ink)for await(const ink of reflowInk(s,signal)) {
    progress("Adding handwriting images…");const path=saveImage(ink.name,ink.bytes);
    if(epub) {
      const doc=chapter(ink.scope);const body=doc.querySelector("body")!;
      const figure=addHtml(doc,`<figure><img src="${relative(ink.scope,path)}" alt="Handwriting" style="max-width:100%;height:auto"/><figcaption>Handwriting${ink.quote ? ` near: ${htmlEscape(ink.quote.slice(0,180))}`:""}</figcaption></figure>`);
      const match=[...body.querySelectorAll("p,li,pre,h1,h2,h3,blockquote")].find(el=>el.textContent?.trim()===ink.quote);
      (match?.closest("ul,ol,table")??match)?.after(figure);if(!figure.parentNode)body.append(figure);
    } else markdown=insertAfterQuote(markdown,ink.quote,`![Handwriting](${path})`);
  }
  const defs:string[]=[];
  if(o.footnotes)for(const mark of s.marks) {
    signal.throwIfAborted();progress(`Exporting footnote ${mark.number} of ${s.marks.length}…`);
    const attachments=await noteAttachments(docId,mark,signal,o.threads);
    const text=[noteText(mark,s,o.threads),...attachments.text].join("\n\n"),images=attachments.images;
    const paths=images.map((image,i)=>({name:image.name,path:saveImage(`footnote-${mark.number}-${i+1}.png`,image.bytes)}));
    if(epub) {
      const scope=mark.scope || s.scopes[0]?.id;const doc=chapter(scope);const body=doc.querySelector("body")!;
      const id=`${assets}-footnote-${mark.number}`;
      const range=noteRanges.get(mark.number);
      const ref=doc.createElementNS("http://www.w3.org/1999/xhtml","a");ref.setAttribute("href",`#${id}`);ref.textContent=`[${mark.number}]`;
      if(range){range.collapse(false);range.insertNode(ref);}else body.append(ref);
      body.append(addHtml(doc,`<aside id="${id}"><h2>Footnote ${mark.number}</h2>${text.split("\n\n").map(p=>`<p>${htmlEscape(p).replace(/\n/g,"<br/>")}</p>`).join("")}${paths.map(image=>`<figure><img src="${relative(scope,image.path)}" alt="${htmlEscape(image.name)}" style="max-width:100%;height:auto"/><figcaption>${htmlEscape(image.name)}</figcaption></figure>`).join("")}</aside>`));
    } else {
      const id=`lc-note-${mark.number}`;
      markdown=insertAfterQuote(markdown,mark.note.anchor.kind==="text" ? mark.note.anchor.exact??mark.note.excerpt:mark.note.excerpt,`[^${id}]`);
      defs.push(`[^${id}]: ${text.replace(/\n/g,"\n    ")}\n${paths.map(image=>`    ![${image.name.replace(/[\[\]]/g,"")}](${image.path})`).join("\n")}`);
    }
    await tick();
  }
  progress("Packaging exported document…");signal.throwIfAborted();
  if(epub) {
    for(const [path,doc] of chapters)files[path]=strToU8(new XMLSerializer().serializeToString(doc));
    const opf=opfPathFrom(strFromU8(files["META-INF/container.xml"]));
    const pkg=new DOMParser().parseFromString(strFromU8(files[opf]),"application/xml");
    const manifest=pkg.querySelector("manifest");if(!manifest)throw new Error("EPUB manifest is missing");
    for(const [i,asset]of additions.entries()) {const item=pkg.createElementNS(manifest.namespaceURI,"item");item.setAttribute("id",`${assets}-${i}`);item.setAttribute("href",relative(opf,asset.path));item.setAttribute("media-type",asset.type);manifest.append(item);}
    files[opf]=strToU8(new XMLSerializer().serializeToString(pkg));
    const {mimetype,...rest}=files;
    // EPUB requires mimetype first and uncompressed.
    const bytes=await zipExport({mimetype:[mimetype??strToU8("application/epub+zip"),{level:0}],...rest},signal);
    return {name:`${baseName(s.source.name)}.annotated.epub`,blob:new Blob([bytes],{type:"application/epub+zip"})};
  }
  files[`${baseName(s.source.name)}.md`]=strToU8(`${markdown}\n\n${defs.join("\n\n")}\n`);
  return {name:`${baseName(s.source.name)}.annotated.zip`,blob:new Blob([await zipExport(files,signal)],{type:"application/zip"})};
}

function zipExport(files:AsyncZippable,signal:AbortSignal):Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const cancel=zip(files,{level:6},(error,bytes)=>{signal.removeEventListener("abort",abort);error?reject(error):resolve(bytes as Uint8Array<ArrayBuffer>);});
    const abort=()=>{cancel();reject(new DOMException("Export cancelled","AbortError"));};
    signal.addEventListener("abort",abort,{once:true});
  });
}
function unzipExport(bytes:Uint8Array,signal:AbortSignal):Promise<Record<string,Uint8Array>> {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const cancel=unzip(bytes,(error,files)=>{signal.removeEventListener("abort",abort);error?reject(error):resolve(files);});
    const abort=()=>{cancel();reject(new DOMException("Export cancelled","AbortError"));};
    signal.addEventListener("abort",abort,{once:true});
  });
}
