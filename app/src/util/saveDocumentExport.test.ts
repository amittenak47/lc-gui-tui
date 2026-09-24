import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveDocumentExport } from "./saveDocumentExport";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("../api/nativeHttp",()=>({isTauriRuntime:()=>true,loadInvoke:async()=>invoke}));
beforeEach(()=>invoke.mockReset());
describe("native document export",()=>{
  it("sends bounded ordered chunks and cleans staging after save",async()=>{
    invoke.mockImplementation(async(cmd:string)=>cmd==="begin_document_export" ? "stage" : cmd==="finish_document_export" ? "content://saved":undefined);
    const blob=new Blob([new Uint8Array(600000)],{type:"application/pdf"});
    expect(await saveDocumentExport({name:"book.pdf",blob},new AbortController().signal,()=>{})).toContain("chosen location");
    const chunks=invoke.mock.calls.filter(([cmd])=>cmd==="append_document_export").map(([,args])=>args);
    expect(chunks.map(c=>[c.offset,c.bytes.length])).toEqual([[0,262144],[262144,262144],[524288,75712]]);
    expect(invoke).toHaveBeenLastCalledWith("cancel_document_export",{id:"stage"});
  });
  it("cleans a cancelled transfer without finalizing",async()=>{
    const controller=new AbortController();
    invoke.mockImplementation(async(cmd:string)=>{if(cmd==="append_document_export")controller.abort();return "stage";});
    await expect(saveDocumentExport({name:"book.pdf",blob:new Blob([new Uint8Array(400000)])},controller.signal,()=>{})).rejects.toMatchObject({name:"AbortError"});
    expect(invoke.mock.calls.some(([cmd])=>cmd==="finish_document_export")).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("cancel_document_export",{id:"stage"});
  });
  it("treats Android picker cancellation as unsaved",async()=>{
    invoke.mockImplementation(async(cmd:string)=>cmd==="begin_document_export" ? "stage":"");
    expect(await saveDocumentExport({name:"book.pdf",blob:new Blob(["pdf"])},new AbortController().signal,()=>{})).toBeNull();
  });
});
