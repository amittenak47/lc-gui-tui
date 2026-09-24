import { isTauriRuntime, loadInvoke } from "../api/nativeHttp";

/** Bounded native IPC, including on Android; never expand a whole PDF to JSON. */
export async function saveDocumentExport(file: {name:string;blob:Blob}, signal:AbortSignal,
  progress:(text:string)=>void):Promise<string|null> {
  signal.throwIfAborted();
  const invoke=await loadInvoke();
  if(!invoke) {
    if(isTauriRuntime())throw new Error("The native file saver is unavailable. Update the app and try again.");
    const url=URL.createObjectURL(file.blob),a=document.createElement("a");
    a.href=url;a.download=file.name;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60_000);
    return `Downloaded ${file.name}`;
  }
  let id:string;
  try {id=await invoke<string>("begin_document_export",{filename:file.name,mime:file.blob.type});}
  catch(error) {throw new Error(`Could not start file save: ${String(error)}. If this app was already running when export was added, update its native app version.`);}
  try {
    for(let offset=0;offset<file.blob.size;offset+=262144) {
      signal.throwIfAborted();
      const bytes=new Uint8Array(await file.blob.slice(offset,offset+262144).arrayBuffer());
      await invoke("append_document_export",{id,offset,bytes:Array.from(bytes)});
      progress(`Saving file… ${Math.min(100,Math.round((offset+bytes.length)/file.blob.size*100))}%`);
    }
    signal.throwIfAborted();progress("Choose a save location if prompted…");
    const path=await invoke<string>("finish_document_export",{id,size:file.blob.size});
    return path ? (path.startsWith("content:") ? `Saved ${file.name} to your chosen location`:`Saved to ${path}`):null;
  }finally {await invoke("cancel_document_export",{id}).catch(()=>{});}
}
