import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DialogBackdrop, DialogPresence } from "./DialogMotion";
import { DialogFrame } from "./DialogFrame";
import { HoldButton } from "./HoldButton";
import { HubLibraryRefresh, type HubLibraryRefreshAction } from "./HubLibraryRefresh";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import { exploreGraphFile, type ExploreGraphExport } from "../util/exploreGraphExport";
import { saveDocumentExport } from "../util/saveDocumentExport";

export function ExploreIcon() {
  return <svg className="lc-icon-svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
    <path d="m6 7 12 2M6 7l4 11m8-9-8 9" /><circle cx="6" cy="7" r="3" /><circle cx="18" cy="9" r="3" /><circle cx="10" cy="18" r="3" />
  </svg>;
}
export function ExploreHeaderMenu({ active, disabled, onOpen, onPull, getGraph }: {
  active: boolean; disabled: boolean; onOpen: () => void;
  onPull: HubLibraryRefreshAction; getGraph: () => Promise<ExploreGraphExport>;
}) {
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  const busy = useRef(false), bodyRef = useRef<HTMLDivElement>(null);
  const close = () => { if (!busy.current) setOpen(false); };
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); if (!busy.current) setOpen(false); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);
  const pull = async () => {
    busy.current = true; setPending(true); setError(""); setMessage("");
    try { return await onPull(); }
    finally { busy.current = false; setPending(false); }
  };
  const exportGraph = async () => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(""); setMessage("Preparing graph…");
    try {
      const file = exploreGraphFile(await getGraph());
      const result = await saveDocumentExport(file, new AbortController().signal, setMessage);
      setMessage(result ?? "Export cancelled.");
    } catch (cause) { setMessage(""); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busy.current = false; setPending(false); }
  };
  return <>
    <HoldButton label="Explore" ariaLabel="Explore: tap to open the graph, hold for menu"
      className={`lc-icon lc-hold-icon${active ? " is-active" : ""}`} pressed={active}
      disabled={disabled} onTap={onOpen} onConfirm={() => { setMessage(""); setError(""); setOpen(true); }}><ExploreIcon /></HoldButton>
    {createPortal(<DialogPresence>{open && <DialogBackdrop className="lc-settings-backdrop" role="presentation"
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <DialogFrame titleId="lc-explore-menu-title" title="Explore" subtitle="Your library and its links" icon={<ExploreIcon />}
        mode="explore" shape="blocky" className="lc-library-holds lc-library-menu" onClose={close} closeDisabled={pending} ariaLabel="Explore menu">
        <div className="lc-settings-body lc-dialog-body lc-scroll-pane" ref={bodyRef}>
          <HoldButton label="Export graph" holdMs={LIBRARY_HOLD_MS} className="lc-hold-choice" disabled={pending} onConfirm={() => void exportGraph()}>
            <span><strong>Export graph</strong><small>JSON · Nodes and links from your whole library</small></span>
          </HoldButton>
          {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
        </div>
        <footer className="lc-settings-foot lc-dialog-foot"><HubLibraryRefresh onRefresh={pull} disabled={pending} className="lc-library-footer-pull" resultsContainer={bodyRef} />
          <span className="lc-dialog-foot-spacer" aria-hidden="true" />
          <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={close}>Cancel</button></footer>
      </DialogFrame>
    </DialogBackdrop>}</DialogPresence>, document.body)}
  </>;
}
