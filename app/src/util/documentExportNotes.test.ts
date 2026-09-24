import { describe,expect,it,vi } from "vitest";
import { noteText,noteAttachments } from "./documentExportNotes";
import type { ExportMark } from "./documentExportSnapshot";
import type { AgentChatMessage } from "../modes/AgentSidePanel";
vi.mock("./footnoteWhiteboardStore",()=>({getFootnoteWhiteboard:async()=>null}));
vi.mock("./artifactRepository",()=>({readArtifact:async()=>{throw new Error("Attachment unavailable");}}));
const mark:ExportMark={number:1,scope:"",rects:[],note:{id:"n",kind:"coach",createdAt:1,anchor:{kind:"text",start:0,end:5},excerpt:"Proof",threadRootId:"q"}};
const messages:AgentChatMessage[]=[
  {id:"q",role:"user",content:"Linked question",at:1,sessionId:"same"},
  {id:"a",role:"assistant",content:"Linked answer",at:2,replyTo:{id:"q",role:"user",excerpt:"Linked question"},sessionId:"same"},
  {id:"unrelated",role:"user",content:"Unrelated question",at:3,sessionId:"same"},
];
describe("exported footnotes",()=>{
  it("includes only linked conversations, and only when selected",()=>{
    expect(noteText(mark,{messages},false)).not.toContain("Linked question");
    const text=noteText(mark,{messages},true);
    expect(text).toContain("Linked question");expect(text).toContain("Linked answer");expect(text).not.toContain("Unrelated question");
  });
  it("fails if a referenced legacy sketch cannot be read",async()=>{
    const note={...mark,note:{...mark.note,whiteboards:[{id:"missing",createdAt:1,updatedAt:1}]}};
    await expect(noteAttachments("doc",note,new AbortController().signal)).rejects.toThrow("unavailable");
  });
  it("fails if a linked attachment cannot be read",async()=>{
    const note:ExportMark={...mark,note:{...mark.note,artifacts:[{parent:{kind:"annotate",id:"doc"},artifactId:"missing",kind:"whiteboard"}]}};
    await expect(noteAttachments("doc",note,new AbortController().signal)).rejects.toThrow("Attachment unavailable");
  });
});
