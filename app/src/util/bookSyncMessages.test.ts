import { expect, it } from "vitest";
import { LcApiError } from "../api/client";
import { BookSyncError, type BookErrorKind, type BookResult } from "./bookSync";
import { bookFailureMessage, bookConflictMessage, bookNoticeMessage, bookPassSummary, bookDisplay } from "./bookSyncMessages";

const display = {title:"Algorithms",scratchTitles:{first:"Sketch",second:"Proof"}};
const failure = (kind:BookErrorKind):BookResult => ({kind:"annotate",id:"internal-id",status:"failed",committed:false,display,
  error:new BookSyncError(kind,"Technical detail",[{key:"internal-id",pageId:113}])});
it.each([
  ["unreachable","Can't reach the hub. Is the desktop app open?"],
  ["stage","Algorithms: pages 113 didn't upload (no response)."],
  ["unconfirmed","Algorithms: the hub didn't confirm this sync. Sync again."],
  ["hub_changed","Algorithms changed on the hub. Sync again."],
  ["local_changed","Algorithms changed on this device during sync. Sync again."],
  ["needs_choice","Algorithms: needs your choice. Open it and sync again."],
  ["merge_mount","Algorithms: couldn't open the merge window."],
  ["local_page","Algorithms: page 113 can't be read on this device."],
  ["hub_page","Algorithms: page 113 can't be read from the hub."],
  ["missing_staging","Algorithms: page 113 couldn't be staged."],
  ["dependency","Algorithms: the source file or attachment didn't upload."],
  ["gone","Algorithms was deleted on another device. Your local copy is kept."],
  ["storage","Algorithms: local storage isn't ready for safe sync. Your changes are kept on this device."],
] as const)("names the concrete %s failure",(kind,message)=>expect(bookFailureMessage(failure(kind))).toBe(message));
it("names distinct scratch boards and summarizes long page lists without discarding identities",()=>{
  const book=failure("stage");book.error=new BookSyncError("stage","detail",[{key:"internal-id/fn/first",pageId:1},{key:"internal-id/fn/second",pageId:1},
    ...[15,44,45,52].map(pageId=>({key:"internal-id",pageId}))]);
  expect(bookFailureMessage(book)).toBe("Algorithms: pages Sketch page 1, Proof page 1, 15 and 3 more didn't upload (no response).");
  expect(book.error.pages).toHaveLength(6);
  expect(bookConflictMessage(book,{key:"internal-id/fn/second",pageId:1},display)).toBe("Algorithms: Proof page 1 changed here and on the hub.");
  book.error=new BookSyncError("hub_page","detail",[{key:"internal-id",pageId:0}]);expect(bookFailureMessage(book)).not.toContain("page 0");
});
it("distinguishes missing Library Pull pages, actual cap limits and backup notices",()=>{
  const book=failure("hub_page");book.error!.missing=true;
  expect(bookFailureMessage(book,true)).toBe("Algorithms: page 113 isn't on the hub yet. Sync the other device.");
  book.error=new BookSyncError("cap","detail",[],new LcApiError("live library is full (50)",403));expect(bookFailureMessage(book)).toBe("The hub library is full (50).");
  expect(bookNoticeMessage({kind:"backup",title:"Algorithms"})).toBe("Algorithms: snapshots didn't sync. They are kept on this device.");
  expect(bookNoticeMessage({kind:"old_hub"})).toBe("Update the desktop app to sync safely.");expect(bookNoticeMessage({kind:"links"})).toBe("Links didn't sync.");
});
it("counts the entire pass and never substitutes internal IDs for titles",()=>{
  const book=failure("stage");expect(bookPassSummary({modern:true,cancelled:false,notices:[],books:[{...book,status:"synced",error:undefined},book,{...book,status:"needs_choice"}]}))
    .toBe("Synced 1 books. 2 failed: Algorithms: pages 113 didn't upload (no response).");
  expect(bookDisplay({kind:"problem",id:"dataset/internal-id"},null,{id:"dataset/internal-id",task_id:"internal-id"}).title).toBe("Problem board");
});
