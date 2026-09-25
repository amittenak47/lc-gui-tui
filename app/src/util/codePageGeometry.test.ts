import {describe,it,expect} from "vitest";
import {codePageGeometry} from "./codePageGeometry";
describe("authored code page",()=>{
 it("keeps the same editor width and ink line coordinates through window fits",()=>{
  const page=codePageGeometry(3920), lineScene=page.header+(32+8+31*5)*page.sceneScale;
  for(const viewport of [390,650,760,1600,1920]){
   const camera=viewport/3920, scale=camera*page.sceneScale;
   expect(page.width*camera/scale).toBeCloseTo(1184);
   expect((lineScene*camera-page.header*camera)/scale).toBeCloseTo(32+8+31*5);
  }
 });
});
