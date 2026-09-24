import "./libraryMenu.css";

export function LibrarySearch({value,onChange,label,disabled=false}:{value:string;onChange:(value:string)=>void;label:string;disabled?:boolean}) {
  return <label className="lc-library-search">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg>
    <input type="search" aria-label={label} placeholder="Search saved items…" value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}/>
  </label>;
}
