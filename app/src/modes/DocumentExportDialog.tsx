import { DialogFrame } from "../components/DialogFrame";
import { DialogBackdrop } from "../components/DialogMotion";
import { useEffect, useRef, useState } from "react";
import type { DocType } from "../util/annotateStore";
import type { DocumentExportOptions, ExportFile } from "../util/documentExport";
import { saveDocumentExport } from "../util/saveDocumentExport";

interface Props {
  name:string; docType:DocType;
  format?:"source"|"pdf";
  onExport:(options:DocumentExportOptions,progress:(text:string)=>void,signal:AbortSignal)=>Promise<ExportFile>;
  onClose:()=>void;
}
export function DocumentExportDialog({name,docType,format:requestedFormat="source",onExport,onClose}:Props) {
  const [options,setOptions]=useState<DocumentExportOptions>({ink:true,footnotes:true,threads:false,format:requestedFormat});
  const [phase,setPhase]=useState<"ready"|"exporting"|"saving"|"done">("ready");
  const [progress,setProgress]=useState("");
  const [error,setError]=useState("");
  const controller=useRef<AbortController|null>(null);
  const busy=phase==="exporting" || phase==="saving";
  useEffect(()=>()=>controller.current?.abort(),[]);
  const run=async()=>{
    if(controller.current)return;
    const task=new AbortController();controller.current=task;setError("");setPhase("exporting");setProgress("Preparing annotations…");
    try {
      const file=await onExport(options,setProgress,task.signal);
      task.signal.throwIfAborted();setPhase("saving");
      const result=await saveDocumentExport(file,task.signal,setProgress);
      setProgress(result ?? "Save cancelled. Your annotations are still in the app.");setPhase(result ? "done":"ready");
    }catch(reason){
      if(task.signal.aborted){setProgress("Export cancelled.");setPhase("ready");}
      else{setError(reason instanceof Error ? reason.message:String(reason));setPhase("ready");}
    }finally{controller.current=null;}
  };
  const format=docType==="pdf" || requestedFormat==="pdf" ? "PDF":docType==="epub" ? "EPUB":"Markdown + images (ZIP)";
  return <DialogBackdrop className="lc-settings-backdrop">
    <DialogFrame className="lc-attempt-modal lc-document-export" titleId="document-export-title" title="Export annotated document" subtitle="" description={name} mode="annotate" shape="blocky"
      icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></svg>}>
      <div className="lc-settings-body lc-dialog-body">
        <p><strong>{format}</strong></p>
        <p className="lc-muted">{docType==="pdf" ? "Original pages with ink and footnote markers. Full footnotes and sketches follow in an appendix.":requestedFormat==="pdf" ? "Images of the reading layout with ink and footnote markers, followed by full footnotes. Choose Markdown or EPUB for reflowable text.":"Readable text with handwriting images near the relevant passages and full footnotes at the end."}</p>
        <div className="lc-document-export-options">
          <label><input type="checkbox" checked={options.ink} disabled={busy} onChange={e=>setOptions({...options,ink:e.target.checked})}/> Ink and drawings</label>
          <label><input type="checkbox" checked={options.footnotes} disabled={busy} onChange={e=>setOptions({...options,footnotes:e.target.checked})}/> Footnotes and attached sketches</label>
          <label><input type="checkbox" checked={options.threads} disabled={busy || !options.footnotes} onChange={e=>setOptions({...options,threads:e.target.checked})}/> Include conversations linked to footnotes</label>
        </div>
        {progress && <p role="status" aria-live="polite">{progress}</p>}
        {error && <p className="lc-error" role="alert">{error}</p>}
      </div>
      <div className="lc-settings-foot lc-dialog-foot">
        <button type="button" className="lc-secondary lc-dialog-action" disabled={phase==="saving"} onClick={()=>busy ? controller.current?.abort():onClose()}>{busy ? "Cancel export":"Close"}</button>
        <button type="button" className="lc-dialog-action" disabled={busy} onClick={()=>void run()}>{phase==="done" ? "Export again":"Export"}</button>
      </div>
    </DialogFrame>
  </DialogBackdrop>;
}
