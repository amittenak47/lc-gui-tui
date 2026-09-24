import { AnnotatedPdf, type PdfPlacement } from "./documentExportPdf";
let pdf:AnnotatedPdf | undefined;
self.onmessage=async ({data}:{data:{id:number;op:string;bytes?:Uint8Array;pages?:number[];placement?:PdfPlacement;note?:Parameters<AnnotatedPdf["note"]>[0]}}) => {
  try {
    if(data.op==="open") {
      pdf=await AnnotatedPdf.open(data.bytes!);
      if(data.pages && (data.pages.length!==pdf.pageCount() || data.pages.some((page,index)=>page!==index+1))) {
        throw new Error("The PDF layout is incomplete. Wait for the document to finish opening before exporting.");
      }
    }
    else if(data.op==="create")pdf=await AnnotatedPdf.create();
    else if(!pdf)throw new Error("PDF export was not initialized");
    else if(data.op==="overlay")await pdf.overlay({...data.placement!,png:data.bytes!});
    else if(data.op==="note")pdf.note(data.note!);
    else if(data.op==="appendix")await pdf.appendix(data.bytes!);
    else if(data.op==="finish") {
      const bytes=await pdf.finish();self.postMessage({id:data.id,bytes}, {transfer:[bytes.buffer]});pdf=undefined;return;
    }
    self.postMessage({id:data.id});
  }catch(error){self.postMessage({id:data.id,error:error instanceof Error ? error.message:String(error)});}
};
