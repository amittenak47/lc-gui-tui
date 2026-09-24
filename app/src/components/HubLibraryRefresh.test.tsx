/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {HubLibraryRefresh} from "./HubLibraryRefresh";
it("presents a partial pull as counts and readable per-file failures",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const host=document.createElement("div"),root=createRoot(host);
  try {
    await act(async()=>root.render(<HubLibraryRefresh onRefresh={async()=>({added:["Notes.md"],repaired:["Book.pdf"],failures:[{name:"Missing.pdf",message:"Source not uploaded"}]})}/>));
    await act(async()=>host.querySelector("button")!.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain("1 added");
    expect(host.querySelectorAll('li')).toHaveLength(3);
    expect(host.querySelector('details[open]')?.textContent).toContain("Source not uploaded");
  } finally {act(()=>root.unmount());vi.unstubAllGlobals();}
});
it("does not label a failed connection as up to date",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const host=document.createElement("div"),root=createRoot(host);
  try {
    await act(async()=>root.render(<HubLibraryRefresh onRefresh={async()=>{throw new Error("Hub unavailable");}}/>));
    await act(async()=>host.querySelector("button")!.click());
    expect(host.textContent).toContain("Could not pull files");
    expect(host.textContent).toContain("Hub unavailable");
    expect(host.textContent).not.toContain("Library up to date");
  } finally {act(()=>root.unmount());vi.unstubAllGlobals();}
});
