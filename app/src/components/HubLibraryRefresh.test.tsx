/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {LIBRARY_HOLD_MS} from "../util/gesture";
import {HubLibraryRefresh} from "./HubLibraryRefresh";
it("presents a partial pull as counts and readable per-file failures",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const host=document.createElement("div"),root=createRoot(host);
  try {
    await act(async()=>root.render(<HubLibraryRefresh onRefresh={async()=>({added:["Notes.md"],repaired:["Book.pdf"],failures:[{name:"Missing.pdf",message:"Source not uploaded"}]})}/>));
    await pull(host);
    expect(host.querySelector('[aria-pressed="true"]')?.textContent).toContain("Unavailable1");
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(host.querySelector('[role="list"]')?.textContent).toContain("Source not uploaded");
    const filter = (label:string) => [...host.querySelectorAll('button')].find(b=>b.textContent?.startsWith(label))!;
    await act(async()=>filter("Added").click());
    expect(host.querySelector('[role="list"]')?.textContent).toBe("Notes.md");
    await act(async()=>filter("Repaired").click());
    expect(host.querySelector('[role="list"]')?.textContent).toBe("Book.pdf");
    expect(host.textContent).not.toContain("Dismiss");
  } finally {act(()=>root.unmount());vi.unstubAllGlobals();}
});
it("does not label a failed connection as up to date",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const host=document.createElement("div"),root=createRoot(host);
  try {
    await act(async()=>root.render(<HubLibraryRefresh onRefresh={async()=>{throw new Error("Hub unavailable");}}/>));
    await pull(host);
    expect(host.textContent).toContain("Pull failed");
    expect(host.textContent).toContain("Hub unavailable");
    expect(host.textContent).not.toContain("Library up to date");
  } finally {act(()=>root.unmount());vi.unstubAllGlobals();}
});

it("separates incomplete uploads from download failures",async()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const host=document.createElement("div"),root=createRoot(host);
  try {
    await act(async()=>root.render(<HubLibraryRefresh onRefresh={async()=>({added:[],repaired:[],failures:[
      {name:"Tablet notes",message:"The hub has this file's saved entry, but some handwriting is missing."},
      {name:"Broken.pdf",message:"Ink page 4 could not be read"},
    ]})}/>));
    await pull(host);
    expect(host.querySelector('[role="list"]')?.textContent).toContain("Broken.pdf");
    const tab=[...host.querySelectorAll('button')].find(b=>b.textContent?.startsWith("Not uploaded"))!;
    await act(async()=>tab.click());
    expect(host.querySelector('[role="list"]')?.textContent).toBe("Tablet notesInk not uploaded");
    expect(host.querySelector('[role="list"]')?.textContent).not.toContain("Broken.pdf");
  } finally {act(()=>root.unmount());vi.unstubAllGlobals();}
});

async function pull(host:HTMLElement) {
  const button=host.querySelector("button")!;
  await act(async()=>button.click());
  expect(host.querySelector('[role="status"]')).toBeNull();
  await act(async()=>{
    button.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,LIBRARY_HOLD_MS+60));
    button.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",bubbles:true}));
  });
}
