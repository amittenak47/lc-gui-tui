import { beforeEach, expect, it, vi } from "vitest";
import type { BoardHandle, BoardBlob } from "../canvas/BoardHandle";
import { encodeInkOps, inkOpsFrom } from "../canvas/inkCodec";
import { captureWhiteboardBackup, importWhiteboardBackup, readWhiteboardBackup } from "./whiteboardTransfer";
const mock=vi.hoisted(()=>({records:[] as unknown[],save:vi.fn(async value=>value)}));
vi.mock("./inkPageStore",()=>({whiteboardDocKey:(id:string)=>`wb:${id}`,getInkPageRecords:async()=>mock.records,encodedFromRecord:async(row:any)=>row.inkC}));
vi.mock("./whiteboardStore",()=>({WHITEBOARD_PAGE_LIMIT:10,getWhiteboardNotebook:async()=>({title:"Original"}),saveWhiteboardNotebook:(value:any)=>mock.save(value)}));
vi.mock("./artifactSnapshot",()=>({captureArtifactSnapshot:async()=>undefined,parseArtifactSnapshotBundle:()=>undefined,stageArtifactSnapshot:async()=>undefined}));
const ink=encodeInkOps([{kind:"erase",radius:4,points:[{x:12,y:20,pressure:1},{x:18,y:30,pressure:1}]}]);
const empty=encodeInkOps([]);
const scene:BoardBlob={v:1,elements:[],appState:{scrollX:0,scrollY:0,zoom:1},inkPages:{v:1,pageIds:[1,2]}};
function board(dirty=false) {return {saveBoard:()=>scene,snapshotInkPages:()=>new Map([[1,ink],[2,empty]]),takeDirtyInkPages:()=>dirty ? new Map([[2,empty]]) : new Map()} as unknown as BoardHandle;}
beforeEach(()=>{mock.records=[{pageId:2,inkC:ink}];mock.save.mockClear();});
it("includes cold handwriting even when the viewport has an empty placeholder",async()=>{
 const backup=await captureWhiteboardBackup(board(),"original","Notes",2,[{id:"m1",deletedAt:123,custom:{preserve:true}}]);
 expect(inkOpsFrom(backup.board)).toHaveLength(2);
 const saved=await importWhiteboardBackup(JSON.stringify(backup));
 expect(saved.id).not.toBe("original");expect(saved.agent).toEqual(backup.agent);
 expect(inkOpsFrom(saved.board)).toHaveLength(2);expect(saved.board.inkPages).toBeUndefined();
});
it("preserves a live erasure rather than resurrecting the saved page",async()=>{
 const backup=await captureWhiteboardBackup(board(true),"original","Notes",2,[]);
 expect(inkOpsFrom(backup.board)).toHaveLength(1);
});
it("refuses an incomplete source instead of exporting missing notes",async()=>{
 mock.records=[];
 await expect(captureWhiteboardBackup(board(),"original","Notes",2,[])).rejects.toThrow("page 2 is missing");
 expect(mock.save).not.toHaveBeenCalled();
});
it("rejects truncated ink before publishing a new whiteboard",async()=>{
 const backup=await captureWhiteboardBackup(board(),"original","Notes",2,[]);
 const raw=JSON.parse(JSON.stringify(backup));raw.board.inkC.ops[0].n=999;
 expect(()=>readWhiteboardBackup(JSON.stringify(raw))).toThrow("damaged handwriting");
 await expect(importWhiteboardBackup(JSON.stringify(raw))).rejects.toThrow();expect(mock.save).not.toHaveBeenCalled();
});
