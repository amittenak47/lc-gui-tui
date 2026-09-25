import { HoldButton } from "./HoldButton";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import { useRef, useState } from "react";
import type { HubLibraryPullReport } from "../util/padSync";
import "../modes/artifacts.css";
import "./hubLibraryRefresh.css";

export type HubLibraryRefreshAction = () => Promise<number | HubLibraryPullReport>;
export function HubLibraryRefresh({ onRefresh }: { onRefresh: HubLibraryRefreshAction }) {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed,setFailed]=useState(false);
  const [report,setReport]=useState<HubLibraryPullReport|null>(null);
  const [filter,setFilter]=useState<"added"|"repaired"|"notUploaded"|"unavailable">("added");
  const refresh = async () => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setMessage("");
    setFailed(false);
    setReport(null);
    try {
      const result = await onRefresh();
      if(typeof result === "number")setMessage(result ? `Added ${result} files.` : "All hub files are already on this device.");
      else {setReport(result);setFilter(result.failures.some(row=>!isNotUploaded(row.message)) ? "unavailable" : result.failures.length ? "notUploaded" : result.added.length ? "added" : "repaired");}
    } catch (cause) {
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  const groups = {
    added: report?.added.map(name=>({name,message:""})) ?? [],
    repaired: report?.repaired.map(name=>({name,message:""})) ?? [],
    notUploaded: report?.failures.filter(row=>isNotUploaded(row.message)) ?? [],
    unavailable: report?.failures.filter(row=>!isNotUploaded(row.message)) ?? [],
  };
  return <div className="lc-library-refresh">
    <HoldButton label="Pull" holdMs={LIBRARY_HOLD_MS} className="lc-hub-pull-command" disabled={pending} onConfirm={() => void refresh()} resetKey={pending}>
      <strong>{pending ? "Pulling…" : "Pull"}</strong>
    </HoldButton>
    {(pending || report || message) && <section className="lc-hub-pull-catalog lc-artifact-picker-catalog" aria-label="Hub pull results">
      <div className="lc-hub-pull-title"><strong role="status">{pending ? "Pulling…" : failed ? "Pull failed" : "Pull results"}</strong>
      </div>
      {message && <span>{message}</span>}
      {report && <>
        <div className="lc-artifact-picker-sources" role="group" aria-label="Filter pull results">
          {(["added","repaired","notUploaded","unavailable"] as const).map(key=><button key={key} type="button" className={`lc-artifact-picker-source${filter===key ? " is-active":""}`} aria-pressed={filter===key} onClick={()=>setFilter(key)}>
            {key === "added" ? "Added" : key === "repaired" ? "Repaired" : key === "notUploaded" ? "Not uploaded" : "Unavailable"}<span className="lc-hub-pull-count">{groups[key].length}</span>
          </button>)}
        </div>
        <div className="lc-artifact-picker-list" role="list" aria-label={`${filter} files`}>
          {groups[filter].map((row,i)=><div className="lc-artifact-picker-row" role="listitem" key={i}>
            <div className="lc-hub-pull-file"><span className="lc-artifact-picker-row-title" title={row.name}>{row.name}</span>
              {row.message && <span className="lc-hub-pull-reason" title={row.message}>{pullFailureSummary(row.message)}</span>}
            </div>
          </div>)}
        </div>
        {filter === "notUploaded" && groups.notUploaded.length>0 && <p className="lc-artifact-picker-empty">Sync on the original device, then pull again.</p>}
        {groups[filter].length===0 && <p className="lc-artifact-picker-empty">{filter==="added" ? "No new files." : filter==="repaired" ? "No repairs needed." : filter==="notUploaded" ? "No incomplete uploads." : "No unavailable files."}</p>}
      </>}
    </section>}
  </div>;
}

function pullFailureSummary(message:string):string {
  if (/handwriting is missing|Ink not uploaded/.test(message)) return "Ink not uploaded";
  if (/source file.*not available on the hub/i.test(message)) return "Source file not uploaded";
  return message.replace(/^Error:\s*/, "");
}

function isNotUploaded(message:string):boolean {
  return /handwriting is missing|Ink not uploaded|source file.*not available on the hub/i.test(message);
}
