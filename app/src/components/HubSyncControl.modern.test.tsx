/** @vitest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LcClient, BookStateDto } from "../api/client";
import { HubSyncControl, type HubSyncWalkHost, type HubWalkReport } from "./HubSyncControl";
import { DocIndexChip } from "./DocIndexChip";
import { saveWhiteboardNotebook } from "../util/whiteboardStore";
import { captureBook } from "../util/bookSnapshot";
import { closeDbForTests } from "../util/idb";
import { resetLocalBookStoreForTests } from "../util/localBookStore";
import { resetBookCoordinatorForTests } from "../util/bookCoordinator";
import { savePadHub, setHostLoopback } from "../util/padHub";
import { refreshPadHubStatus } from "../util/padHubStatus";
import { recordHash } from "../util/syncContent";
import { HubSyncCancelled } from "../util/hubConflictStash";

vi.mock("../util/padSnapshotStore", async original => ({ ...await original<typeof import("../util/padSnapshotStore")>(), listAllPadSnapshots: async()=>[] }));
vi.mock("../util/inkSync", async original => ({ ...await original<typeof import("../util/inkSync")>(), syncEdges: async()=>{} }));
let root:Root|null=null, api:LcClient, remote:BookStateDto, host:HubSyncWalkHost;
let element:HTMLDivElement, reports:Array<HubWalkReport|null>;
const board={v:1 as const,elements:[],appState:{scrollX:0,scrollY:0,zoom:1}};
beforeEach(async()=>{
  await closeDbForTests();resetLocalBookStoreForTests();resetBookCoordinatorForTests();localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("IDBKeyRange",IDBKeyRange);
  vi.stubGlobal("navigator",{locks:{request:(_key:string,arg:unknown,callback?:()=>Promise<unknown>)=>(typeof arg==="function"?arg as ()=>Promise<unknown>:callback!)()}});
  setHostLoopback(null);savePadHub({url:"http://isolated.test",token:"test"});
  await saveWhiteboardNotebook({id:"book",title:"Algorithms",pageCount:1,board});
  const record={id:"book",title:"Hub rename",page_count:1,board,agent:[],updated_at:1,sync_seq:0};
  remote={kind:"whiteboard",id:"book",state:"live",book_rev:3,record_rev:3,record_hash:await recordHash(record),record,pages:[],gone_seq:null};
  api={pingPadSync:vi.fn(async()=>({features:["atomic_book_sync_v1"],books:[remote],now:1,edges:[],gone_edges:[]})),
    getBookState:vi.fn(async()=>structuredClone(remote)),checkBookHead:vi.fn(async()=>({unchanged:true,book_rev:remote.book_rev})),
    commitPad:vi.fn(async()=>{throw new Error("Server choice needs no upload");}),putInkPage:vi.fn(async()=>{throw new Error("Live PUT is forbidden");})} as unknown as LcClient;
  reports=[];
  host={book:async()=>({kind:"whiteboard",id:"book"}),doc:()=>null,pad:async()=>{throw new Error("Modern sync cannot enter legacy pad apply");},prepare:vi.fn(async()=>{}),
    emitReload:vi.fn(async()=>{}),inkSince:()=>0,onConflict:vi.fn(()=>new Promise<never>(()=>{})),onIndexProgress:vi.fn(),onWalkProgress:()=>{},onIndexError:vi.fn(),onIndexDone:vi.fn()};
  element=document.createElement("div");document.body.append(element);root=createRoot(element);
});
afterEach(async()=>{if(root)act(()=>root!.unmount());root=null;element?.remove();await closeDbForTests();resetLocalBookStoreForTests();resetBookCoordinatorForTests();
  savePadHub(null);refreshPadHubStatus();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
function mount(){
  const tap={current:null as null|(()=>void)};
  function Surface(){const[report,setReport]=useState<HubWalkReport|null>(null);host.onWalkProgress=value=>{reports.push(value);setReport(value);};return <>
    <HubSyncControl client={api} host={host} report={report} tapRef={tap}/>
    <DocIndexChip status="idle" meta={null} error={null} onSync={()=>tap.current?.()} walkStage={report?.stage} walkError={report?.error} walkWaiting={report?.waiting} walkMessage={report?.message}/>
  </>;}
  act(()=>root!.render(<Surface/>));
}
const dock=()=>element.querySelector(".lc-hub-sync") as HTMLButtonElement;
const header=()=>element.querySelector(".lc-doc-index-sync") as HTMLButtonElement;
async function waitForChoice(){await vi.waitFor(()=>expect(host.onConflict).toHaveBeenCalledOnce());}
it("missing merge mount ends both controls at 3000ms; a single header tap starts a fresh successful sync",async()=>{
  localStorage.setItem("whiteboard.offlineMerge.v1","prefer-local");
  mount();const before=await captureBook({kind:"whiteboard",id:"book"});
  await act(async()=>dock().click());await waitForChoice();
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,3100));});
  const reason="Synced 0 books. 1 failed: Algorithms: couldn't open the merge window.";
  expect(dock().getAttribute("aria-label")).toBe("Sync failed");expect(dock().getAttribute("aria-busy")).toBe("false");expect(dock().title).toBe(reason);
  expect(header().textContent).toBe("!Sync failed");expect(header().title).toBe(reason);
  expect(await captureBook({kind:"whiteboard",id:"book"})).toEqual(before);
  vi.mocked(host.onConflict).mockImplementation(async(_conflict,lifecycle)=>{lifecycle!.onMounted();return {pick:"server"};});
  await act(async()=>header().click());await vi.waitFor(()=>expect(dock().dataset.stage).toBe("synced"));
  expect(api.pingPadSync).toHaveBeenCalledTimes(2);expect((await captureBook({kind:"whiteboard",id:"book"})).record?.title).toBe("Hub rename");
  expect(api.putInkPage).not.toHaveBeenCalled();expect(api.commitPad).not.toHaveBeenCalled();expect(reports.some(report=>report?.message==="Syncing 1 of 1 books")).toBe(true);
});
it("Cancel settles the busy state and preserves local content without reporting Synced",async()=>{
  vi.mocked(host.onConflict).mockImplementation(async(_conflict,lifecycle)=>{lifecycle!.onMounted();throw new HubSyncCancelled();});
  mount();const before=await captureBook({kind:"whiteboard",id:"book"});await act(async()=>dock().click());
  await vi.waitFor(()=>expect(dock().dataset.stage).toBe("idle"));expect(dock().getAttribute("aria-busy")).toBe("false");
  expect(await captureBook({kind:"whiteboard",id:"book"})).toEqual(before);expect(reports.some(report=>report?.stage==="synced")).toBe(false);
});
it("a never-answering inventory stops at the request deadline and one tap can retry",async()=>{
  const before=await captureBook({kind:"whiteboard",id:"book"});vi.useFakeTimers();vi.mocked(api.pingPadSync).mockImplementationOnce(()=>new Promise(()=>{}));mount();
  await act(async()=>dock().click());expect(api.pingPadSync).toHaveBeenCalledOnce();
  await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(dock().getAttribute("aria-busy")).toBe("false");expect(header().title).toBe("Can't reach the hub. Is the desktop app open?");
  vi.useRealTimers();expect(await captureBook({kind:"whiteboard",id:"book"})).toEqual(before);
  vi.mocked(host.onConflict).mockImplementation(async(_conflict,lifecycle)=>{lifecycle!.onMounted();return {pick:"server"};});
  await act(async()=>dock().click());await vi.waitFor(()=>expect(dock().dataset.stage).toBe("synced"));expect(api.pingPadSync).toHaveBeenCalledTimes(2);
});
it("unmount aborts a mounted human wait and permits a new coordinated sync",async()=>{
  vi.mocked(host.onConflict).mockImplementation((_conflict,lifecycle)=>{lifecycle!.onMounted();return new Promise(()=>{});});
  mount();await act(async()=>dock().click());await waitForChoice();act(()=>root!.unmount());root=createRoot(element);
  vi.mocked(host.onConflict).mockImplementation(async(_conflict,lifecycle)=>{lifecycle!.onMounted();return {pick:"server"};});
  mount();await act(async()=>dock().click());await vi.waitFor(()=>expect(dock().dataset.stage).toBe("synced"));expect(api.pingPadSync).toHaveBeenCalledTimes(2);
});
