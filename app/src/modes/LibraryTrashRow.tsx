import {useState} from "react";
import {HoldButton} from "../components/HoldButton";
import {LibraryPadlock} from "./LibraryPadlock";
import {LIBRARY_HOLD_MS} from "../util/gesture";

/** A local safety latch, followed by the same hold-to-trash control as live rows. */
export function LibraryTrashRow({name,updatedAt,disabled,onRestore,onDelete}:{name:string;updatedAt:number;disabled?:boolean;onRestore:()=>Promise<void>;onDelete:()=>Promise<void>}) {
 const [locked,setLocked]=useState(true),[pending,setPending]=useState(false),[error,setError]=useState("");
 const run=async(action:()=>Promise<void>)=>{setPending(true);setError("");try{await action();}catch(cause){setError(String(cause));}finally{setPending(false);}};
 return <div>
  <div className="lc-scratch-load-entry">
   <HoldButton holdMs={LIBRARY_HOLD_MS} label={`Restore ${name}`} className="lc-scratch-load-hold" disabled={disabled||pending} onConfirm={()=>void run(onRestore)}>
    <strong title={name}>Restore {"\u00b7"} {name}</strong><span className="lc-muted">{new Date(updatedAt).toLocaleString()}</span>
   </HoldButton>
   <LibraryPadlock name={name} locked={locked} disabled={disabled||pending} onToggle={()=>setLocked(value=>!value)}/>
   {!locked && <HoldButton label={`Permanently delete ${name}`} ariaLabel={`Permanently delete ${name}`} dataTip="Permanently delete" holdMs={LIBRARY_HOLD_MS} className="lc-scratch-load-trash lc-hold-danger" disabled={disabled||pending} onConfirm={()=>void run(onDelete)}>
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14M10 10v7M14 10v7"/></svg>
   </HoldButton>}
  </div>
  {error && <p role="alert" className="lc-warning">{error}</p>}
 </div>;
}
