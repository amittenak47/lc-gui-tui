/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DocIndexChip } from "./DocIndexChip";
import { chromeLooksSame, NO_CHROME } from "../shellContext";
vi.mock("../util/padHubStatus",()=>({usePadHubStatus:()=>({status:"offline"})}));
afterEach(()=>vi.unstubAllGlobals());
it("shows the failure reason and active book progress even with cached offline status",()=>{
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);const element=document.createElement("div");document.body.append(element);const root=createRoot(element);
  const retry=vi.fn(),reason="Synced 2 books. 1 failed: Algorithms: page 113 can't be read from the hub.";
  act(()=>root.render(<DocIndexChip status="idle" meta={null} error={null} onSync={retry} walkStage="pad" walkError={reason}/>));
  const button=element.querySelector("button")!;expect(button.textContent).toBe("!Sync failed");expect(element.querySelector(".lc-doc-index-ring")).toBeNull();
  act(()=>button.click());expect(retry).toHaveBeenCalledOnce();expect(document.querySelector(".lc-doc-sync-line")?.textContent).toBe(reason);
  act(()=>root.render(<DocIndexChip status="idle" meta={null} error={null} onSync={retry} walkStage="pad" walkMessage="Syncing 3 of 12 books"/>));
  expect(document.querySelector(".lc-doc-sync-line")?.textContent).toBe("Syncing 3 of 12 books");
  act(()=>root.unmount());element.remove();
});
it("refreshes actual shell chrome when the shared book progress text changes",()=>{
  const first={...NO_CHROME,docIndex:{...NO_CHROME.docIndex,walkMessage:"Syncing 1 of 12 books"}};
  expect(chromeLooksSame(first,{...first,docIndex:{...first.docIndex,walkMessage:"Syncing 2 of 12 books"}})).toBe(false);
});
