import { HoldButton } from "../components/HoldButton";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import "./libraryMenu.css";

export function LibraryMenuRow({label,disabled,onConfirm,children}:{label:string;disabled?:boolean;onConfirm:()=>void;children?:string}) {
  return <HoldButton holdMs={LIBRARY_HOLD_MS} label={label} className="lc-hold-choice" disabled={disabled} onConfirm={onConfirm}><strong>{children ?? label}</strong></HoldButton>;
}

export function LibrarySearch({value,onChange,label,disabled=false,kinds=[],filters=[],onToggleFilter,showTrash=false,onTrashChange}:{
  value:string;onChange:(value:string)=>void;label:string;disabled?:boolean;
  kinds?:string[];filters?:readonly string[];onToggleFilter?:(kind:string)=>void;
  showTrash?:boolean;onTrashChange?:(value:boolean)=>void;
}) {
  return <div className="lc-library-search">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg>
    <input type="search" aria-label={label} placeholder="Search" value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}/>
    <div className="lc-library-search-filters" role="group" aria-label="Filter saved items">
      {kinds.map(kind=>{
        const name = kind === "markdown" ? "MD" : kind.toUpperCase();
        const on = filters.includes(kind);
        return <button key={kind} type="button" disabled={disabled} title={kind === "markdown" ? "Markdown" : name} aria-label={`Filter ${kind}`} aria-pressed={on} onClick={()=>onToggleFilter?.(kind)}>{name}</button>;
      })}
      {onTrashChange && <button type="button" disabled={disabled} title="Trash" aria-label="Trash" aria-pressed={showTrash} onClick={()=>onTrashChange(!showTrash)}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14M10 10v7M14 10v7"/></svg>
      </button>}
    </div>
  </div>;
}
