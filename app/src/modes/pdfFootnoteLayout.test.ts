import { expect, it } from "vitest";
import type { DocFootnote } from "../util/docFootnotes";
import { remapPdfFootnotes } from "./pdfFootnoteLayout";

const whole = [{pageId:9,minY:1800,maxY:1900},{pageId:10,minY:1918,maxY:2018}];
const split = [{pageId:9,minY:3600,maxY:3800},{pageId:9,minY:3818,maxY:4018},
  {pageId:10,minY:4036,maxY:4236},{pageId:10,minY:4254,maxY:4454}];
it("moves right-half footnotes and sub-highlights with their PDF sheet, then restores them", () => {
  const note: DocFootnote = {id:"note",kind:"note",createdAt:1,excerpt:"Here",
    anchor:{kind:"region",scope:"p10",x:140,y:30,w:30,h:10},
    bands:[{left:140,top:1948,width:30,height:10}],
    threads:[{rootId:"keep-thread",title:"Keep",createdAt:1}],
    subMarks:[{id:"sub",kind:"highlight",excerpt:"Here",start:0,end:4,
      anchor:{kind:"text",scope:"p10",start:5,end:9},bands:[{left:150,top:1950,width:15,height:5}]}],
  };
  const [mapped] = remapPdfFootnotes([note],whole,split,200);
  expect(mapped.anchor).toEqual({kind:"region",scope:"p10r",x:80,y:60,w:60,h:20});
  expect(mapped.bands).toEqual([{left:80,top:4314,width:60,height:20}]);
  expect(mapped.subMarks?.[0].anchor?.scope).toBe("p10r");
  const [back] = remapPdfFootnotes([mapped],split,whole,200);
  expect(back).toEqual(note);
  expect(mapped.threads).toBe(note.threads);
});
it("keeps text offsets, timestamps and unknown fields while moving the highlight bands", () => {
  const note = {id:"text",kind:"note" as const,createdAt:5,updatedAt:8,excerpt:"quote",
    anchor:{kind:"text" as const,scope:"p9",start:2,end:7},bands:[{left:10,top:1820,width:40,height:10}],future:{a:1}};
  const [mapped] = remapPdfFootnotes([note],whole,split,200);
  expect(mapped).toMatchObject({createdAt:5,updatedAt:8,future:{a:1},anchor:note.anchor,
    bands:[{left:20,top:3640,width:80,height:20}]});
  expect(remapPdfFootnotes([mapped],split,whole,200)[0]).toEqual(note);
});
