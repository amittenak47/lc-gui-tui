import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFHexString, degrees } from "pdf-lib";
import { AnnotatedPdf, pdfDisplayTransform } from "./documentExportPdf";

describe("annotated PDF",()=>{
  it.each([0,90,180,270])("keeps crop and rotation %s and appends a Unicode comment",async(rotation)=>{
    const original=await PDFDocument.create();const page=original.addPage([400,600]);
    page.setCropBox(25,30,300,500);page.setRotation(degrees(rotation));page.drawText("Original selectable text");
    const previous=original.context.obj({Type:"Annot",Subtype:"Text",Rect:[30,30,40,40],Contents:PDFHexString.fromText("Earlier note")});
    page.node.set(PDFName.of("Annots"),original.context.obj([original.context.register(previous)]));
    const source=await original.save(),before=source.slice();
    const output=await AnnotatedPdf.open(source);
    output.note({page:1,number:1,text:"Proof: ∑ 中文",x:.4,y:.3});
    const reopened=await PDFDocument.load(await output.finish());const result=reopened.getPage(0);
    expect(source).toEqual(before);expect(reopened.getPageCount()).toBe(1);
    expect(result.getCropBox()).toEqual(page.getCropBox());expect(result.getRotation()).toEqual(page.getRotation());
    const notes=result.node.lookup(PDFName.of("Annots"),PDFArray);expect(notes.size()).toBe(2);
    const note=notes.lookup(1,PDFDict);expect(note.lookup(PDFName.of("Contents"),PDFHexString).decodeText()).toBe("Proof: ∑ 中文");
    const rect=note.lookup(PDFName.of("Rect"),PDFArray).asArray().map(v=>Number(v.toString()));
    expect(rect[0]).toBeGreaterThanOrEqual(25);expect(rect[1]).toBeGreaterThanOrEqual(30);
    expect(rect[2]).toBeLessThanOrEqual(325);expect(rect[3]).toBeLessThanOrEqual(530);
  });
  it.each([0,90,180,270])("maps displayed page corners into the crop box at %s degrees",rotation=>{
    const {matrix:m,width,height}=pdfDisplayTransform({x:25,y:30,width:300,height:500},rotation);
    const corners=[[0,0],[width,0],[0,height],[width,height]].map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);
    expect(corners.sort()).toEqual([[25,30],[25,530],[325,30],[325,530]].sort());
  });
});
