import { useRef, useState } from "react";

export function HubLibraryRefresh({ onRefresh }: { onRefresh: () => Promise<number> }) {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = async () => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setMessage("");
    try {
      const count = await onRefresh();
      setMessage(count ? `Added ${count} ${count === 1 ? "pad" : "pads"}.` : "No new pads on the hub.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return <div className="lc-library-refresh">
    <button type="button" className="lc-button" disabled={pending} onClick={() => void refresh()}>
      {pending ? "Refreshing…" : "Refresh from hub"}
    </button>
    <span className="lc-muted" role="status">{message}</span>
  </div>;
}
