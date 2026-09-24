import { useRef, useState } from "react";
import type { HubLibraryPullReport } from "../util/padSync";

export type HubLibraryRefreshAction = () => Promise<number | HubLibraryPullReport>;
export function HubLibraryRefresh({ onRefresh }: { onRefresh: HubLibraryRefreshAction }) {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [report,setReport]=useState<HubLibraryPullReport|null>(null);
  const refresh = async () => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setMessage("");
    setReport(null);
    try {
      const result = await onRefresh();
      if(typeof result === "number")setMessage(result ? `Added ${result} files.` : "All hub files are already on this device.");
      else setReport(result);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return <div className="lc-library-refresh">
    <button type="button" className="lc-button" disabled={pending} onClick={() => void refresh()}>
      {pending ? "Pulling files…" : "Pull missing files from hub"}
    </button>
    {(pending || report || message) && <section className="lc-hub-pull-status" aria-live="polite" role="status">
      <strong>{pending ? "Downloading your library" : report?.failures.length ? "Some files need attention" : "Library up to date"}</strong>
      {pending && <span>Files, handwriting and attached notes are being downloaded.</span>}
      {message && <span>{message}</span>}
      {report && <>
        <div className="lc-hub-pull-counts"><span>{report.added.length} added</span><span>{report.repaired.length} repaired</span>{report.failures.length>0 && <span>{report.failures.length} unavailable</span>}</div>
        {(report.added.length+report.repaired.length>0) && <details><summary>Downloaded files</summary><ul>{[...report.added,...report.repaired].map((name,i)=><li key={i}>{name}</li>)}</ul></details>}
        {report.failures.length>0 && <details open><summary>Could not download</summary><ul>{report.failures.map((failure,i)=><li key={i}><strong>{failure.name}</strong><span>{failure.message}</span></li>)}</ul></details>}
        {!report.added.length && !report.repaired.length && !report.failures.length && <span>All hub files are already on this device.</span>}
      </>}
    </section>}
  </div>;
}
